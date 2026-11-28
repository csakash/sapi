/**
 * The ChatGPT adapter and its token handling, against a fake OpenAI: the exact upstream body,
 * stream translation, usage, every error path, the usage-limit pause, and refresh (serialised,
 * re-reading the store, clearing only on terminal errors).
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent, CanonicalRequest } from "../../src/canonical.ts";
import { GatewayError } from "../../src/canonical.ts";
import { ChatGptAdapter, mapHttpError, responsesBody } from "../../src/providers/chatgpt-sub/adapter.ts";
import { RESPONSES_URL } from "../../src/providers/chatgpt-sub/manifest.ts";
import { ChatGptAuth, parseSession, SESSION_SECRET } from "../../src/providers/chatgpt-sub/session.ts";
import {
  fakeOpenAi,
  fakeToken,
  jsonResponse,
  memoryStore,
  sseFrame,
  sseResponse,
  testSession,
  type Upstream,
} from "../fixtures/fake-openai.ts";

const req = (o: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  id: "req_test",
  clientId: "cli_test",
  door: "chat",
  alias: "gpt",
  provider: "chatgpt-sub",
  model: "gpt-test-1",
  messages: [
    { role: "user", text: "first" },
    { role: "assistant", text: "ok" },
    { role: "user", text: "hello" },
  ],
  stream: true,
  ignoredParams: ["temperature", "user"],
  ...o,
});

function setup(up: Upstream = {}, session = testSession(), o: { now?: () => number } = {}) {
  const fake = fakeOpenAi(up);
  const store = memoryStore({ [SESSION_SECRET]: JSON.stringify(session) });
  const auth = new ChatGptAuth({ openStore: async () => store, fetch: fake.fetch, ...(o.now ? { now: o.now } : {}) });
  const adapter = new ChatGptAdapter({
    auth,
    fetch: fake.fetch,
    retryDelaysMs: [1, 1],
    usagePauseMs: 60_000,
    ...(o.now ? { now: o.now } : {}),
  });
  return { fake, store, auth, adapter };
}

async function collect(a: ChatGptAdapter, r = req()): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const ev of a.send(r, new AbortController().signal)) out.push(ev);
  return out;
}

describe("the upstream body", () => {
  test("store:false and stream:true always; system → instructions; nothing else is sent", () => {
    expect(responsesBody(req({ system: "be brief", stream: false }))).toEqual({
      model: "gpt-test-1",
      instructions: "be brief",
      input: [
        { type: "message", role: "user", content: "first" },
        { type: "message", role: "assistant", content: "ok" },
        { type: "message", role: "user", content: "hello" },
      ],
      store: false,
      stream: true,
    });
    expect(responsesBody(req())).not.toHaveProperty("instructions");
  });

  test("a model ID that isn't plain is refused before anything is sent", () => {
    expect(() => responsesBody(req({ model: "--flag" }))).toThrow(GatewayError);
  });
});

describe("streaming", () => {
  test("text deltas, usage (cached and reasoning split out) and done", async () => {
    const { adapter, fake } = setup();
    const evs = await collect(adapter);
    expect(evs[0]).toEqual({ type: "start", providerModel: "gpt-test-1" });
    expect(
      evs
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("chatgpt: hello");
    expect(evs.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { input: 10, output: 7, cacheRead: 2, cacheWrite: 0, reasoning: 3 },
    });
    expect(evs[evs.length - 1]).toEqual({ type: "done", finish: "stop" });
    const call = fake.calls.find((c) => c.url === RESPONSES_URL)!;
    expect(call.headers.authorization).toBe(`Bearer ${fakeToken("access")}`);
    expect(Object.keys(call.headers).sort()).toEqual(["accept", "authorization", "content-type", "user-agent"]);
  });

  test("a stream that ends without response.completed is an error, not a short answer", async () => {
    const { adapter } = setup({
      responses: () => sseResponse([sseFrame({ type: "response.output_text.delta", delta: "partial" })]),
    });
    await expect(collect(adapter)).rejects.toThrow(/ended before the response completed/);
  });

  test("response.incomplete finishes with length", async () => {
    const { adapter } = setup({
      responses: () =>
        sseResponse([
          sseFrame({ type: "response.output_text.delta", delta: "x" }),
          sseFrame({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }),
        ]),
    });
    const evs = await collect(adapter);
    expect(evs[evs.length - 1]).toEqual({ type: "done", finish: "length" });
  });

  test("unknown events and junk lines are dropped", async () => {
    const { adapter } = setup({
      responses: () =>
        sseResponse([
          "data: not json\n\n",
          sseFrame({ type: "response.reasoning_summary_text.delta", delta: "secret thoughts" }),
          sseFrame({ type: "response.output_text.delta", delta: "hi" }),
          sseFrame({ type: "response.completed", response: {} }),
        ]),
    });
    const text = (await collect(adapter)).filter((e) => e.type === "text");
    expect(text).toEqual([{ type: "text", delta: "hi" }]);
  });

  test("an oversized upstream event is refused", async () => {
    const big = `data: ${"x".repeat(1100 * 1024)}\n\n`;
    const { adapter } = setup({ responses: () => sseResponse([big]) });
    await expect(collect(adapter)).rejects.toThrow(/oversized/);
  });
});

describe("errors never pass OpenAI's text through", () => {
  const CANARY = "UPSTREAM-SAYS-SECRET-THING";
  test.each([
    [401, "subscription_sharing_invalid_user", "provider_not_ready"],
    [403, "subscription_sharing_user_not_eligible", "provider_not_ready"],
    [403, "chatpass_v2_scope_not_authorized", "provider_not_ready"],
    [403, "subscription_sharing_route_not_supported", "upstream_error"],
    [400, "subscription_sharing_unsupported_capability", "bad_request"],
    [429, "rate_limit_exceeded", "provider_window_exhausted"],
    [503, "subscription_sharing_usage_unavailable", "provider_not_ready"],
    [500, "server_error", "upstream_error"],
  ])("HTTP %i %s → %s", (status, code, kind) => {
    const m = mapHttpError(status, { error: { code, message: CANARY, param: "input[0]" } }, null);
    expect(m.error.kind).toBe(kind as never);
    expect(m.error.message).not.toContain(CANARY);
  });

  test("a {detail} body before the stream opens is mapped by status", () => {
    expect(mapHttpError(401, { detail: CANARY }, null).error.kind).toBe("provider_not_ready");
    expect(mapHttpError(503, { detail: CANARY }, "7").error.retryAfterSec).toBe(7);
  });

  test("a 401 refreshes once and retries; a second 401 stops", async () => {
    const { adapter, fake } = setup({
      responses: (_b, n) =>
        n === 0
          ? jsonResponse({ detail: "no" }, 401)
          : sseResponse([sseFrame({ type: "response.completed", response: {} })]),
    });
    await collect(adapter);
    expect(fake.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
    const twice = setup({ responses: () => jsonResponse({ detail: "no" }, 401) });
    await expect(collect(twice.adapter)).rejects.toThrow(/didn't accept sapi's sign-in/);
    expect(twice.fake.calls.filter((c) => c.url === RESPONSES_URL)).toHaveLength(2);
  });

  test("503 before any output is retried a bounded number of times", async () => {
    const { adapter, fake } = setup({ responses: () => jsonResponse({ detail: "busy" }, 503) });
    await expect(collect(adapter)).rejects.toThrow(/temporarily unavailable/);
    expect(fake.calls.filter((c) => c.url === RESPONSES_URL)).toHaveLength(3);
  });
});

describe("usage limit", () => {
  test("a 429 usage limit pauses ChatGPT, reports the window as full, then reopens", async () => {
    let now = 1_000_000;
    const { adapter, fake } = setup(
      { responses: () => jsonResponse({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, 429) },
      testSession({}, now),
      { now: () => now },
    );
    const e = (await collect(adapter).catch((x) => x)) as GatewayError;
    expect(e.kind).toBe("provider_window_exhausted");
    expect(e.message).toContain("https://chatgpt.com/settings/usage");
    expect(adapter.limits()).toEqual([{ window: "5h", usedPct: 100, source: "estimated" }]);
    expect(() => adapter.assertWindowOpen(now)).toThrow(GatewayError);
    // Paused requests don't even reach OpenAI.
    const before = fake.calls.length;
    await expect(collect(adapter)).rejects.toThrow(/usage limit/);
    expect(fake.calls.length).toBe(before);
    now += 61_000;
    expect(adapter.limits()).toEqual([]);
    expect(() => adapter.assertWindowOpen(now)).not.toThrow();
  });

  test("the same limit arriving mid-stream as response.failed also pauses", async () => {
    const { adapter } = setup({
      responses: () =>
        sseResponse([
          sseFrame({ type: "response.output_text.delta", delta: "a" }),
          sseFrame({
            type: "response.failed",
            response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "x" } },
          }),
        ]),
    });
    await expect(collect(adapter)).rejects.toThrow(/usage limit/);
    expect(adapter.limits()[0]?.usedPct).toBe(100);
  });
});

describe("token refresh", () => {
  test("a token about to expire is refreshed first, and the rotated refresh token is saved", async () => {
    const now = Date.now();
    const { adapter, store, fake } = setup({}, testSession({ expires_at: now + 30_000 }, now));
    await collect(adapter);
    const saved = parseSession(store.data.get(SESSION_SECRET) ?? null)!;
    expect(saved.refresh_token).toBe(fakeToken("refresh", 1));
    expect(saved.access_token).toBe(fakeToken("access", 1));
    expect(fake.calls.find((c) => c.url === RESPONSES_URL)!.headers.authorization).toBe(
      `Bearer ${fakeToken("access", 1)}`,
    );
  });

  test("concurrent requests share one refresh", async () => {
    const now = Date.now();
    const { auth, fake } = setup({}, testSession({ expires_at: now + 1000 }, now));
    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(fake.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  test("a newer sign-in saved by `sapi login` meanwhile is used, not overwritten", async () => {
    const now = Date.now();
    const old = testSession({ expires_at: now + 1000 }, now);
    const { auth, store, fake } = setup({}, old);
    const s = await auth.load();
    store.data.set(
      SESSION_SECRET,
      JSON.stringify(
        testSession({ refresh_token: fakeToken("refresh", 99), access_token: fakeToken("access", 99) }, now),
      ),
    );
    // Force the refresh path with the session read before the new login.
    expect(
      await (auth as unknown as { refresh: (x: unknown) => Promise<{ access_token: string }> })
        .refresh(s)
        .then((x) => x.access_token),
    ).toBe(fakeToken("access", 99));
    expect(fake.calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(0);
  });

  test("a terminal refresh error clears the sign-in; a network failure keeps it", async () => {
    const now = Date.now();
    const dead = setup(
      { token: () => jsonResponse({ error: "refresh_token_reused" }, 400) },
      testSession({ expires_at: now - 1 }, now),
    );
    await expect(dead.auth.accessToken()).rejects.toThrow(/sign-in ended/);
    expect(dead.store.data.has(SESSION_SECRET)).toBe(false);
    const flaky = setup(
      { token: () => jsonResponse({ error: "temporarily_unavailable" }, 503) },
      testSession({ expires_at: now - 1 }, now),
    );
    await expect(flaky.auth.accessToken()).rejects.toThrow(/couldn't refresh/);
    expect(flaky.store.data.has(SESSION_SECRET)).toBe(true);
  });

  test("not signed in, lapsed after 30 idle days, or missing scopes: not ready, with the fix", async () => {
    const empty = new ChatGptAdapter({
      auth: new ChatGptAuth({ openStore: async () => memoryStore(), fetch: fakeOpenAi().fetch }),
      fetch: fakeOpenAi().fetch,
    });
    expect(await empty.checkReady()).toEqual({
      ready: false,
      reason: "not signed in to ChatGPT",
      fix: "sapi login chatgpt",
    });
    const now = Date.now();
    const lapsed = setup({}, testSession({ refreshed_at: now - 31 * 86_400_000 }, now));
    expect((await lapsed.adapter.checkReady()).ready).toBe(false);
    const scopes = setup({}, testSession({ scopes: ["openid", "offline_access"] }, now));
    expect(await scopes.adapter.checkReady()).toMatchObject({
      ready: false,
      reason: expect.stringContaining("chatgpt.tokens.use.direct"),
    });
    expect((await setup().adapter.checkReady()).ready).toBe(true);
  });
});
