/**
 * Helpers every door shares: SSE framing, safe parameter names in messages, and turning a Zod
 * failure into a 400 that never echoes the caller's text.
 */
import type { z } from "zod";
import { GatewayError } from "../canonical.ts";

const enc = new TextEncoder();

/** A data-only SSE frame (OpenAI Chat Completions style). */
export const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
/** A named SSE event (Responses and Anthropic Messages style). */
export const sseEvent = (event: string, obj: unknown) =>
  enc.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
export const SSE_DONE = enc.encode("data: [DONE]\n\n");
/** An SSE comment: every SSE parser skips it, so it keeps idle connections open in any door. */
export const SSE_PING = enc.encode(": ping\n\n");

/** A parameter or part name that is safe to put in an error message; anything else is masked. */
export function safeName(k: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(k) ? k : "(invalid-name)";
}

/** 400 for the first schema problem, naming the path only (never the value). */
export function invalidRequest(error: z.ZodError): GatewayError {
  const first = error.issues[0];
  const where = first?.path.map(String).map(safeName).join(".") || "body";
  return new GatewayError("bad_request", `Invalid request: ${where}: ${first?.message ?? "invalid"}`, {
    param: where,
  });
}

/**
 * Top-level keys the door doesn't handle itself, sorted and made safe. With `strict_params` on,
 * any of them is a 400; otherwise they're dropped and listed back to the caller.
 */
export function unhandledParams(body: unknown, handled: Set<string>, strictParams: boolean): string[] {
  const obj = body as Record<string, unknown>;
  const names = Object.keys(obj)
    .filter((k) => !handled.has(k) && obj[k] !== null && obj[k] !== undefined)
    .map(safeName)
    .sort();
  if (strictParams && names.length > 0) {
    throw new GatewayError(
      "bad_request",
      `strict_params is on and these parameters can't be honoured: ${names.join(", ")}`,
      { param: names[0]! },
    );
  }
  return names;
}

export function unsupported(what: string, param: string): GatewayError {
  return new GatewayError("bad_request", `${what} isn't supported by sapi yet (planned).`, { param });
}
