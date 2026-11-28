/**
 * What an entry point ("door") is: a translator between one public API format and the internal
 * format (plan §3, §8). The gateway runs the same pipeline for every door; a door only parses the
 * request and writes the answer and errors in its caller's format.
 *
 * Doors never decide identity, scope or routing (ARI-42 AUTH-2): they turn a body into a
 * `ParsedRequest`, and the gateway does the rest.
 */
import type { CanonicalEvent, CanonicalMessage, FinishReason, GatewayError, Usage } from "../canonical.ts";

export type DoorName = "chat" | "responses" | "messages";

/** A request in internal terms, before routing. Nothing here comes from a header or the key. */
export type ParsedRequest = {
  /** The model alias as the caller wrote it; the gateway checks it against config. */
  alias: string;
  system?: string;
  messages: CanonicalMessage[];
  stream: boolean;
  /** Chat Completions only: `stream_options.include_usage`. */
  includeUsage?: boolean;
  /** Parameters accepted but not honoured, listed back in `x-sapi-ignored-params`. */
  ignoredParams: string[];
};

export type DoorMeta = {
  /** sapi's request ID (`req_…`); each door derives its own response ID from it. */
  requestId: string;
  /** Unix seconds. */
  created: number;
  /** The provider model that answered. */
  model: string;
};

export interface StreamWriter {
  /** SSE frames for one internal event (often none). */
  frames(ev: CanonicalEvent): Uint8Array[];
  /** Frames that report an error once the stream has started, in this door's format. */
  error(e: GatewayError): Uint8Array[];
}

export interface Door {
  readonly name: DoorName;
  parse(body: unknown, strictParams: boolean): ParsedRequest;
  /** The whole answer as one JSON body (non-streamed requests). */
  complete(meta: DoorMeta, text: string, finish: FinishReason, usage: Usage | undefined): unknown;
  stream(meta: DoorMeta, parsed: ParsedRequest): StreamWriter;
  /** The body of an HTTP error response in this door's format, with `sapi_error_kind` added. */
  errorBody(e: GatewayError): unknown;
}
