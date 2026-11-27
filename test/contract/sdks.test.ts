/**
 * Contract tests: real client SDKs against sapi with the fake provider (plan §19).
 *
 *   openai-node      always (dev dependency)
 *   openai-python    when `python3 -c "import openai"` works
 *   LangChain        when `python3 -c "import langchain_openai"` works
 *
 * The Python SDKs run as a child process with an explicit environment (no secrets inherited).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import OpenAI from "openai";
import { bearer, jsonOf, startTestGateway, type TestGateway } from "../helpers.ts";

let gw: TestGateway;
let key: string;
let base: string;

/** openai-node's APIPromise is lazy, so await it before asserting on the rejection. */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail");
}

beforeAll(async () => {
  gw = await startTestGateway();
  key = gw.addClient("sdk-tests");
  base = `http://127.0.0.1:${gw.server.port}/v1`;
});
afterAll(() => gw.cleanup());

describe("openai-node", () => {
  const client = () => new OpenAI({ apiKey: key, baseURL: base, maxRetries: 0 });

  test("non-streamed chat", async () => {
    const r = await client().chat.completions.create({
      model: "echo",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello node" },
      ],
      temperature: 0.2,
    });
    expect(r.choices[0]?.message.content).toBe("echo: hello node");
    expect(r.choices[0]?.finish_reason).toBe("stop");
    expect(r.usage?.total_tokens).toBeGreaterThan(0);
    expect(r.object).toBe("chat.completion");
  });

  test("streamed chat with usage", async () => {
    const stream = await client().chat.completions.create({
      model: "echo",
      messages: [{ role: "user", content: "stream node" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let usage = 0;
    for await (const ch of stream) {
      text += ch.choices[0]?.delta.content ?? "";
      if (ch.usage) usage = ch.usage.total_tokens;
    }
    expect(text).toBe("echo: stream node");
    expect(usage).toBeGreaterThan(0);
  });

  test("ignored parameters are reported in a header", async () => {
    const { response } = await client()
      .chat.completions.create({
        model: "echo",
        messages: [{ role: "user", content: "x" }],
        temperature: 0.1,
        max_tokens: 5,
      })
      .withResponse();
    expect(response.headers.get("x-sapi-ignored-params")).toBe("max_tokens,temperature");
  });

  test("errors come back as typed SDK errors", async () => {
    expect(
      await rejection(client().chat.completions.create({ model: "nope", messages: [{ role: "user", content: "x" }] })),
    ).toBeInstanceOf(OpenAI.BadRequestError);
    const bad = new OpenAI({ apiKey: "sk-sapi-wrong", baseURL: base, maxRetries: 0 });
    expect(await rejection(bad.models.list())).toBeInstanceOf(OpenAI.AuthenticationError);
  });

  test("a provider failure mid-request is an API error, not a hang", async () => {
    const e = await rejection(
      client().chat.completions.create({ model: "broken", messages: [{ role: "user", content: "x" }] }),
    );
    expect(e).toBeInstanceOf(OpenAI.APIError);
    expect((e as InstanceType<typeof OpenAI.APIError>).status).toBe(502);
  });

  test("models.list", async () => {
    const ids: string[] = [];
    for await (const m of client().models.list()) ids.push(m.id);
    expect(ids).toEqual(expect.arrayContaining(["echo", "slow", "haiku"]));
  });

  test("tools are refused clearly until imitated tool calling lands", async () => {
    const r = await gw.post(
      "/v1/chat/completions",
      {
        model: "echo",
        messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      },
      bearer(key),
    );
    expect(r.status).toBe(400);
    expect((await jsonOf(r)).error.message).toContain("Tool calling");
  });
});

const PY = `
import json
from openai import OpenAI
c = OpenAI(max_retries=0)
out = {}
r = c.chat.completions.create(model="echo", messages=[{"role": "system", "content": "be brief"}, {"role": "user", "content": "hello python"}])
out["nonstream"] = r.choices[0].message.content
s = c.chat.completions.create(model="echo", messages=[{"role": "user", "content": "stream python"}], stream=True, stream_options={"include_usage": True})
parts, usage = [], None
for ch in s:
    if ch.choices and ch.choices[0].delta.content:
        parts.append(ch.choices[0].delta.content)
    if ch.usage:
        usage = ch.usage.total_tokens
out["stream"] = "".join(parts)
out["stream_usage"] = usage
try:
    c.chat.completions.create(model="nope", messages=[{"role": "user", "content": "x"}])
    out["bad_model"] = "no error"
except Exception as e:
    out["bad_model"] = type(e).__name__
if LANGCHAIN:
    from langchain_openai import ChatOpenAI
    llm = ChatOpenAI(model="echo", max_retries=0)
    out["lc_invoke"] = llm.invoke("hi langchain").content
    out["lc_stream"] = "".join(ch.content for ch in llm.stream("stream langchain"))
print(json.dumps(out))
`;

const hasPy = (mod: string) =>
  spawnSync("python3", ["-c", `import ${mod}`], { stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } })
    .status === 0;
const pyOpenAI = hasPy("openai");
const pyLangChain = pyOpenAI && hasPy("langchain_openai");

describe.skipIf(!pyOpenAI)("openai-python and LangChain", () => {
  test(`chat, streaming and errors${pyLangChain ? " (with LangChain)" : ""}`, async () => {
    // Async spawn: the gateway runs in this same process and must keep serving.
    const child = Bun.spawn(["python3", "-c", `LANGCHAIN = ${pyLangChain ? "True" : "False"}\n${PY}`], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: gw.root, OPENAI_BASE_URL: base, OPENAI_API_KEY: key },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr: code === 0 ? "" : stderr.slice(-2000) }).toEqual({ code: 0, stderr: "" });
    const out = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(out.nonstream).toBe("echo: hello python");
    expect(out.stream).toBe("echo: stream python");
    expect(out.stream_usage).toBeGreaterThan(0);
    expect(out.bad_model).toBe("BadRequestError");
    if (pyLangChain) {
      expect(out.lc_invoke).toBe("echo: hi langchain");
      expect(out.lc_stream).toBe("echo: stream langchain");
    }
  });
});
