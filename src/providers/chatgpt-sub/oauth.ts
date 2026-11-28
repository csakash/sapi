/**
 * Sign in with ChatGPT for a local open-source tool (plan §10; OpenAI's developer docs under
 * developers.openai.com/siwc/token-sharing-open-source). OAuth authorization code with PKCE
 * (S256), no client secret.
 *
 *   - First sign-in registers with client_id=dynamic_agent_client and agent_name_hint; the
 *     callback returns the issued oaiapp_… client ID, which every later call uses.
 *   - Every authorize request carries this host's ext_agent_host_id (urn:uuid:…, not a secret).
 *   - The redirect is http://127.0.0.1:<free port>/auth/callback (never localhost).
 *   - state, nonce and the granted scopes are checked; the ID token's signature is verified
 *     against OpenAI's published keys, with issuer, audience, expiry and nonce.
 *
 * Every response from OpenAI is parsed with Zod; nothing it returns becomes a URL unless it is
 * on auth.openai.com (ARI-42 OUT-1, INJ-4). Tokens never appear in an error message.
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { EgressFetch } from "../../egress-fetch.ts";

export const AUTH_ORIGIN = "https://auth.openai.com";
export const AUTHORIZE_URL = `${AUTH_ORIGIN}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
export const DISCOVERY_URL = `${AUTH_ORIGIN}/.well-known/openid-configuration`;
export const RESOURCE = "https://api.openai.com/v1";
export const REGISTRATION_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME = "sapi";
export const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
/** Without these the sign-in can't use the plan or refresh itself. */
export const REQUIRED_SCOPES = ["offline_access", "chatgpt.tokens.use.direct"];
export const CALLBACK_PATH = "/auth/callback";
export const ISSUED_CLIENT_RE = /^oaiapp_[A-Za-z0-9_-]{4,200}$/;
export const HOST_ID_RE = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Refresh-token errors after which the sign-in is gone and must be redone. */
const TERMINAL_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

/** An error from the sign-in server. `code` is sanitised; no token or description is kept. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
  /** The refresh token can't be used again: clear the sign-in and sign in again. */
  get terminal(): boolean {
    return TERMINAL_REFRESH.has(this.code);
  }
}

const b64url = (b: Uint8Array | ArrayBuffer) =>
  Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("base64url");

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

export type AuthorizeParams = {
  /** The issued oaiapp_… ID, or null to register this tool for the first time. */
  issuedClientId: string | null;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
};

export function authorizeUrl(p: AuthorizeParams): string {
  if (!HOST_ID_RE.test(p.hostId)) throw new Error("invalid host ID");
  if (p.issuedClientId !== null && !ISSUED_CLIENT_RE.test(p.issuedClientId)) throw new Error("invalid client ID");
  const q = new URLSearchParams();
  q.set("client_id", p.issuedClientId ?? REGISTRATION_CLIENT_ID);
  if (p.issuedClientId === null) q.set("agent_name_hint", AGENT_NAME);
  q.set("ext_agent_host_id", p.hostId);
  q.set("response_type", "code");
  q.set("redirect_uri", p.redirectUri);
  q.set("scope", SCOPES.join(" "));
  q.set("resource", RESOURCE);
  q.set("state", p.state);
  q.set("nonce", p.nonce);
  q.set("code_challenge_method", "S256");
  q.set("code_challenge", p.challenge);
  // URLSearchParams encodes spaces as "+", which OAuth servers accept; use %20 to be exact.
  return `${AUTHORIZE_URL}?${q.toString().replace(/\+/g, "%20")}`;
}

export const TokenResponse = z.looseObject({
  access_token: z.string().min(16).max(16_384),
  refresh_token: z.string().min(16).max(16_384).optional(),
  id_token: z.string().min(16).max(16_384).optional(),
  token_type: z.string().max(32),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(86_400 * 30),
  scope: z.string().max(2000).optional(),
  earliest_refresh_at: z.number().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

const OAuthErrorBody = z.looseObject({
  error: z.union([z.string(), z.looseObject({ code: z.string().optional() })]).optional(),
});

function cleanCode(s: string | undefined): string {
  return s && /^[a-z0-9_.-]{1,64}$/i.test(s) ? s.toLowerCase() : "unknown";
}

async function tokenCall(f: EgressFetch, fields: Record<string, string>): Promise<TokenResponse> {
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = OAuthErrorBody.safeParse(body);
    const raw = e.success ? e.data.error : undefined;
    const code = cleanCode(typeof raw === "string" ? raw : raw?.code);
    throw new OAuthError(
      code,
      res.status,
      `The ChatGPT sign-in server refused the request (${code}, HTTP ${res.status}).`,
    );
  }
  const t = TokenResponse.safeParse(body);
  if (!t.success)
    throw new OAuthError("bad_response", res.status, "The ChatGPT sign-in server sent an unexpected answer.");
  if (t.data.token_type.toLowerCase() !== "bearer")
    throw new OAuthError("bad_token_type", res.status, "The ChatGPT sign-in server sent an unexpected token type.");
  return t.data;
}

export function exchangeCode(
  f: EgressFetch,
  o: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<TokenResponse> {
  return tokenCall(f, {
    grant_type: "authorization_code",
    client_id: o.clientId,
    code: o.code,
    code_verifier: o.verifier,
    redirect_uri: o.redirectUri,
    resource: RESOURCE,
  });
}

/** Refresh with the issued client ID; scope is left out so the grant stays as it was. */
export function refreshTokens(f: EgressFetch, o: { clientId: string; refreshToken: string }): Promise<TokenResponse> {
  return tokenCall(f, {
    grant_type: "refresh_token",
    client_id: o.clientId,
    refresh_token: o.refreshToken,
    resource: RESOURCE,
  });
}

const Discovery = z.looseObject({
  issuer: z.string(),
  jwks_uri: z.string(),
  revocation_endpoint: z.string().optional(),
});

/** A URL from the discovery document is used only if it stays on the sign-in server. */
function onAuthOrigin(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.origin === AUTH_ORIGIN && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function discover(
  f: EgressFetch,
): Promise<{ issuer: string; jwksUri: string; revocation: string | null }> {
  const res = await f(DISCOVERY_URL, { headers: { accept: "application/json" } });
  const d = Discovery.safeParse(await res.json().catch(() => null));
  const jwks = d.success ? onAuthOrigin(d.data.jwks_uri) : null;
  if (!res.ok || !d.success || !jwks || d.data.issuer.replace(/\/$/, "") !== AUTH_ORIGIN)
    throw new OAuthError(
      "bad_discovery",
      res.status,
      "The ChatGPT sign-in server's discovery document was unexpected.",
    );
  return { issuer: d.data.issuer, jwksUri: jwks, revocation: onAuthOrigin(d.data.revocation_endpoint) };
}

const Jwks = z.object({
  keys: z.array(
    z.looseObject({
      kty: z.string(),
      kid: z.string().optional(),
      n: z.string().optional(),
      e: z.string().optional(),
      alg: z.string().optional(),
    }),
  ),
});
const IdClaims = z.looseObject({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1).max(256),
  exp: z.number(),
  iat: z.number().optional(),
  nonce: z.string().optional(),
  email: z.string().max(320).optional(),
});
export type IdIdentity = { subject: string; email?: string };

function decodePart(s: string): unknown {
  try {
    return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Verify the ID token: RS256 signature against OpenAI's published keys, then issuer, audience
 * (the issued client ID), expiry and the nonce sent with this sign-in.
 */
export async function verifyIdToken(
  f: EgressFetch,
  token: string,
  o: { clientId: string; nonce: string; now?: number; discovery?: Awaited<ReturnType<typeof discover>> },
): Promise<IdIdentity> {
  const bad = (why: string) => new OAuthError("bad_id_token", 0, `The ChatGPT ID token failed verification (${why}).`);
  const parts = token.split(".");
  if (parts.length !== 3) throw bad("format");
  const header = z.looseObject({ alg: z.string(), kid: z.string().optional() }).safeParse(decodePart(parts[0]!));
  if (!header.success || header.data.alg !== "RS256") throw bad("algorithm");
  const disc = o.discovery ?? (await discover(f));
  const res = await f(disc.jwksUri, { headers: { accept: "application/json" } });
  const jwks = Jwks.safeParse(await res.json().catch(() => null));
  if (!res.ok || !jwks.success) throw bad("signing keys");
  const jwk = jwks.data.keys.find(
    (k) =>
      k.kty === "RSA" && k.n && k.e && (!header.data.kid || k.kid === header.data.kid) && (!k.alg || k.alg === "RS256"),
  );
  if (!jwk) throw bad("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n!, e: jwk.e!, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(parts[2]!, "base64url"),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw bad("signature");
  const c = IdClaims.safeParse(decodePart(parts[1]!));
  if (!c.success) throw bad("claims");
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (c.data.iss.replace(/\/$/, "") !== disc.issuer.replace(/\/$/, "")) throw bad("issuer");
  const aud = Array.isArray(c.data.aud) ? c.data.aud : [c.data.aud];
  if (!aud.includes(o.clientId)) throw bad("audience");
  if (c.data.exp < now - 60) throw bad("expired");
  if (c.data.iat !== undefined && c.data.iat > now + 300) throw bad("issued in the future");
  if (!c.data.nonce || !sameSecret(c.data.nonce, o.nonce)) throw bad("nonce");
  return { subject: c.data.sub, ...(c.data.email ? { email: c.data.email } : {}) };
}

/**
 * Revoke a refresh token. True when the server confirmed it (an empty 200, also for a token that
 * was already invalid). Retries 5xx and network failures a few times.
 */
export async function revokeRefreshToken(
  f: EgressFetch,
  o: { clientId: string; refreshToken: string; delaysMs?: number[] },
): Promise<boolean> {
  let endpoint: string | null;
  try {
    endpoint = (await discover(f)).revocation;
  } catch {
    return false;
  }
  if (!endpoint) return false;
  for (const delay of [0, ...(o.delaysMs ?? [500, 2000])]) {
    if (delay) await Bun.sleep(delay);
    try {
      const res = await f(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: o.refreshToken,
          token_type_hint: "refresh_token",
          client_id: o.clientId,
        }).toString(),
      });
      if (res.ok) return true;
      if (res.status < 500) return false;
    } catch {
      // network: try again
    }
  }
  return false;
}

export function grantedScopes(s: string | undefined): string[] {
  return (s ?? "").split(/\s+/).filter((x) => /^[A-Za-z0-9_.:-]{1,80}$/.test(x));
}

export function missingScopes(granted: string[]): string[] {
  return REQUIRED_SCOPES.filter((s) => !granted.includes(s));
}
