/**
 * Sign in with ChatGPT: the authorize URL, PKCE, the callback listener, the code exchange and
 * refresh forms, ID-token verification, the full desktop sign-in against a fake OpenAI, moving a
 * sign-in to a VM, and sign-out. Nothing here reaches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import {
  exportText,
  importSignIn,
  loginChatGpt,
  logoutChatGpt,
  startCallbackServer,
} from "../../src/providers/chatgpt-sub/login.ts";
import {
  AUTHORIZE_URL,
  authorizeUrl,
  exchangeCode,
  OAuthError,
  pkcePair,
  REGISTRATION_CLIENT_ID,
  refreshTokens,
  revokeRefreshToken,
  verifyIdToken,
} from "../../src/providers/chatgpt-sub/oauth.ts";
import {
  hostFilePath,
  loadOrCreateHost,
  parseSession,
  SESSION_SECRET,
} from "../../src/providers/chatgpt-sub/session.ts";
import {
  fakeOpenAi,
  fakeToken,
  jsonResponse,
  memoryStore,
  REVOKE_URL,
  signingKey,
  TEST_CLIENT_ID,
  testSession,
} from "../fixtures/fake-openai.ts";
import { tempRoot, testPaths } from "../helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function paths() {
  const r = tempRoot();
  roots.push(r);
  return testPaths(r);
}

const HOST = "urn:uuid:3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const ALL_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

describe("authorize URL", () => {
  test("first sign-in registers with dynamic_agent_client and sapi's name; PKCE is S256", async () => {
    const { verifier, challenge } = await pkcePair();
    const url = new URL(
      authorizeUrl({
        issuedClientId: null,
        hostId: HOST,
        redirectUri: "http://127.0.0.1:54321/auth/callback",
        state: "s1",
        nonce: "n1",
        challenge,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    const q = Object.fromEntries(url.searchParams);
    expect(q).toEqual({
      client_id: REGISTRATION_CLIENT_ID,
      agent_name_hint: "sapi",
      ext_agent_host_id: HOST,
      response_type: "code",
      redirect_uri: "http://127.0.0.1:54321/auth/callback",
      scope: ALL_SCOPES,
      resource: "https://api.openai.com/v1",
      state: "s1",
      nonce: "n1",
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(Buffer.from(digest).toString("base64url")).toBe(challenge);
    expect(challenge).not.toContain("=");
    expect(url.search).not.toContain("+"); // spaces as %20
  });

  test("returning sign-ins use the issued client ID and no name hint", () => {
    const q = new URL(
      authorizeUrl({
        issuedClientId: TEST_CLIENT_ID,
        hostId: HOST,
        redirectUri: "http://127.0.0.1:1/auth/callback",
        state: "s",
        nonce: "n",
        challenge: "c",
      }),
    ).searchParams;
    expect(q.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(q.has("agent_name_hint")).toBe(false);
    expect(q.get("ext_agent_host_id")).toBe(HOST);
  });

  test("refuses a malformed host or client ID", () => {
    const base = { redirectUri: "http://127.0.0.1:1/auth/callback", state: "s", nonce: "n", challenge: "c" };
    expect(() => authorizeUrl({ ...base, issuedClientId: null, hostId: "me@example.com" })).toThrow();
    expect(() => authorizeUrl({ ...base, issuedClientId: "evil&x=1", hostId: HOST })).toThrow();
  });

  test("the host ID is a persisted urn:uuid, created once", () => {
    const p = paths();
    const a = loadOrCreateHost(p);
    expect(a.ext_agent_host_id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(loadOrCreateHost(p).ext_agent_host_id).toBe(a.ext_agent_host_id);
    expect(statSync(hostFilePath(p)).mode & 0o777).toBe(0o600);
  });
});

describe("token endpoint", () => {
  test("code exchange and refresh send exactly the documented form fields", async () => {
    const up = fakeOpenAi();
    await exchangeCode(up.fetch, {
      clientId: TEST_CLIENT_ID,
      code: "the-code",
      verifier: "the-verifier",
      redirectUri: "http://127.0.0.1:9/auth/callback",
    });
    await refreshTokens(up.fetch, { clientId: TEST_CLIENT_ID, refreshToken: fakeToken("refresh") });
    const [a, b] = up.calls.map((c) => ({
      method: c.method,
      type: c.headers["content-type"],
      form: Object.fromEntries(new URLSearchParams(c.body)),
    }));
    expect(a).toEqual({
      method: "POST",
      type: "application/x-www-form-urlencoded",
      form: {
        grant_type: "authorization_code",
        client_id: TEST_CLIENT_ID,
        code: "the-code",
        code_verifier: "the-verifier",
        redirect_uri: "http://127.0.0.1:9/auth/callback",
        resource: "https://api.openai.com/v1",
      },
    });
    expect(b!.form).toEqual({
      grant_type: "refresh_token",
      client_id: TEST_CLIENT_ID,
      refresh_token: fakeToken("refresh"),
      resource: "https://api.openai.com/v1",
    });
    expect(b!.form).not.toHaveProperty("scope");
  });

  test("errors keep only a sanitised code: no token, no description", async () => {
    const leak = fakeToken("leak");
    const up = fakeOpenAi({
      token: () => jsonResponse({ error: "refresh_token_reused", error_description: leak }, 400),
    });
    const e = (await refreshTokens(up.fetch, { clientId: TEST_CLIENT_ID, refreshToken: leak }).catch(
      (x) => x,
    )) as OAuthError;
    expect(e).toBeInstanceOf(OAuthError);
    expect(e.code).toBe("refresh_token_reused");
    expect(e.terminal).toBe(true);
    expect(e.message).not.toContain(leak);
    const net = fakeOpenAi({ token: () => jsonResponse({ error: "temporarily_unavailable" }, 503) });
    const e2 = (await refreshTokens(net.fetch, { clientId: TEST_CLIENT_ID, refreshToken: leak }).catch(
      (x) => x,
    )) as OAuthError;
    expect(e2.terminal).toBe(false);
  });

  test("an unexpected token type or shape is refused", async () => {
    const up = fakeOpenAi({
      token: () => jsonResponse({ access_token: fakeToken("a"), token_type: "mac", expires_in: 60 }),
    });
    await expect(refreshTokens(up.fetch, { clientId: TEST_CLIENT_ID, refreshToken: fakeToken("r") })).rejects.toThrow(
      /unexpected token type/,
    );
    const bad = fakeOpenAi({ token: () => jsonResponse({ nope: true }) });
    await expect(refreshTokens(bad.fetch, { clientId: TEST_CLIENT_ID, refreshToken: fakeToken("r") })).rejects.toThrow(
      /unexpected answer/,
    );
  });
});

describe("ID token", () => {
  const now = Date.now();
  const good = {
    iss: "https://auth.openai.com",
    aud: TEST_CLIENT_ID,
    sub: "user-1",
    exp: Math.floor(now / 1000) + 600,
    iat: Math.floor(now / 1000),
    nonce: "n-123",
  };

  test("a correctly signed token for this client and nonce is accepted", async () => {
    const k = await signingKey();
    const up = fakeOpenAi({}, k.jwks);
    expect(
      await verifyIdToken(up.fetch, await k.sign(good), { clientId: TEST_CLIENT_ID, nonce: "n-123", now }),
    ).toEqual({ subject: "user-1" });
  });

  test.each([
    ["issuer", { iss: "https://evil.example" }],
    ["audience", { aud: "oaiapp_SOMEONEELSE" }],
    ["expired", { exp: Math.floor(now / 1000) - 3600 }],
    ["nonce", { nonce: "other" }],
    ["nonce", { nonce: undefined }],
  ])("refused: %s", async (why, patch) => {
    const k = await signingKey();
    const up = fakeOpenAi({}, k.jwks);
    const token = await k.sign({ ...good, ...patch });
    await expect(verifyIdToken(up.fetch, token, { clientId: TEST_CLIENT_ID, nonce: "n-123", now })).rejects.toThrow(
      why,
    );
  });

  test("refused: a signature from another key, alg none, or tampered claims", async () => {
    const k = await signingKey();
    const other = await signingKey();
    const up = fakeOpenAi({}, k.jwks);
    const o = { clientId: TEST_CLIENT_ID, nonce: "n-123", now };
    await expect(verifyIdToken(up.fetch, await other.sign(good), o)).rejects.toThrow("signature");
    await expect(verifyIdToken(up.fetch, await k.sign(good, { alg: "none" }), o)).rejects.toThrow("algorithm");
    const [h, , s] = (await k.sign(good)).split(".");
    const forged = Buffer.from(JSON.stringify({ ...good, sub: "admin" })).toString("base64url");
    await expect(verifyIdToken(up.fetch, `${h}.${forged}.${s}`, o)).rejects.toThrow("signature");
  });

  test("signing keys are fetched only from the sign-in server", async () => {
    const k = await signingKey();
    const up = fakeOpenAi({}, k.jwks);
    const evil = async (url: string, init?: Parameters<typeof up.fetch>[1]) =>
      url.endsWith("openid-configuration")
        ? jsonResponse({ issuer: "https://auth.openai.com", jwks_uri: "https://attacker.example/jwks.json" })
        : up.fetch(url, init);
    await expect(
      verifyIdToken(evil, await k.sign(good), { clientId: TEST_CLIENT_ID, nonce: "n-123", now }),
    ).rejects.toThrow(/discovery/);
    expect(up.calls.some((c) => c.url.includes("attacker"))).toBe(false);
  });
});

describe("callback listener", () => {
  test("ignores wrong Host, path or state; accepts one callback; the page echoes nothing", async () => {
    const cb = await startCallbackServer({ state: "right-state", timeoutMs: 10_000 });
    try {
      expect(cb.redirectUri).toBe(`http://127.0.0.1:${cb.port}/auth/callback`);
      const base = `http://127.0.0.1:${cb.port}`;
      expect((await fetch(`${base}/other?code=x&state=right-state`)).status).toBe(404);
      expect(
        (await fetch(`${base}/auth/callback?code=x&state=right-state`, { headers: { host: "evil.example" } })).status,
      ).toBe(404);
      expect((await fetch(`${base}/auth/callback?code=x&state=wrong`)).status).toBe(400);
      const marker = "CODE<script>MARKER";
      const ok = await fetch(
        `${base}/auth/callback?code=${encodeURIComponent(marker)}&state=right-state&scope=${encodeURIComponent(ALL_SCOPES)}&client_id=${TEST_CLIENT_ID}`,
      );
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await ok.text()).not.toContain("MARKER");
      expect(await cb.result).toEqual({ code: marker, scopes: ALL_SCOPES.split(" "), clientId: TEST_CLIENT_ID });
      expect(await (await fetch(`${base}/auth/callback?code=y&state=right-state`)).text()).toContain("Already done");
    } finally {
      cb.stop();
    }
  });

  test("a cancelled sign-in rejects without a code", async () => {
    const cb = await startCallbackServer({ state: "st", timeoutMs: 10_000 });
    try {
      const done = cb.result.catch((e) => e);
      await fetch(`http://127.0.0.1:${cb.port}/auth/callback?error=access_denied&state=st`);
      expect(((await done) as OAuthError).code).toBe("access_denied");
    } finally {
      cb.stop();
    }
  });
});

/** A browser that approves at once: follows the redirect with a code, like OpenAI would. */
function approvingBrowser(o: { scope?: string; clientId?: string | null } = {}) {
  const seen: { nonce?: string; url?: URL } = {};
  const open = (link: string) => {
    const url = new URL(link);
    seen.url = url;
    seen.nonce = url.searchParams.get("nonce")!;
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "auth-code-1");
    back.searchParams.set("state", url.searchParams.get("state")!);
    back.searchParams.set("scope", o.scope ?? ALL_SCOPES);
    if (o.clientId !== null) back.searchParams.set("client_id", o.clientId ?? TEST_CLIENT_ID);
    setTimeout(() => void fetch(back).then((r) => r.text()), 5);
    return true;
  };
  return { open, seen };
}

async function signInServer(scope = ALL_SCOPES) {
  const k = await signingKey();
  const browser = approvingBrowser();
  const up = fakeOpenAi(
    {
      token: async (form) =>
        jsonResponse({
          access_token: fakeToken("access", 1),
          refresh_token: fakeToken("refresh", 1),
          id_token: await k.sign({
            iss: "https://auth.openai.com",
            aud: form.get("client_id"),
            sub: "user-9",
            exp: Math.floor(Date.now() / 1000) + 600,
            nonce: browser.seen.nonce,
          }),
          token_type: "Bearer",
          expires_in: 3600,
          scope,
        }),
    },
    k.jwks,
  );
  return { up, browser };
}

describe("desktop sign-in, end to end against a fake OpenAI", () => {
  test("registers, saves the issued client ID, verifies the ID token and stores the session", async () => {
    const p = paths();
    const store = memoryStore();
    const { up, browser } = await signInServer();
    const lines: string[] = [];
    const r = await loginChatGpt({
      paths: p,
      fetch: up.fetch,
      store,
      open: browser.open,
      print: (l) => lines.push(l),
      timeoutMs: 10_000,
    });
    expect(browser.seen.url!.searchParams.get("client_id")).toBe(REGISTRATION_CLIENT_ID);
    expect(JSON.parse(readFileSync(hostFilePath(p), "utf8")).client_id).toBe(TEST_CLIENT_ID);
    const saved = parseSession(store.data.get(SESSION_SECRET) ?? null)!;
    expect(saved.client_id).toBe(TEST_CLIENT_ID);
    expect(saved.subject).toBe("user-9");
    expect(saved.access_token).toBe(fakeToken("access", 1));
    expect(r.models.map((m) => m.slug)).toEqual(["gpt-test-1"]);
    // The exchange used the issued ID, not the registration entry point.
    const tokenCall = up.calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect(new URLSearchParams(tokenCall.body).get("client_id")).toBe(TEST_CLIENT_ID);
    // Nothing printed contains a token.
    expect(lines.join("\n")).not.toContain(fakeToken("access", 1));
    expect(lines.join("\n")).not.toContain(fakeToken("refresh", 1));

    // The next sign-in reuses the issued client ID.
    const again = await signInServer();
    await loginChatGpt({
      paths: p,
      fetch: again.up.fetch,
      store,
      open: again.browser.open,
      print: () => {},
      timeoutMs: 10_000,
    });
    expect(again.browser.seen.url!.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(again.browser.seen.url!.searchParams.has("agent_name_hint")).toBe(false);
  });

  test("a declined plan-usage scope is refused and nothing is stored", async () => {
    const store = memoryStore();
    const { up, browser } = await signInServer("openid profile email offline_access");
    const err = await loginChatGpt({
      paths: paths(),
      fetch: up.fetch,
      store,
      open: browser.open,
      print: () => {},
      timeoutMs: 10_000,
    }).catch((e) => e);
    expect((err as Error).message).toContain("chatgpt.tokens.use.direct");
    expect(store.data.size).toBe(0);
  });

  test("--ssh prints the tunnel and the link, and opens no browser", async () => {
    const { up, browser } = await signInServer();
    const lines: string[] = [];
    let opened = false;
    const print = (l: string) => {
      lines.push(l);
      const m = /^\s+(https:\/\/auth\.openai\.com\S+)$/.exec(l);
      if (m) browser.open(m[1]!);
    };
    await loginChatGpt({
      paths: paths(),
      fetch: up.fetch,
      store: memoryStore(),
      ssh: true,
      open: () => (opened = true),
      print,
      sshTarget: "me@vm",
      timeoutMs: 10_000,
    });
    expect(opened).toBe(false);
    expect(lines.some((l) => /ssh -N -L (\d+):127\.0\.0\.1:\1 me@vm/.test(l))).toBe(true);
  });

  test("--export keeps nothing locally; --import on the VM keeps the VM's own host ID", async () => {
    const laptop = paths();
    const { up, browser } = await signInServer();
    const { session } = await loginChatGpt({
      paths: laptop,
      fetch: up.fetch,
      store: null,
      open: browser.open,
      print: () => {},
      timeoutMs: 10_000,
    });
    const vm = paths();
    const vmHost = loadOrCreateHost(vm).ext_agent_host_id;
    const vmStore = memoryStore();
    await importSignIn({ paths: vm, store: vmStore, text: exportText(session) });
    expect(parseSession(vmStore.data.get(SESSION_SECRET) ?? null)?.refresh_token).toBe(session.refresh_token);
    const host = JSON.parse(readFileSync(hostFilePath(vm), "utf8"));
    expect(host).toEqual({ ext_agent_host_id: vmHost, client_id: TEST_CLIENT_ID });
    expect(host.ext_agent_host_id).not.toBe(loadOrCreateHost(laptop).ext_agent_host_id);
    await expect(importSignIn({ paths: vm, store: vmStore, text: '{"format":"other"}' })).rejects.toThrow(
      /isn't a sapi/,
    );
  });
});

describe("sign-out", () => {
  test("revokes the refresh token at the discovered endpoint, then deletes the sign-in", async () => {
    const store = memoryStore({ [SESSION_SECRET]: JSON.stringify(testSession()) });
    const up = fakeOpenAi();
    expect(await logoutChatGpt({ store, fetch: up.fetch })).toEqual({ hadSession: true, revoked: true });
    const call = up.calls.find((c) => c.url === REVOKE_URL)!;
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      token: fakeToken("refresh"),
      token_type_hint: "refresh_token",
      client_id: TEST_CLIENT_ID,
    });
    expect(store.data.size).toBe(0);
  });

  test("deletes locally even when OpenAI doesn't confirm, and says so", async () => {
    const store = memoryStore({ [SESSION_SECRET]: JSON.stringify(testSession()) });
    const up = fakeOpenAi({ revoke: () => new Response("", { status: 503 }) });
    expect(await logoutChatGpt({ store, fetch: up.fetch, delaysMs: [1, 1] })).toEqual({
      hadSession: true,
      revoked: false,
    });
    expect(up.calls.filter((c) => c.url === REVOKE_URL)).toHaveLength(3);
    expect(store.data.size).toBe(0);
    expect(
      await revokeRefreshToken(fakeOpenAi({ revoke: () => new Response("", { status: 400 }) }).fetch, {
        clientId: TEST_CLIENT_ID,
        refreshToken: "x".repeat(20),
      }),
    ).toBe(false);
  });

  test("nothing to sign out of", async () => {
    expect(await logoutChatGpt({ store: memoryStore(), fetch: fakeOpenAi().fetch })).toEqual({
      hadSession: false,
      revoked: false,
    });
  });
});
