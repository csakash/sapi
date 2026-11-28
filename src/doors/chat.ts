/**
 * OpenAI Chat Completions entry point (plan §8). Translates the request into the internal format
 * and the internal events back into OpenAI's JSON or SSE shapes.
 *
 * Phase 1 supports text chat. Tools, JSON-schema output and images are refused with a clear 400
 * until the phases that add them (imitated tools and schema validation land in Phase 5).
 * Parameters the provider can't honour are dropped and listed in `x-sapi-ignored-params`, or
 * refused when `strict_params` is on.
 */
import { z } from "zod";
import type { CanonicalEvent, CanonicalMessage, ErrorKind, FinishReason, Usage } from "../canonical.ts";
import { GatewayError } from "../canonical.ts";
import { invalidRequest, SSE_DONE, safeName, sse, unhandledParams } from "./common.ts";
import type { Door, DoorMeta, ParsedRequest, StreamWriter } from "./types.ts";

const TextPart = z.looseObject({ type: z.literal("text"), text: z.string() });
const Content = z.union([z.string(), z.array(z.looseObject({ type: z.string() })), z.null()]);

const Message = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool", "function"]),
  content: Content.optional(),
  name: z.string().max(64).optional(),
  tool_calls: z.array(z.unknown()).optional(),
  function_call: z.unknown().optional(),
});

const ChatRequest = z.looseObject({
  model: z.string().min(1).max(200),
  messages: z.array(Message).min(1).max(2000),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
  n: z.number().int().nullish(),
  tools: z.array(z.unknown()).nullish(),
  tool_choice: z.unknown().optional(),
  functions: z.array(z.unknown()).nullish(),
  response_format: z.looseObject({ type: z.string() }).nullish(),
  modalities: z.array(z.string()).nullish(),
  audio: z.unknown().optional(),
  web_search_options: z.unknown().optional(),
});

/** Accepted, but the Claude CLI can't honour them: listed back to the caller. */
const IGNORABLE = new Set([
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "user",
  "metadata",
  "store",
  "service_tier",
  "parallel_tool_calls",
  "reasoning_effort",
  "prediction",
  "verbosity",
  "safety_identifier",
  "prompt_cache_key",
]);
const HANDLED = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "n",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "modalities",
]);

export type ParsedChat = ParsedRequest & { includeUsage: boolean };

function textOf(content: z.infer<typeof Content> | undefined, where: string): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const p of content) {
    const t = TextPart.safeParse(p);
    if (!t.success) {
      throw new GatewayError(
        "bad_request",
        `Only text content is supported by this provider (${where} has a "${safeName(p.type)}" part).`,
        {
          param: "messages",
        },
      );
    }
    parts.push(t.data.text);
  }
  return parts.join("\n");
}

export function parseChatRequest(body: unknown, strictParams: boolean): ParsedChat {
  const r = ChatRequest.safeParse(body);
  if (!r.success) throw invalidRequest(r.error);
  const req = r.data;
  if (req.n !== undefined && req.n !== null && req.n !== 1)
    throw new GatewayError("bad_request", "Only n = 1 is supported.", { param: "n" });
  if ((req.tools && req.tools.length > 0) || (req.functions && req.functions.length > 0)) {
    throw new GatewayError("bad_request", "Tool calling isn't supported by sapi yet (planned).", { param: "tools" });
  }
  if (req.response_format && req.response_format.type !== "text") {
    throw new GatewayError(
      "bad_request",
      "Structured output (response_format) isn't supported by sapi yet (planned).",
      {
        param: "response_format",
      },
    );
  }
  if (req.modalities?.some((m) => m !== "text") || req.audio !== undefined) {
    throw new GatewayError("bad_request", "Only text output is supported.", { param: "modalities" });
  }
  if (req.web_search_options !== undefined) {
    throw new GatewayError("bad_request", "Hosted web search isn't supported.", { param: "web_search_options" });
  }

  const unknownOrIgnored = unhandledParams(body, HANDLED, strictParams);

  const systemParts: string[] = [];
  const messages: CanonicalMessage[] = [];
  req.messages.forEach((m, i) => {
    const where = `messages[${i}]`;
    if (m.role === "tool" || m.role === "function" || (m.tool_calls && m.tool_calls.length > 0) || m.function_call) {
      throw new GatewayError("bad_request", "Tool messages aren't supported by sapi yet (planned).", { param: where });
    }
    const text = textOf(m.content, where);
    if (m.role === "system" || m.role === "developer") systemParts.push(text);
    else messages.push({ role: m.role, text });
  });
  if (messages.length === 0)
    throw new GatewayError("bad_request", "At least one user message is required.", { param: "messages" });
  if (messages[messages.length - 1]!.role !== "user") {
    throw new GatewayError("bad_request", "The last message must be from the user.", { param: "messages" });
  }
  const out: ParsedChat = {
    alias: req.model,
    messages,
    stream: req.stream === true,
    includeUsage: req.stream_options?.include_usage === true,
    ignoredParams: unknownOrIgnored,
  };
  if (systemParts.length) out.system = systemParts.join("\n\n");
  return out;
}

/** Is this a parameter we knowingly drop (vs. one we've never heard of)? Used for docs and tests. */
export function isIgnorable(name: string): boolean {
  return IGNORABLE.has(name);
}

export type ChatMeta = { id: string; created: number; model: string };

const chatMeta = (m: DoorMeta): ChatMeta => ({
  id: `chatcmpl-${m.requestId.slice(4)}`,
  created: m.created,
  model: m.model,
});

function usageJson(u: Usage | undefined) {
  if (!u) return undefined;
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output,
    total_tokens: prompt + u.output,
    prompt_tokens_details: { cached_tokens: u.cacheRead },
    completion_tokens_details: { reasoning_tokens: u.reasoning },
  };
}

export function completionJson(meta: ChatMeta, text: string, finish: FinishReason, usage: Usage | undefined) {
  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      { index: 0, message: { role: "assistant", content: text, refusal: null }, logprobs: null, finish_reason: finish },
    ],
    usage: usageJson(usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    system_fingerprint: null,
  };
}

function chunk(meta: ChatMeta, delta: Record<string, unknown>, finish: FinishReason | null) {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    system_fingerprint: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  };
}

/** Turns internal events into SSE frames for one streamed completion. */
export class ChatStreamWriter implements StreamWriter {
  private started = false;
  private usage: Usage | undefined;

  constructor(
    private readonly meta: ChatMeta,
    private readonly includeUsage: boolean,
  ) {}

  setModel(model: string): void {
    this.meta.model = model;
  }

  frames(ev: CanonicalEvent): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (!this.started && (ev.type === "text" || ev.type === "done")) {
      this.started = true;
      out.push(sse(chunk(this.meta, { role: "assistant", content: "" }, null)));
    }
    if (ev.type === "text") out.push(sse(chunk(this.meta, { content: ev.delta }, null)));
    if (ev.type === "usage") this.usage = ev.usage;
    if (ev.type === "done") {
      out.push(sse(chunk(this.meta, {}, ev.finish)));
      if (this.includeUsage) {
        out.push(
          sse({
            id: this.meta.id,
            object: "chat.completion.chunk",
            created: this.meta.created,
            model: this.meta.model,
            system_fingerprint: null,
            choices: [],
            usage: usageJson(this.usage),
          }),
        );
      }
      out.push(SSE_DONE);
    }
    return out;
  }

  error(e: GatewayError): Uint8Array[] {
    return [sse(openAiError(e))];
  }
}

const OPENAI_TYPE: Partial<Record<ErrorKind, string>> = {
  unauthorized: "authentication_error",
  forbidden: "permission_error",
  bad_request: "invalid_request_error",
  not_found: "invalid_request_error",
  payload_too_large: "invalid_request_error",
  unsupported_media_type: "invalid_request_error",
  rate_limited: "rate_limit_error",
  client_budget_exceeded: "rate_limit_error",
  provider_window_exhausted: "rate_limit_error",
};

/** OpenAI-shaped error body with sapi's own kind added. */
export function openAiError(e: GatewayError) {
  return {
    error: {
      message: e.message,
      type: OPENAI_TYPE[e.kind] ?? "api_error",
      param: e.param ?? null,
      code: e.kind,
      sapi_error_kind: e.kind,
    },
  };
}

export const chatDoor: Door = {
  name: "chat",
  parse: parseChatRequest,
  complete: (meta, text, finish, usage) => completionJson(chatMeta(meta), text, finish, usage),
  stream: (meta, parsed) => new ChatStreamWriter(chatMeta(meta), parsed.includeUsage === true),
  errorBody: openAiError,
};
