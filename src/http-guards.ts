/**
 * HTTP guards that run before routing (ARI-42 MCP-3; plan §6).
 *
 * - Host allowlist: only the loopback names sapi listens on. Stops DNS-rebinding attacks, where a
 *   web page resolves its own domain to 127.0.0.1 and calls sapi from the browser.
 * - Origin and Fetch-Metadata checks: a cross-site browser request is refused. sapi sends no CORS
 *   headers, so a browser can't read responses either.
 * - JSON only for POST bodies (a plain HTML form can't send application/json), with a size cap.
 * - Security headers on every response.
 */
import { GatewayError } from "./canonical.ts";

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function checkHostAndOrigin(req: Request, hosts: Set<string>): void {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!hosts.has(host))
    throw new GatewayError("forbidden", "Requests must be addressed to sapi's loopback address (Host header).");
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = u.protocol === "http:" && hosts.has(u.host.toLowerCase());
    } catch {
      ok = false;
    }
    if (!ok) throw new GatewayError("forbidden", "Cross-origin requests are not allowed.");
  }
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    throw new GatewayError("forbidden", "Cross-site requests are not allowed.");
  }
}

/** Read a JSON body with a hard size cap, whether or not Content-Length was sent. */
export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(ct)) {
    throw new GatewayError("unsupported_media_type", "Send the body as application/json.");
  }
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes)
    throw new GatewayError("payload_too_large", `The body is larger than ${maxBytes} bytes.`);
  if (!req.body) throw new GatewayError("bad_request", "The request has no body.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new GatewayError("payload_too_large", `The body is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new GatewayError("bad_request", "The body is not valid JSON.");
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "cache-control": "no-store",
};

export function withSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  // Never any CORS: a browser page on another origin can't read sapi's responses.
  for (const k of [...res.headers.keys()]) if (k.startsWith("access-control-")) res.headers.delete(k);
  return res;
}
