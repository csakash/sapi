/**
 * Outbound HTTPS from sapi's own process (ARI-42 INJ-4). The ChatGPT provider talks to OpenAI
 * directly, with no child process, so its calls are checked here:
 *
 *   - https only, port 443, no credentials in the URL, and the host must be on the provider's
 *     allowlist (from its manifest);
 *   - every call goes through an EgressProxy holding that same allowlist, which resolves the name
 *     itself and refuses private, link-local and metadata addresses;
 *   - redirects are refused, so an allowed host can't bounce a request, bearer token included,
 *     somewhere else.
 *
 * URLs are built from constants in code, never from request text.
 */
import { GatewayError } from "./canonical.ts";
import { type EgressEvent, EgressProxy } from "./egress-proxy.ts";

export type EgressInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export type EgressFetch = (url: string, init?: EgressInit) => Promise<Response>;

export class EgressRefused extends GatewayError {
  constructor() {
    super("upstream_error", "sapi's egress rules refused an outbound request.");
  }
}

/** Throws unless the URL is https on port 443 to a host on the list. */
export function assertAllowedUrl(url: string, allow: ReadonlySet<string>): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new EgressRefused();
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port !== "" && u.port !== "443"))
    throw new EgressRefused();
  if (!allow.has(u.hostname)) throw new EgressRefused();
  return u;
}

export function guardedFetch(
  allow: string[],
  proxyUrl: string | undefined,
  base: (url: string, init: RequestInit & { proxy?: string }) => Promise<Response> = fetch,
): EgressFetch {
  const hosts = new Set(allow);
  return async (url, init = {}) => {
    const u = assertAllowedUrl(url, hosts);
    const signals = [AbortSignal.timeout(init.timeoutMs ?? 30_000)];
    if (init.signal) signals.push(init.signal);
    const res = await base(u.toString(), {
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: "error",
      signal: AbortSignal.any(signals),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
    return res;
  };
}

/** An allowlisted egress path with its own proxy; close it when done (CLI commands). */
export async function openEgress(
  allow: string[],
  onEvent?: (e: EgressEvent) => void,
): Promise<{ fetch: EgressFetch; proxy: EgressProxy; close: () => Promise<void> }> {
  const proxy = new EgressProxy({ allow, ...(onEvent ? { onEvent } : {}) });
  const port = await proxy.listenTcp();
  return { fetch: guardedFetch(allow, `http://127.0.0.1:${port}`), proxy, close: () => proxy.close() };
}
