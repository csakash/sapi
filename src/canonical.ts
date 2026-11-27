/**
 * The internal request and event format every entry point translates to and every provider
 * adapter speaks (plan §3). Client identity is never part of the body: `clientId` is filled in
 * from the authenticated key only (ARI-42 AUTH-2).
 */

export type Role = "user" | "assistant";

export type CanonicalMessage = { role: Role; text: string };

export type CanonicalRequest = {
  id: string; // req_…
  clientId: string; // from the key, never from the body
  door: "chat" | "responses" | "messages";
  alias: string; // the model alias the client asked for (validated against config)
  provider: string; // resolved provider id
  model: string; // pinned provider model ID from config, never client text
  system?: string;
  messages: CanonicalMessage[];
  stream: boolean;
  ignoredParams: string[];
};

export type LimitWindow = {
  window: string; // "5h", "weekly", "weekly_opus", … ; "spend_day" for API providers later
  usedPct: number;
  resetsAt?: string;
  source: "reported" | "estimated";
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  apiEquivUsd?: number;
  /** Provider-side time spent in the API, used for the CLI-overhead metric. */
  apiMs?: number;
};

export type FinishReason = "stop" | "length" | "tool_calls";

export type CanonicalEvent =
  | { type: "start"; providerModel: string }
  | { type: "text"; delta: string }
  | { type: "usage"; usage: Usage }
  | { type: "limit"; limit: LimitWindow }
  | { type: "done"; finish: FinishReason };

export type ErrorKind =
  | "unauthorized"
  | "forbidden"
  | "bad_request"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "client_budget_exceeded"
  | "provider_window_exhausted"
  | "provider_paused"
  | "provider_not_ready"
  | "upstream_error"
  | "timeout"
  | "client_closed"
  | "internal_error";

export const ERROR_STATUS: Record<ErrorKind, number> = {
  unauthorized: 401,
  forbidden: 403,
  bad_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  client_budget_exceeded: 429,
  provider_window_exhausted: 429,
  provider_paused: 503,
  provider_not_ready: 503,
  upstream_error: 502,
  timeout: 504,
  client_closed: 499,
  internal_error: 500,
};

/**
 * An error with a kind that maps to an HTTP status. Messages are fixed strings written in this
 * codebase: they never echo secrets, request bodies or raw provider output.
 */
export class GatewayError extends Error {
  readonly kind: ErrorKind;
  readonly retryAfterSec?: number;
  readonly param?: string;

  constructor(kind: ErrorKind, message: string, opts: { retryAfterSec?: number; param?: string } = {}) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = Math.max(1, Math.ceil(opts.retryAfterSec));
    if (opts.param !== undefined) this.param = opts.param;
  }

  get status(): number {
    return ERROR_STATUS[this.kind];
  }
}

export function asGatewayError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e;
  return new GatewayError("internal_error", "Internal error. The request was not completed.");
}

/** Short random IDs for requests and clients (not secrets). */
export function newId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Buffer.from(b).toString("base64url")}`;
}
