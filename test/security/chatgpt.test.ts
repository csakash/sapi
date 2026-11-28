/**
 * ARI-42 security evals for the ChatGPT provider, through a real gateway with a fake OpenAI
 * behind the adapter:
 *
 *   AUTH-2  identity only from the sapi key: the caller's key, headers and `user`/`metadata` never
 *           reach OpenAI, and the ChatGPT token goes only to api.openai.com.
 *   GW-1    the ChatGPT token never shows up in a response, an error, the request log, the event
 *           log or sapi's own log lines.
 *   DATA-3  every upstream call has store:false (and stream:true).
 *   INJ-4   sapi's own outbound calls are https to the manifest's hosts only, through a proxy with
 *           that allowlist, with redirects refused; the Claude child's proxy can't reach OpenAI.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertAllowedUrl, guardedFetch } from "../../src/egress-fetch.ts";
import { ChatGptAdapter } from "../../src/providers/chatgpt-sub/adapter.ts";
import { chatgptManifest, RESPONSES_URL } from "../../src/providers/chatgpt-sub/manifest.ts";
import { ChatGptAuth, SESSION_SECRET } from "../../src/providers/chatgpt-sub/session.ts";
import { fakeOpenAi, fakeToken, memoryStore, testSession } from "../fixtures/fake-openai.ts";
import { bearer, jsonOf, startTestGateway, TEST_MODELS, type TestGateway } from "../helpers.ts";

let gw: TestGateway;
let key: string;
const up = fakeOpenAi();
const store = memoryStore({ [SESSION_SECRET]: JSON.stringify(testSession()) });
const TOKEN = fakeToken("access");
const logLines: string[] = [];
const origWrite = process.stderr.write.bind(process.stderr);

beforeAll(async () => {
  const auth = new ChatGptAuth({ openStore: async () => store, fetch: up.fetch, onEvent: () => {} });
  gw = await startTestGateway({
    config: { models: { ...TEST_MODELS, gpt: { provider: "chatgpt-sub", model: "gpt-test-1" } } },
    start: { adapters: { "chatgpt-sub": new ChatGptAdapter({ auth, fetch: up.fetch }) } },
  });
  key = gw.addClient("app");
  // Capture everything sapi logs (its log lines go to stderr) while requests run.
  process.env.SAPI_LOG = "info";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});
afterAll(async () => {
  process.stderr.write = origWrite;
  process.env.SAPI_LOG = "off";
  await gw.cleanup();
});

const body = {
  model: "gpt",
  messages: [
    { role: "system", content: "sys prompt" },
    { role: "user", content: "hello" },
  ],
  user: "someone@example.com",
  metadata: { tenant: "tenant-canary-77" },
  temperature: 0.1,
};

describe("ChatGPT through the gateway", () => {
  test("three doors, streamed and not, all reach ChatGPT and come back in the caller's format", async () => {
    const h = { ...bearer(key), "x-custom-header": "should-not-leak" };
    const chat = await jsonOf(await gw.post("/v1/chat/completions", body, h));
    expect(chat.choices[0].message.content).toBe("chatgpt: hello");
    const resp = await jsonOf(await gw.post("/v1/responses", { model: "gpt", instructions: "sys", input: "hello" }, h));
    expect(resp.output[0].content[0].text).toBe("chatgpt: hello");
    const msg = await jsonOf(
      await gw.post(
        "/v1/messages",
        { model: "gpt", max_tokens: 50, messages: [{ role: "user", content: "hello" }] },
        {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
      ),
    );
    expect(msg.content[0].text).toBe("chatgpt: hello");
    const streamed = await (await gw.post("/v1/chat/completions", { ...body, stream: true }, h)).text();
    expect(streamed).toContain("data: [DONE]");
  });

  test("AUTH-2 / DATA-3: only sapi's own body goes upstream, with store:false and no caller identity", () => {
    const sent = up.calls.filter((c) => c.url === RESPONSES_URL);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    for (const c of sent) {
      const b = JSON.parse(c.body!);
      expect(b.store).toBe(false);
      expect(b.stream).toBe(true);
      expect(Object.keys(b).sort()).toEqual(expect.arrayContaining(["input", "model", "store", "stream"]));
      for (const k of ["user", "metadata", "temperature", "previous_response_id", "max_output_tokens", "top_p"])
        expect(b).not.toHaveProperty(k);
      expect(Object.keys(c.headers).sort()).toEqual(["accept", "authorization", "content-type", "user-agent"]);
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const all = JSON.stringify(c);
      expect(all).not.toContain(key);
      expect(all).not.toContain("should-not-leak");
      expect(all).not.toContain("someone@example.com");
      expect(all).not.toContain("tenant-canary-77");
    }
    // The ChatGPT token only ever went to OpenAI's API host.
    for (const c of up.calls)
      if (JSON.stringify(c).includes(TOKEN)) expect(new URL(c.url).hostname).toBe("api.openai.com");
  });

  test("GW-1: the ChatGPT token never appears in responses, errors, the logs or the database", async () => {
    const r1 = await gw.post("/v1/chat/completions", { ...body, model: "nope" }, bearer(key));
    const r2 = await gw.post("/v1/responses", { model: "gpt", input: [{ type: "input_image" }] }, bearer(key));
    const texts = [await r1.text(), await r2.text()];
    const rows = gw.db.query("SELECT * FROM requests").all();
    const events = gw.db.query("SELECT * FROM events").all();
    const haystack = [...texts, JSON.stringify(rows), JSON.stringify(events), logLines.join("\n")].join("\n");
    expect(haystack).not.toContain(TOKEN);
    expect(haystack).not.toContain(fakeToken("refresh"));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // Every metered row names the door and the provider, nothing about content.
    const doors = new Set((rows as Array<{ door: string }>).map((r) => r.door));
    expect(doors).toEqual(new Set(["chat", "responses", "messages"]));
  });
});

describe("INJ-4: sapi's own outbound calls", () => {
  const allow = new Set(chatgptManifest.egressHosts);
  test.each([
    "http://api.openai.com/v1/responses",
    "https://api.openai.com:8443/v1/responses",
    "https://user:pw@api.openai.com/v1/responses",
    "https://chatgpt.com/backend-api/codex/responses",
    "https://169.254.169.254/latest/meta-data",
    "https://api.openai.com.evil.example/v1",
    "not a url",
  ])("refused: %s", (url) => {
    expect(() => assertAllowedUrl(url, allow)).toThrow(/egress rules refused/);
  });

  test("allowed calls go through the proxy with redirects refused", async () => {
    const seen: Array<{ url: string; init: RequestInit & { proxy?: string } }> = [];
    const f = guardedFetch(chatgptManifest.egressHosts, "http://127.0.0.1:1", async (url, init) => {
      seen.push({ url, init });
      return new Response("ok");
    });
    await f("https://auth.openai.com/.well-known/openid-configuration");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(seen[0]!.init.proxy).toBe("http://127.0.0.1:1");
    await expect(f("https://example.com/")).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  test("the ChatGPT proxy allows exactly OpenAI's two hosts, and the Claude child's proxy neither", () => {
    expect(gw.chatgptProxy.allowlist).toEqual(["api.openai.com", "auth.openai.com"]);
    expect(gw.proxy.allowlist.some((h) => h.includes("openai"))).toBe(false);
  });
});
