/**
 * Contract tests for the Phase 3 doors (plan §19): real SDKs against sapi, for both kinds of
 * provider behind the gateway: the fake provider, and the ChatGPT adapter on a fake OpenAI.
 *
 *   openai-node     Responses API (`/v1/responses`), streamed and not
 *   anthropic-sdk   Messages API (`/v1/messages`), streamed and not
 *   openai-python   Responses API, when `python3 -c "import openai"` works
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ChatGptAdapter } from "../../src/providers/chatgpt-sub/adapter.ts";
import { ChatGptAuth, SESSION_SECRET } from "../../src/providers/chatgpt-sub/session.ts";
import { fakeOpenAi, memoryStore, testSession } from "../fixtures/fake-openai.ts";
import { startTestGateway, TEST_MODELS, type TestGateway } from "../helpers.ts";

let gw: TestGateway;
let key: string;
let root: string;

beforeAll(async () => {
  const up = fakeOpenAi();
  const store = memoryStore({ [SESSION_SECRET]: JSON.stringify(testSession()) });
  const auth = new ChatGptAuth({ openStore: async () => store, fetch: up.fetch });
  gw = await startTestGateway({
    config: { models: { ...TEST_MODELS, gpt: { provider: "chatgpt-sub", model: "gpt-test-1" } } },
    start: { adapters: { "chatgpt-sub": new ChatGptAdapter({ auth, fetch: up.fetch }) } },
  });
  key = gw.addClient("sdk-doors");
  root = `http://127.0.0.1:${gw.server.port}`;
});
afterAll(() => gw.cleanup());

/** Each provider and what it answers to "hello". */
const PROVIDERS: Array<[string, string, string]> = [
  ["fake provider", "echo", "echo: hello"],
  ["ChatGPT (fake OpenAI)", "gpt", "chatgpt: hello"],
];

describe.each(PROVIDERS)("openai-node Responses → %s", (_name, model, answer) => {
  const client = () => new OpenAI({ apiKey: key, baseURL: `${root}/v1`, maxRetries: 0 });

  test("non-streamed", async () => {
    const r = await client().responses.create({ model, instructions: "be brief", input: "hello", temperature: 0.3 });
    expect(r.output_text).toBe(answer);
    expect(r.status).toBe("completed");
    expect(r.usage?.output_tokens).toBeGreaterThan(0);
  });

  test("streamed, with the final response", async () => {
    const stream = client().responses.stream({ model, input: [{ role: "user", content: "hello" }] });
    let text = "";
    for await (const ev of stream) if (ev.type === "response.output_text.delta") text += ev.delta;
    const final = await stream.finalResponse();
    expect(text).toBe(answer);
    expect(final.output_text).toBe(answer);
  });

  test("a stateless refusal comes back as an SDK error with sapi's kind", async () => {
    const e = (await client()
      .responses.create({ model, input: "hello", previous_response_id: "resp_x" })
      .then(
        () => null,
        (x) => x,
      )) as InstanceType<typeof OpenAI.APIError>;
    expect(e).toBeInstanceOf(OpenAI.BadRequestError);
    expect((e.error as { sapi_error_kind?: string }).sapi_error_kind).toBe("bad_request");
  });
});

describe.each(PROVIDERS)("anthropic-sdk Messages → %s", (_name, model, answer) => {
  const client = () => new Anthropic({ apiKey: key, baseURL: root, maxRetries: 0 });

  test("non-streamed", async () => {
    const r = await client().messages.create({
      model,
      max_tokens: 64,
      system: "be brief",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(r.content[0]?.type === "text" && r.content[0].text).toBe(answer);
    expect(r.stop_reason).toBe("end_turn");
    expect(r.usage.output_tokens).toBeGreaterThan(0);
  });

  test("streamed, with the final message", async () => {
    const stream = client().messages.stream({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
    let text = "";
    stream.on("text", (t) => {
      text += t;
    });
    const final = await stream.finalMessage();
    expect(text).toBe(answer);
    expect(final.content[0]?.type === "text" && final.content[0].text).toBe(answer);
  });

  test("a wrong key is an AuthenticationError", async () => {
    const bad = new Anthropic({ apiKey: "nope", baseURL: root, maxRetries: 0 });
    const e = await bad.messages.create({ model, max_tokens: 8, messages: [{ role: "user", content: "x" }] }).then(
      () => null,
      (x) => x,
    );
    expect(e).toBeInstanceOf(Anthropic.AuthenticationError);
  });
});

const hasPython = spawnSync("python3", ["-c", "import openai"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasPython)("openai-python Responses", () => {
  // Async spawn: the gateway runs in this process, so a blocking spawn would deadlock it.
  test.each(PROVIDERS)(
    "%s",
    async (_name, model, answer) => {
      const script = [
        "import openai, os",
        "c = openai.OpenAI(api_key=os.environ['K'], base_url=os.environ['B'], max_retries=0, timeout=20)",
        `r = c.responses.create(model='${model}', input='hello')`,
        "print(r.output_text)",
        `s = c.responses.create(model='${model}', input='hello', stream=True)`,
        "print(''.join(e.delta for e in s if e.type == 'response.output_text.delta'))",
      ].join("\n");
      const p = Bun.spawn(["python3", "-c", script], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: gw.root, K: key, B: `${root}/v1` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      const r = { stdout: out, stderr: err };
      expect(r.stderr).toBe("");
      expect(r.stdout.trim().split("\n")).toEqual([answer, answer]);
    },
    60_000,
  );
});
