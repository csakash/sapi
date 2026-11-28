/**
 * `sapi login chatgpt` and friends (plan §5, §10).
 *
 *   desktop   a one-shot listener on http://127.0.0.1:<free port>/auth/callback, then the system
 *             browser opens OpenAI's sign-in page.
 *   --ssh     the same listener on the VM; sapi prints the `ssh -L` tunnel to open from the
 *             laptop, so the browser's redirect to 127.0.0.1 reaches the VM through it.
 *   --export  sign in on a laptop and write the sign-in out (stdout or a new 0600 file) instead of
 *             keeping it, so only the machine that imports it ever refreshes it.
 *   --import  take an exported sign-in on the VM, keeping the VM's own host ID.
 *   logout    revoke the refresh token at OpenAI, then delete the sign-in.
 *
 * The listener answers only on 127.0.0.1 with the right Host and path, checks state with a
 * constant-time compare, accepts one callback and shows a fixed page that echoes nothing.
 */
import { z } from "zod";
import type { EgressFetch } from "../../egress-fetch.ts";
import type { Paths } from "../../paths.ts";
import type { SecretStore } from "../../secrets.ts";
import { type PlanModel, planModels } from "./adapter.ts";
import {
  AUTHORIZE_URL,
  authorizeUrl,
  exchangeCode,
  grantedScopes,
  ISSUED_CLIENT_RE,
  missingScopes,
  OAuthError,
  pkcePair,
  randomToken,
  redirectUri,
  revokeRefreshToken,
  sameSecret,
  verifyIdToken,
} from "./oauth.ts";
import { loadOrCreateHost, parseSession, SESSION_SECRET, Session, saveHost, sessionFromTokens } from "./session.ts";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em"><h1>${title}</h1><p>${body}</p>`;

export type CallbackOutcome = { code: string; scopes: string[]; clientId: string | null };

export async function startCallbackServer(o: { port?: number; state: string; timeoutMs?: number }): Promise<{
  port: number;
  redirectUri: string;
  result: Promise<CallbackOutcome>;
  stop: () => void;
}> {
  let settle!: { resolve: (v: CallbackOutcome) => void; reject: (e: Error) => void };
  const result = new Promise<CallbackOutcome>((resolve, reject) => {
    settle = { resolve, reject };
  });
  let done = false;
  const finish = (fn: () => void) => {
    if (done) return;
    done = true;
    fn();
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port ?? 0,
    development: false,
    fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get("host");
      const okHost = host === `127.0.0.1:${server.port}` || host === `localhost:${server.port}`;
      if (!okHost || req.method !== "GET" || url.pathname !== "/auth/callback")
        return new Response("Not found", { status: 404 });
      if (done) return new Response(page("Already done", "Return to the terminal."), { headers: PAGE_HEADERS });
      const state = url.searchParams.get("state") ?? "";
      if (!state || !sameSecret(state, o.state))
        return new Response(page("Sign-in not recognised", "Start again from the terminal."), {
          status: 400,
          headers: PAGE_HEADERS,
        });
      const error = url.searchParams.get("error");
      if (error) {
        const code = /^[a-z_]{1,64}$/.test(error) ? error : "error";
        finish(() =>
          settle.reject(
            new OAuthError(
              code,
              0,
              code === "access_denied" ? "The sign-in was cancelled in the browser." : `The sign-in failed (${code}).`,
            ),
          ),
        );
        return new Response(page("Sign-in cancelled", "Return to the terminal."), { headers: PAGE_HEADERS });
      }
      const code = url.searchParams.get("code") ?? "";
      if (!/^[\x21-\x7e]{1,4096}$/.test(code))
        return new Response(page("Sign-in not recognised", "Start again from the terminal."), {
          status: 400,
          headers: PAGE_HEADERS,
        });
      const clientId = url.searchParams.get("client_id");
      finish(() =>
        settle.resolve({
          code,
          scopes: grantedScopes(url.searchParams.get("scope") ?? ""),
          clientId: clientId && ISSUED_CLIENT_RE.test(clientId) ? clientId : null,
        }),
      );
      return new Response(page("Signed in", "sapi has your ChatGPT sign-in. You can close this tab."), {
        headers: PAGE_HEADERS,
      });
    },
  });
  const timer = setTimeout(
    () => finish(() => settle.reject(new OAuthError("timeout", 0, "The sign-in timed out. Run the command again."))),
    o.timeoutMs ?? 10 * 60_000,
  );
  const port = server.port!;
  return {
    port,
    redirectUri: redirectUri(port),
    result,
    stop: () => {
      clearTimeout(timer);
      // Graceful: the browser still gets its "Signed in" page; new connections are refused.
      void server.stop();
    },
  };
}

/** Open the system browser on OpenAI's sign-in page (argv only; the URL is sapi's own). */
export function openBrowser(url: string): boolean {
  if (!url.startsWith(`${AUTHORIZE_URL}?`)) return false;
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/local/bin" };
  for (const k of ["HOME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"])
    if (process.env[k]) env[k] = process.env[k]!;
  const argv =
    process.platform === "darwin" ? ["open", url] : env.DISPLAY || env.WAYLAND_DISPLAY ? ["xdg-open", url] : null;
  if (!argv) return false;
  try {
    Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env }).unref();
    return true;
  } catch {
    return false;
  }
}

export type LoginOptions = {
  paths: Paths;
  fetch: EgressFetch;
  /** Where to keep the sign-in; null with --export (nothing is kept on this machine). */
  store: SecretStore | null;
  /** Start a new registration instead of reusing the issued client ID. */
  register?: boolean;
  ssh?: boolean;
  port?: number;
  print: (line: string) => void;
  open?: (url: string) => boolean;
  sshTarget?: string;
  timeoutMs?: number;
  now?: () => number;
};

export async function loginChatGpt(o: LoginOptions): Promise<{ session: Session; models: PlanModel[] }> {
  const host = loadOrCreateHost(o.paths);
  const issued = o.register ? null : (host.client_id ?? null);
  const { verifier, challenge } = await pkcePair();
  const state = randomToken();
  const nonce = randomToken();
  const cb = await startCallbackServer({
    ...(o.port ? { port: o.port } : {}),
    state,
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  });
  let outcome: CallbackOutcome;
  try {
    const url = authorizeUrl({
      issuedClientId: issued,
      hostId: host.ext_agent_host_id,
      redirectUri: cb.redirectUri,
      state,
      nonce,
      challenge,
    });
    if (o.ssh) {
      o.print("This machine has no browser. On your laptop, open a tunnel to it first:");
      o.print(`  ssh -N -L ${cb.port}:127.0.0.1:${cb.port} ${o.sshTarget ?? "<you>@<this-machine>"}`);
      o.print("then open this link in the laptop's browser:");
    } else {
      const opened = (o.open ?? openBrowser)(url);
      o.print(
        opened
          ? "Opened your browser to sign in with ChatGPT. If it didn't, open:"
          : "Open this link to sign in with ChatGPT:",
      );
    }
    o.print(`  ${url}`);
    o.print("Waiting for the sign-in (up to 10 minutes)…");
    outcome = await cb.result;
  } finally {
    cb.stop();
  }

  let clientId: string;
  if (issued === null) {
    if (!outcome.clientId)
      throw new OAuthError(
        "registration_incomplete",
        0,
        "OpenAI didn't return a client ID, so the registration is incomplete. Run the command again.",
      );
    clientId = outcome.clientId;
    saveHost(o.paths, { ...host, client_id: clientId });
  } else {
    if (outcome.clientId && outcome.clientId !== issued)
      throw new OAuthError(
        "client_mismatch",
        0,
        "OpenAI answered for a different registration. Run: sapi login chatgpt --register",
      );
    clientId = issued;
  }
  const deny = (missing: string[]) =>
    new OAuthError(
      "scope_declined",
      0,
      `The sign-in didn't allow ${missing.join(", ")}, which sapi needs to use your plan. Run the command again and allow it.`,
    );
  const cbMissing = missingScopes(outcome.scopes);
  if (outcome.scopes.length > 0 && cbMissing.length) throw deny(cbMissing);

  const tokens = await exchangeCode(o.fetch, { clientId, code: outcome.code, verifier, redirectUri: cb.redirectUri });
  const scopes = tokens.scope ? grantedScopes(tokens.scope) : outcome.scopes;
  const missing = missingScopes(scopes);
  if (missing.length) throw deny(missing);
  if (!tokens.id_token) throw new OAuthError("bad_id_token", 0, "The sign-in returned no ID token.");
  const now = o.now?.() ?? Date.now();
  const id = await verifyIdToken(o.fetch, tokens.id_token, { clientId, nonce, now });
  const session = sessionFromTokens(
    { ...tokens, scope: scopes.join(" ") },
    { clientId, subject: id.subject, ...(id.email ? { email: id.email } : {}), now },
  );
  if (o.store) await o.store.set(SESSION_SECRET, JSON.stringify(session));
  const models = await planModels(o.fetch, session.access_token).catch(() => []);
  return { session, models };
}

// ---- moving a sign-in to a VM -------------------------------------------------------------------

const ExportFile = z.object({ format: z.literal("sapi-chatgpt-sign-in"), version: z.literal(1), session: Session });

export function exportText(session: Session): string {
  return `${JSON.stringify({ format: "sapi-chatgpt-sign-in", version: 1, session })}\n`;
}

/** Store an exported sign-in here, keeping this machine's own host ID (OpenAI's VM guidance). */
export async function importSignIn(o: { paths: Paths; store: SecretStore; text: string }): Promise<Session> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(o.text);
  } catch {
    throw new Error("That isn't a sapi ChatGPT sign-in export.");
  }
  const r = ExportFile.safeParse(parsed);
  if (!r.success) throw new Error("That isn't a sapi ChatGPT sign-in export.");
  const missing = missingScopes(r.data.session.scopes);
  if (missing.length) throw new Error(`The exported sign-in lacks ${missing.join(", ")}. Sign in again on the laptop.`);
  const host = loadOrCreateHost(o.paths);
  saveHost(o.paths, { ...host, client_id: r.data.session.client_id });
  await o.store.set(SESSION_SECRET, JSON.stringify(r.data.session));
  return r.data.session;
}

/** Revoke at OpenAI (best effort, with retries), then delete the sign-in here either way. */
export async function logoutChatGpt(o: {
  store: SecretStore;
  fetch: EgressFetch;
  delaysMs?: number[];
}): Promise<{ hadSession: boolean; revoked: boolean }> {
  const s = parseSession(await o.store.get(SESSION_SECRET));
  if (!s) {
    await o.store.delete(SESSION_SECRET);
    return { hadSession: false, revoked: false };
  }
  const revoked = await revokeRefreshToken(o.fetch, {
    clientId: s.client_id,
    refreshToken: s.refresh_token,
    ...(o.delaysMs ? { delaysMs: o.delaysMs } : {}),
  });
  await o.store.delete(SESSION_SECRET);
  return { hadSession: true, revoked };
}
