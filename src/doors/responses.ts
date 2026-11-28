/**
 * OpenAI Responses entry point (`POST /v1/responses`, plan §8). Translates the request into the
 * internal format and the internal events back into the Responses JSON and named-SSE shapes.
 *
 * sapi is stateless: stored responses, conversations, background runs and stored prompts are
 * refused, so every request carries the whole conversation in `input`. Like the chat door, this
 * phase is text only: tools, structured output and non-text parts are refused with a 400, and
 * parameters the provider can't honour are dropped and listed in `x-sapi-ignored-params`, or
 * refused when `strict_params` is on. Error messages are fixed strings; caller text never
 * appears in them except a name passed through `safeName`.
 */
import { z } from "zod";
import type { CanonicalEvent, CanonicalMessage, FinishReason, Usage } from "../canonical.ts";
import { GatewayError } from "../canonical.ts";
import { openAiError } from "./chat.ts";
import { invalidRequest, safeName, sseEvent, unhandledParams, unsupported } from "./common.ts";
import type { Door, DoorMeta, ParsedRequest, StreamWriter } from "./types.ts";

const Part = z.looseObject({ type: z.string() });
const Content = z.union([z.string(), z.array(Part)]);

/** Any input item: only its type is checked here, so a tool or reasoning item gets a clear 400. */
const InputItem = z.looseObject({ type: z.string().optional() });

/** A message item, checked once the item is known to be a message. */
const MessageItem = z.looseObject({
  type: z.literal("message").optional(),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: Content,
});

const ResponsesRequest = z.looseObject({
  model: z.string().min(1).max(200),
  input: z.union([z.string(), z.array(InputItem).max(2000)]),
  instructions: z.string().nullish(),
  stream: z.boolean().optional(),
  previous_response_id: z.unknown().optional(),
  conversation: z.unknown().optional(),
  tools: z.array(z.unknown()).nullish(),
  text: z.looseObject({ format: z.looseObject({ type: z.string() }).nullish() }).nullish(),
  background: z.boolean().nullish(),
  prompt: z.unknown().optional(),
});

const HANDLED = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "previous_response_id",
  "conversation",
  "tools",
  "background",
  "prompt",
]);
/** `text` is handled when it only asks for plain text; anything more in it (verbosity) is listed. */
const HANDLED_WITH_TEXT = new Set([...HANDLED, "text"]);

const TEXT_PARTS = new Set(["input_text", "output_text"]);
const TOOL_ITEMS = new Set(["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"]);

const set = (v: unknown) => v !== undefined && v !== null;

function textOf(content: z.infer<typeof Content>, where: string): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const p of content) {
    if (!TEXT_PARTS.has(p.type)) {
      throw new GatewayError(
        "bad_request",
        `Only text content is supported by this provider (${where} has a "${safeName(p.type)}" part).`,
        { param: "input" },
      );
    }
    if (typeof p.text !== "string") {
      throw new GatewayError("bad_request", `Invalid request: ${where}: a text part needs a text string.`, {
        param: "input",
      });
    }
    parts.push(p.text);
  }
  return parts.join("\n");
}

/** A schema problem inside `input[i]`, reported with its full path (never the value). */
function itemInvalid(i: number, error: z.ZodError): GatewayError {
  return invalidRequest(new z.ZodError(error.issues.map((issue) => ({ ...issue, path: ["input", i, ...issue.path] }))));
}

export function parseResponsesRequest(body: unknown, strictParams: boolean): ParsedRequest {
  const r = ResponsesRequest.safeParse(body);
  if (!r.success) throw invalidRequest(r.error);
  const req = r.data;
  for (const param of ["previous_response_id", "conversation"] as const) {
    if (set(req[param])) {
      throw new GatewayError("bad_request", "sapi is stateless: send the whole conversation in input.", { param });
    }
  }
  if (set(req.prompt)) {
    throw new GatewayError("bad_request", "Stored prompt templates (prompt) aren't supported: sapi is stateless.", {
      param: "prompt",
    });
  }
  if (req.background === true) {
    throw new GatewayError("bad_request", "Background responses aren't supported: sapi is stateless.", {
      param: "background",
    });
  }
  if (req.tools && req.tools.length > 0) throw unsupported("Tool calling", "tools");
  if (req.text?.format && req.text.format.type !== "text") throw unsupported("Structured output (text.format)", "text");

  const text = req.text;
  const textIsPlain = !text || Object.entries(text).every(([k, v]) => k === "format" || !set(v));
  const unknownOrIgnored = unhandledParams(body, textIsPlain ? HANDLED_WITH_TEXT : HANDLED, strictParams);

  const systemParts: string[] = [];
  if (typeof req.instructions === "string") systemParts.push(req.instructions);
  const messages: CanonicalMessage[] = [];
  if (typeof req.input === "string") {
    messages.push({ role: "user", text: req.input });
  } else {
    req.input.forEach((item, i) => {
      const where = `input[${i}]`;
      const type = item.type ?? "message";
      if (TOOL_ITEMS.has(type)) {
        throw new GatewayError("bad_request", "Tool messages aren't supported by sapi yet (planned).", {
          param: where,
        });
      }
      if (type !== "message") {
        throw new GatewayError(
          "bad_request",
          `Only message items are supported in input (${where} is a "${safeName(type)}" item).`,
          { param: where },
        );
      }
      const m = MessageItem.safeParse(item);
      if (!m.success) throw itemInvalid(i, m.error);
      const itemText = textOf(m.data.content, where);
      if (m.data.role === "system" || m.data.role === "developer") systemParts.push(itemText);
      else messages.push({ role: m.data.role, text: itemText });
    });
  }
  if (messages.length === 0)
    throw new GatewayError("bad_request", "At least one user message is required.", { param: "input" });
  if (messages[messages.length - 1]!.role !== "user") {
    throw new GatewayError("bad_request", "The last message must be from the user.", { param: "input" });
  }
  const out: ParsedRequest = {
    alias: req.model,
    messages,
    stream: req.stream === true,
    ignoredParams: unknownOrIgnored,
  };
  if (systemParts.length) out.system = systemParts.join("\n\n");
  return out;
}

export type ResponsesMeta = { id: string; msgId: string; created: number; model: string };

/** `resp_…` and `msg_…` share the request ID's random part. */
export function responsesMeta(m: DoorMeta): ResponsesMeta {
  const tail = m.requestId.startsWith("req_") ? m.requestId.slice(4) : m.requestId;
  return { id: `resp_${tail}`, msgId: `msg_${tail}`, created: m.created, model: m.model };
}

type Status = "in_progress" | "completed" | "incomplete";

function usageJson(u: Usage | undefined) {
  const input = u ? u.input + u.cacheRead + u.cacheWrite : 0;
  const output = u?.output ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u?.cacheRead ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u?.reasoning ?? 0 },
    total_tokens: input + output,
  };
}

const textPart = (text: string) => ({ type: "output_text", text, annotations: [] });

const messageItem = (meta: ResponsesMeta, status: "in_progress" | "completed", content: unknown[]) => ({
  type: "message",
  id: meta.msgId,
  status,
  role: "assistant",
  content,
});

function responseJson(
  meta: ResponsesMeta,
  status: Status,
  output: unknown[],
  usage: ReturnType<typeof usageJson> | null,
) {
  return {
    id: meta.id,
    object: "response",
    created_at: meta.created,
    status,
    error: null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    instructions: null,
    model: meta.model,
    output,
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    store: false,
    temperature: null,
    top_p: null,
    text: { format: { type: "text" } },
    metadata: {},
    usage,
  };
}

/** The finished response (the non-streamed body and the last streamed event). */
export function responseObject(meta: ResponsesMeta, text: string, finish: FinishReason, usage: Usage | undefined) {
  const status: Status = finish === "length" ? "incomplete" : "completed";
  return responseJson(meta, status, [messageItem(meta, "completed", [textPart(text)])], usageJson(usage));
}

/** Turns internal events into the Responses API's named SSE events for one streamed response. */
export class ResponsesStreamWriter implements StreamWriter {
  private seq = 0;
  private started = false;
  private opened = false;
  private finished = false;
  private text = "";
  private usage: Usage | undefined;

  constructor(private readonly meta: ResponsesMeta) {}

  private event(type: string, fields: Record<string, unknown>): Uint8Array {
    return sseEvent(type, { type, sequence_number: this.seq++, ...fields });
  }

  frames(ev: CanonicalEvent): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (this.finished) return out;
    // A start that never came is sent before the first text, so clients always see the lifecycle.
    if (!this.started && (ev.type === "start" || ev.type === "text" || ev.type === "done")) {
      this.started = true;
      const response = responseJson(this.meta, "in_progress", [], null);
      out.push(this.event("response.created", { response }), this.event("response.in_progress", { response }));
    }
    const ids = { item_id: this.meta.msgId, output_index: 0, content_index: 0 };
    if (!this.opened && (ev.type === "text" || ev.type === "done")) {
      this.opened = true;
      out.push(
        this.event("response.output_item.added", { output_index: 0, item: messageItem(this.meta, "in_progress", []) }),
        this.event("response.content_part.added", { ...ids, part: textPart("") }),
      );
    }
    if (ev.type === "text") {
      this.text += ev.delta;
      out.push(this.event("response.output_text.delta", { ...ids, delta: ev.delta, logprobs: [] }));
    }
    if (ev.type === "usage") this.usage = ev.usage;
    if (ev.type === "done") {
      this.finished = true;
      const part = textPart(this.text);
      const response = responseObject(this.meta, this.text, ev.finish, this.usage);
      out.push(
        this.event("response.output_text.done", { ...ids, text: this.text, logprobs: [] }),
        this.event("response.content_part.done", { ...ids, part }),
        this.event("response.output_item.done", { output_index: 0, item: messageItem(this.meta, "completed", [part]) }),
        // The API ends a truncated response with `response.incomplete`, everything else with `response.completed`.
        this.event(response.status === "incomplete" ? "response.incomplete" : "response.completed", { response }),
      );
    }
    return out;
  }

  error(e: GatewayError): Uint8Array[] {
    this.finished = true;
    return [
      sseEvent("error", {
        type: "error",
        code: e.kind,
        message: e.message,
        param: e.param ?? null,
        sapi_error_kind: e.kind,
        sequence_number: this.seq++,
      }),
    ];
  }
}

export const responsesDoor: Door = {
  name: "responses",
  parse: parseResponsesRequest,
  complete: (meta, text, finish, usage) => responseObject(responsesMeta(meta), text, finish, usage),
  stream: (meta) => new ResponsesStreamWriter(responsesMeta(meta)),
  errorBody: openAiError,
};
