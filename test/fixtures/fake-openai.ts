/**
 * A fake OpenAI for tests: the Responses API, the models list, the sign-in server's token,
 * discovery, signing-key and revocation endpoints. It is an EgressFetch, so it plugs in where the
 * real guarded fetch would go; nothing touches the network.
 *
 * Every call is recorded (URL, method, headers, body) so tests can check exactly what would have
 * left sapi. Tokens are built at runtime and are never real credentials.
 */
import type { EgressFetch, EgressInit } from "../../src/egress-fetch.ts";
import { MODELS_URL, RESPONSES_URL } from "../../src/providers/chatgpt-sub/manifest.ts";
import { AUTH_ORIGIN, DISCOVERY_URL, TOKEN_URL } from "../../src/providers/chatgpt-sub/oauth.ts";
import type { Session } from "../../src/providers/chatgpt-sub/session.ts";
import type { SecretStore } from "../../src/secrets.ts";

export const JWKS_URL = `${AUTH_ORIGIN}/.well-known/jwks.json`;
export const REVOKE_URL = `${AUTH_ORIGIN}/api/accounts/oauth/revoke`;
export const TEST_CLIENT_ID = "oaiapp_TESTONLY0123";

/** Opaque token-shaped test strings (not JWTs, so no scanner mistakes them for leaks). */
export const fakeToken = (kind: string, n = 0) => ["tok", kind, String(n), "TESTONLY".repeat(3)].join("_");

export type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

export type Upstream = {
  /** Answer to POST /v1/responses: SSE frames or an HTTP error. */
  responses?: (body: Record<string, unknown>, n: number) => Response | Promise<Response>;
  /** Answer to the token endpoint. */
  token?: (form: URLSearchParams, n: number) => Response | Promise<Response>;
  revoke?: (form: URLSearchParams) => Response;
};

export const sseFrame = (obj: Record<string, unknown>) =>
  `event: ${String(obj.type)}\ndata: ${JSON.stringify(obj)}\n\n`;

export function sseResponse(frames: string[], status = 200): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(c) {
        for (const f of frames) {
          c.enqueue(enc.encode(f));
          await Bun.sleep(1);
        }
        c.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
}

/** A normal streamed answer: "chatgpt: <last user message>" in pieces, then response.completed. */
export function echoFrames(body: Record<string, unknown>): string[] {
  const input = body.input as Array<{ content: string }>;
  const text = `chatgpt: ${input[input.length - 1]?.content ?? ""}`;
  const frames = [sseFrame({ type: "response.created", response: { id: "resp_up", model: body.model } })];
  for (let i = 0; i < text.length; i += 6)
    frames.push(sseFrame({ type: "response.output_text.delta", delta: text.slice(i, i + 6), item_id: "msg_up" }));
  frames.push(
    sseFrame({
      type: "response.completed",
      response: {
        id: "resp_up",
        model: body.model,
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    }),
  );
  return frames;
}

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** An RSA key pair and a signer for ID tokens, made fresh per test file. */
export async function signingKey(kid = "test-key") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n?: string; e?: string };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid }) => {
    const input = `${b64(header)}.${b64(claims)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { jwks: { keys: [{ kty: "RSA", kid, alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] }, sign };
}

export function fakeOpenAi(up: Upstream = {}, jwks?: unknown) {
  const calls: Call[] = [];
  let responsesN = 0;
  let tokenN = 0;
  const fetch: EgressFetch = async (url: string, init: EgressInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
    };
    calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason;
    if (url === RESPONSES_URL && call.method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      return up.responses ? up.responses(body, responsesN++) : sseResponse(echoFrames(body));
    }
    if (url === MODELS_URL)
      return jsonResponse({
        models: [
          { slug: "gpt-test-1", display_name: "GPT Test", visibility: "list" },
          { slug: "gpt-hidden-1", display_name: "Hidden", visibility: "hide" },
        ],
      });
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(init.body ?? "");
      if (up.token) return up.token(form, tokenN++);
      tokenN++;
      return jsonResponse({
        access_token: fakeToken("access", tokenN),
        refresh_token: fakeToken("refresh", tokenN),
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    }
    if (url === DISCOVERY_URL)
      return jsonResponse({ issuer: AUTH_ORIGIN, jwks_uri: JWKS_URL, revocation_endpoint: REVOKE_URL });
    if (url === JWKS_URL) return jsonResponse(jwks ?? { keys: [] });
    if (url === REVOKE_URL)
      return up.revoke ? up.revoke(new URLSearchParams(init.body ?? "")) : new Response("", { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

export function memoryStore(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    backend: "file",
    data,
    get: async (n) => data.get(n) ?? null,
    set: async (n, v) => {
      data.set(n, v);
    },
    delete: async (n) => data.delete(n),
  };
}

export function testSession(o: Partial<Session> = {}, now = Date.now()): Session {
  return {
    version: 1,
    client_id: TEST_CLIENT_ID,
    access_token: fakeToken("access"),
    refresh_token: fakeToken("refresh"),
    token_type: "Bearer",
    expires_at: now + 3600_000,
    scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
    subject: "user-test",
    refreshed_at: now,
    saved_at: now,
    ...o,
  };
}
