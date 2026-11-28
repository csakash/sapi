/**
 * The ChatGPT sign-in as sapi keeps it: one record in the secret store (tokens), plus a small
 * non-secret host file with this machine's ext_agent_host_id and the issued client ID, which
 * outlive a sign-out (OpenAI: revoking doesn't delete the registration).
 *
 * Only the gateway refreshes. Refreshes are serialised, and the store is re-read first, so a
 * newer sign-in from `sapi login chatgpt` is never overwritten with an older token. A refresh
 * token that OpenAI says is unusable clears the sign-in; a network failure never does.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GatewayError } from "../../canonical.ts";
import type { EgressFetch } from "../../egress-fetch.ts";
import { assertPrivateFile, ensurePrivateDir, type Paths } from "../../paths.ts";
import type { SecretStore } from "../../secrets.ts";
import {
  grantedScopes,
  HOST_ID_RE,
  ISSUED_CLIENT_RE,
  missingScopes,
  OAuthError,
  refreshTokens,
  type TokenResponse,
} from "./oauth.ts";

export const SESSION_SECRET = "chatgpt";
/** OpenAI: refresh tokens live 30 days and are replaced on every refresh. */
export const REFRESH_TOKEN_LIFE_MS = 30 * 24 * 3600 * 1000;
/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export const Session = z.object({
  version: z.literal(1),
  client_id: z.string().regex(ISSUED_CLIENT_RE),
  access_token: z.string().min(16),
  refresh_token: z.string().min(16),
  id_token: z.string().optional(),
  token_type: z.string(),
  /** ms since the epoch */
  expires_at: z.number(),
  scopes: z.array(z.string()),
  subject: z.string().min(1),
  email: z.string().optional(),
  /** When the current refresh token was issued (its 30 days run from here). */
  refreshed_at: z.number(),
  saved_at: z.number(),
});
export type Session = z.infer<typeof Session>;

export function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const r = Session.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function sessionFromTokens(
  t: TokenResponse,
  o: { clientId: string; subject: string; email?: string; now: number },
): Session {
  if (!t.refresh_token) throw new OAuthError("no_refresh_token", 0, "The sign-in returned no refresh token.");
  return {
    version: 1,
    client_id: o.clientId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    ...(t.id_token ? { id_token: t.id_token } : {}),
    token_type: "Bearer",
    expires_at: o.now + t.expires_in * 1000,
    scopes: grantedScopes(t.scope),
    subject: o.subject,
    ...(o.email ? { email: o.email } : {}),
    refreshed_at: o.now,
    saved_at: o.now,
  };
}

// ---- host file -------------------------------------------------------------------------------

const HostFile = z.object({
  ext_agent_host_id: z.string().regex(HOST_ID_RE),
  client_id: z.string().regex(ISSUED_CLIENT_RE).optional(),
});
export type HostFile = z.infer<typeof HostFile>;

export function hostFilePath(paths: Paths): string {
  return join(paths.dataDir, "chatgpt-host.json");
}

/** This machine's identity for OpenAI: created once, before the first sign-in, then reused. */
export function loadOrCreateHost(paths: Paths): HostFile {
  const f = hostFilePath(paths);
  if (existsSync(f)) {
    assertPrivateFile(f);
    const r = HostFile.safeParse(JSON.parse(readFileSync(f, "utf8")));
    if (r.success) return r.data;
  }
  const host: HostFile = { ext_agent_host_id: `urn:uuid:${crypto.randomUUID()}` };
  saveHost(paths, host);
  return host;
}

export function saveHost(paths: Paths, host: HostFile): void {
  ensurePrivateDir(paths.dataDir);
  writeFileSync(hostFilePath(paths), `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
}

// ---- readiness and tokens ------------------------------------------------------------------

export const notSignedIn = (why = "Not signed in to ChatGPT.") =>
  new GatewayError("provider_not_ready", `${why} Sign in with: sapi login chatgpt`);

export type SessionState =
  | { ok: true; session: Session; refreshTokenDaysLeft: number }
  | { ok: false; reason: string; fix: string };

export function sessionState(s: Session | null, now = Date.now()): SessionState {
  const fix = "sapi login chatgpt";
  if (!s) return { ok: false, reason: "not signed in to ChatGPT", fix };
  const missing = missingScopes(s.scopes);
  if (missing.length) return { ok: false, reason: `the sign-in lacks ${missing.join(", ")}`, fix };
  const left = s.refreshed_at + REFRESH_TOKEN_LIFE_MS - now;
  if (left <= 0) return { ok: false, reason: "the ChatGPT sign-in expired (no use for 30 days)", fix };
  return { ok: true, session: s, refreshTokenDaysLeft: Math.floor(left / 86_400_000) };
}

export type AuthEvent = (kind: string, detail: Record<string, unknown>) => void;

export class ChatGptAuth {
  private refreshing: Promise<Session> | null = null;
  private storePromise: Promise<SecretStore> | null = null;

  constructor(
    private readonly o: {
      openStore: () => Promise<SecretStore>;
      fetch: EgressFetch;
      now?: () => number;
      onEvent?: AuthEvent;
    },
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private async store(): Promise<SecretStore> {
    this.storePromise ??= this.o.openStore();
    try {
      return await this.storePromise;
    } catch (e) {
      this.storePromise = null;
      throw new GatewayError("provider_not_ready", `${(e as Error).message}`);
    }
  }

  async load(): Promise<Session | null> {
    const store = await this.store();
    try {
      return parseSession(await store.get(SESSION_SECRET));
    } catch {
      throw new GatewayError("provider_not_ready", "sapi couldn't read the ChatGPT sign-in from the secret store.");
    }
  }

  /** A usable access token, refreshed first when it is about to expire (or when forced). */
  async accessToken(force = false): Promise<string> {
    const s = await this.load();
    const st = sessionState(s, this.now());
    if (!st.ok) throw notSignedIn(`ChatGPT: ${st.reason}.`);
    if (!force && st.session.expires_at - this.now() > REFRESH_MARGIN_MS) return st.session.access_token;
    return (await this.refresh(st.session)).access_token;
  }

  private refresh(seen: Session): Promise<Session> {
    this.refreshing ??= this.doRefresh(seen).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(seen: Session): Promise<Session> {
    const store = await this.store();
    const latest = (await this.load()) ?? seen;
    const now = this.now();
    // Someone signed in again (or refreshed) since we looked: use theirs.
    if (latest.refresh_token !== seen.refresh_token && latest.expires_at - now > REFRESH_MARGIN_MS) return latest;
    let t: TokenResponse;
    try {
      t = await refreshTokens(this.o.fetch, { clientId: latest.client_id, refreshToken: latest.refresh_token });
    } catch (e) {
      if (e instanceof OAuthError && e.terminal) {
        await store.delete(SESSION_SECRET).catch(() => false);
        this.o.onEvent?.("chatgpt_signed_out", { reason: e.code });
        throw notSignedIn("The ChatGPT sign-in ended (OpenAI refused the refresh token).");
      }
      if (e instanceof OAuthError && e.code === "invalid_client") {
        throw notSignedIn("OpenAI no longer accepts sapi's client registration.");
      }
      throw new GatewayError(
        "provider_not_ready",
        "sapi couldn't refresh the ChatGPT sign-in right now; try again shortly.",
        {
          retryAfterSec: 30,
        },
      );
    }
    const scopes = t.scope ? grantedScopes(t.scope) : latest.scopes;
    const next: Session = {
      ...latest,
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? latest.refresh_token,
      ...(t.id_token ? { id_token: t.id_token } : {}),
      expires_at: now + t.expires_in * 1000,
      scopes,
      refreshed_at: t.refresh_token ? now : latest.refreshed_at,
      saved_at: now,
    };
    // Save first: the old refresh token is spent from here on.
    await store.set(SESSION_SECRET, JSON.stringify(next));
    this.o.onEvent?.("chatgpt_refreshed", {});
    if (missingScopes(scopes).length) throw notSignedIn("The ChatGPT sign-in no longer allows plan usage.");
    return next;
  }
}
