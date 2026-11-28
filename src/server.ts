/**
 * The HTTP server: Bun.serve on loopback, guards first, then a handful of routes (plan §8).
 *
 *   GET  /healthz              no auth; says only "ok" or "not_ok"
 *   GET  /v1/models            client key
 *   POST /v1/chat/completions  client key (OpenAI Chat Completions)
 *   POST /v1/responses         client key (OpenAI Responses, stateless)
 *   POST /v1/messages          client key, `x-api-key` or bearer (Anthropic Messages)
 *   /, /api/*                  admin session (dashboard, Phase 4): refused for now
 *
 * Every other path is 404. Every response carries the security headers and no CORS headers.
 * Errors come back in the format of the door the caller used, with `sapi_error_kind` added.
 */
import type { Server } from "bun";
import { asGatewayError, GatewayError } from "./canonical.ts";
import { chatDoor } from "./doors/chat.ts";
import { messagesDoor } from "./doors/messages.ts";
import { responsesDoor } from "./doors/responses.ts";
import type { Door } from "./doors/types.ts";
import { type Gateway, json } from "./gateway.ts";
import { allowedHosts, checkHostAndOrigin, readJsonBody, withSecurityHeaders } from "./http-guards.ts";
import { log } from "./redact.ts";

export type ServeOptions = { hostname: string; port: number; maxBodyBytes: number };

const DOORS: Record<string, Door> = {
  "/v1/chat/completions": chatDoor,
  "/v1/responses": responsesDoor,
  "/v1/messages": messagesDoor,
};

/** The door whose error format a path uses (OpenAI's for everything that isn't a door). */
function doorFor(req: Request): Door {
  try {
    return DOORS[new URL(req.url).pathname] ?? chatDoor;
  } catch {
    return chatDoor;
  }
}

export function errorResponse(e: unknown, door: Door = chatDoor): Response {
  const ge = asGatewayError(e);
  if (ge.kind === "internal_error" && !(e instanceof GatewayError))
    log("error", "unhandled error", { error: String((e as Error)?.message ?? e) });
  const headers: Record<string, string> = {};
  if (ge.retryAfterSec !== undefined) headers["retry-after"] = String(ge.retryAfterSec);
  return json(door.errorBody(ge), ge.status === 499 ? 400 : ge.status, headers);
}

export function serve(gw: Gateway, o: ServeOptions): Server<undefined> {
  if (!["127.0.0.1", "::1"].includes(o.hostname)) throw new Error("sapi only listens on loopback");
  let hosts = allowedHosts(o.port);
  const server = Bun.serve({
    hostname: o.hostname,
    port: o.port,
    maxRequestBodySize: o.maxBodyBytes,
    idleTimeout: 30,
    development: false,
    fetch: async (req, srv) => {
      try {
        return withSecurityHeaders(await route(gw, req, srv, hosts, o.maxBodyBytes));
      } catch (e) {
        return withSecurityHeaders(errorResponse(e, doorFor(req)));
      }
    },
    error: (e) => {
      log("error", "server error", { error: String(e?.message ?? e) });
      return withSecurityHeaders(errorResponse(new GatewayError("internal_error", "Internal error.")));
    },
  });
  // Port 0 picks a free port; the Host allowlist must use the real one.
  hosts = allowedHosts(server.port!);
  return server;
}

async function route(
  gw: Gateway,
  req: Request,
  srv: Server<undefined>,
  hosts: Set<string>,
  maxBody: number,
): Promise<Response> {
  checkHostAndOrigin(req, hosts);
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path === "/healthz") {
    if (method !== "GET" && method !== "HEAD") throw new GatewayError("method_not_allowed", "Use GET.");
    let ok = true;
    try {
      gw.db.query("SELECT 1").get();
    } catch {
      ok = false;
    }
    return json({ status: ok ? "ok" : "not_ok" }, ok ? 200 : 503);
  }
  if (path === "/v1/models") {
    if (method !== "GET") throw new GatewayError("method_not_allowed", "Use GET.");
    return gw.models(req);
  }
  const door = Object.hasOwn(DOORS, path) ? DOORS[path] : undefined;
  if (door) {
    if (method !== "POST") throw new GatewayError("method_not_allowed", "Use POST.");
    // Our own timeouts apply from here (first token, total); Bun's idle timeout would cut long answers.
    srv.timeout(req, 0);
    return gw.handle(door, req, () => readJsonBody(req, maxBody));
  }
  if (path === "/" || path === "/api" || path.startsWith("/api/")) {
    throw new GatewayError(
      "forbidden",
      "The dashboard and admin API need the admin session; they arrive in a later version.",
    );
  }
  throw new GatewayError("not_found", "Not found.");
}
