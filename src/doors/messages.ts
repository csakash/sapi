/**
 * Anthropic Messages entry point (`POST /v1/messages`, plan §8). Translates the request into the
 * internal format and the internal events back into Anthropic's JSON and named-SSE shapes.
 *
 * Like the chat door, this phase is text only: tools, MCP servers, containers and non-text blocks
 * are refused with a 400. Sampling parameters (including `max_tokens`, which the SDK always
 * sends) can't be honoured by the provider, so they're dropped and listed in
 * `x-sapi-ignored-params`, or refused when `strict_params` is on. Error messages are fixed
 * strings; caller text never appears in them except a name passed through `safeName`.
 */
import { z } from "zod";
import type { CanonicalEvent, CanonicalMessage, ErrorKind, FinishReason, Usage } from "../canonical.ts";
import { GatewayError } from "../canonical.ts";
import { invalidRequest, safeName, sseEvent, unhandledParams, unsupported } from "./common.ts";
import type { Door, DoorMeta, ParsedRequest, StreamWriter } from "./types.ts";

const Block = z.looseObject({ type: z.string() });
const Content = z.union([z.string(), z.array(Block)]);

const Message = z.looseObject({
  role: z.enum(["user", "assistant"]),
  content: Content,
});

/** System blocks are text only; extra keys such as `cache_control` are accepted and ignored. */
const SystemBlock = z.looseObject({ type: z.literal("text"), text: z.string() });

const MessagesRequest = z.looseObject({
  model: z.string().min(1).max(200),
  messages: z.array(Message).min(1).max(2000),
  system: z.union([z.string(), z.array(SystemBlock)]).optional(),
  stream: z.boolean().optional(),
  // Always sent by the SDK; validated here, then listed as ignored (it isn't in HANDLED).
  max_tokens: z.number().optional(),
  tools: z.array(z.unknown()).nullish(),
  mcp_servers: z.unknown().optional(),
  container: z.unknown().optional(),
});

const HANDLED = new Set(["model", "messages", "system", "stream", "tools", "mcp_servers", "container"]);

const TOOL_BLOCKS = new Set(["tool_use", "tool_result", "server_tool_use", "web_search_tool_result"]);

const set = (v: unknown) => v !== undefined && v !== null;

function textOf(content: z.infer<typeof Content>, where: string): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const b of content) {
    if (TOOL_BLOCKS.has(b.type)) {
      throw new GatewayError("bad_request", "Tool messages aren't supported by sapi yet (planned).", { param: where });
    }
    if (b.type !== "text") {
      throw new GatewayError(
        "bad_request",
        `Only text content is supported by this provider (${where} has a "${safeName(b.type)}" part).`,
        { param: "messages" },
      );
    }
    if (typeof b.text !== "string") {
      throw new GatewayError("bad_request", `Invalid request: ${where}: a text block needs a text string.`, {
        param: "messages",
      });
    }
    parts.push(b.text);
  }
  return parts.join("\n");
}

export function parseMessagesRequest(body: unknown, strictParams: boolean): ParsedRequest {
  const r = MessagesRequest.safeParse(body);
  if (!r.success) throw invalidRequest(r.error);
  const req = r.data;
  if (req.tools && req.tools.length > 0) throw unsupported("Tool calling", "tools");
  if (set(req.mcp_servers) && !(Array.isArray(req.mcp_servers) && req.mcp_servers.length === 0)) {
    throw new GatewayError("bad_request", "MCP servers (mcp_servers) aren't supported by sapi.", {
      param: "mcp_servers",
    });
  }
  if (set(req.container)) {
    throw new GatewayError("bad_request", "Code execution containers (container) aren't supported by sapi.", {
      param: "container",
    });
  }

  // max_tokens is required by the Messages API, so every client sends it. It is listed as ignored
  // but never refused, or strict_params would turn every Anthropic SDK call into a 400.
  const unknownOrIgnored = unhandledParams(body, HANDLED, false);
  const refused = unknownOrIgnored.filter((k) => k !== "max_tokens");
  if (strictParams && refused.length > 0)
    unhandledParams(Object.fromEntries(refused.map((k) => [k, true])), HANDLED, true);

  const messages: CanonicalMessage[] = req.messages.map((m, i) => ({
    role: m.role,
    text: textOf(m.content, `messages[${i}]`),
  }));
  if (!messages.some((m) => m.role === "user"))
    throw new GatewayError("bad_request", "At least one user message is required.", { param: "messages" });
  if (messages[messages.length - 1]!.role !== "user") {
    throw new GatewayError("bad_request", "The last message must be from the user.", { param: "messages" });
  }
  const out: ParsedRequest = {
    alias: req.model,
    messages,
    stream: req.stream === true,
    ignoredParams: unknownOrIgnored,
  };
  if (typeof req.system === "string") out.system = req.system;
  else if (req.system) out.system = req.system.map((b) => b.text).join("\n\n");
  return out;
}

export type MessagesMeta = { id: string; model: string };

export function messagesMeta(m: DoorMeta): MessagesMeta {
  const tail = m.requestId.startsWith("req_") ? m.requestId.slice(4) : m.requestId;
  return { id: `msg_${tail}`, model: m.model };
}

const STOP_REASON: Record<FinishReason, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };

function usageJson(u: Usage | undefined) {
  return {
    input_tokens: u?.input ?? 0,
    output_tokens: u?.output ?? 0,
    cache_creation_input_tokens: u?.cacheWrite ?? 0,
    cache_read_input_tokens: u?.cacheRead ?? 0,
  };
}

export function messageJson(meta: MessagesMeta, text: string, finish: FinishReason, usage: Usage | undefined) {
  return {
    id: meta.id,
    type: "message",
    role: "assistant",
    model: meta.model,
    content: [{ type: "text", text }],
    stop_reason: STOP_REASON[finish],
    stop_sequence: null,
    usage: usageJson(usage),
  };
}

/** Turns internal events into Anthropic's named SSE events for one streamed message. */
export class MessagesStreamWriter implements StreamWriter {
  private started = false;
  private opened = false;
  private finished = false;
  private usage: Usage | undefined;

  constructor(private readonly meta: MessagesMeta) {}

  frames(ev: CanonicalEvent): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (this.finished) return out;
    // A start that never came is sent before the first block: the SDK needs message_start first.
    if (!this.started && (ev.type === "start" || ev.type === "text" || ev.type === "done")) {
      this.started = true;
      out.push(
        sseEvent("message_start", {
          type: "message_start",
          message: {
            id: this.meta.id,
            type: "message",
            role: "assistant",
            model: this.meta.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }
    if (!this.opened && (ev.type === "text" || ev.type === "done")) {
      this.opened = true;
      out.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
    }
    if (ev.type === "text") {
      out.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: ev.delta },
        }),
      );
    }
    if (ev.type === "usage") this.usage = ev.usage;
    if (ev.type === "done") {
      this.finished = true;
      out.push(
        sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: STOP_REASON[ev.finish], stop_sequence: null },
          usage: usageJson(this.usage),
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      );
    }
    return out;
  }

  error(e: GatewayError): Uint8Array[] {
    this.finished = true;
    return [sseEvent("error", anthropicError(e))];
  }
}

const ANTHROPIC_TYPE: Partial<Record<ErrorKind, string>> = {
  unauthorized: "authentication_error",
  forbidden: "permission_error",
  bad_request: "invalid_request_error",
  method_not_allowed: "invalid_request_error",
  unsupported_media_type: "invalid_request_error",
  not_found: "not_found_error",
  payload_too_large: "request_too_large",
  rate_limited: "rate_limit_error",
  client_budget_exceeded: "rate_limit_error",
  provider_window_exhausted: "rate_limit_error",
  timeout: "timeout_error",
};

/** Anthropic-shaped error body with sapi's own kind added. */
export function anthropicError(e: GatewayError) {
  return {
    type: "error",
    error: { type: ANTHROPIC_TYPE[e.kind] ?? "api_error", message: e.message, sapi_error_kind: e.kind },
  };
}

export const messagesDoor: Door = {
  name: "messages",
  parse: parseMessagesRequest,
  complete: (meta, text, finish, usage) => messageJson(messagesMeta(meta), text, finish, usage),
  stream: (meta) => new MessagesStreamWriter(messagesMeta(meta)),
  errorBody: anthropicError,
};
