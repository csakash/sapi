/**
 * End-to-end check against a running sapi and a signed-in Claude profile (Phase 1 exit criterion).
 *
 *   sapi clients add e2e --print-env > e2e.env   # keep it private: it holds a client key
 *   set -a; . ./e2e.env; set +a
 *   bun scripts/e2e/real-claude.ts
 *
 * It makes about eight small calls (Claude Haiku) through openai-node, openai-python and
 * LangChain, streamed and non-streamed, plus a multi-turn chat and a system prompt. The prompts
 * are fixed probes; only pass/fail, timings and token counts are printed. The Python SDKs are
 * skipped, and say so, when they aren't installed.
 */
import OpenAI from "openai";

const base = process.env.OPENAI_BASE_URL;
const key = process.env.OPENAI_API_KEY;
const model = process.env.SAPI_E2E_MODEL ?? "haiku";
if (!base || !key || !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+\/v1$/.test(base)) {
  console.error("Set OPENAI_BASE_URL (a loopback sapi URL ending in /v1) and OPENAI_API_KEY first.");
  process.exit(2);
}

type Result = { check: string; ok: boolean; ms: number; detail: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t = performance.now();
  try {
    const detail = await fn();
    results.push({ check: name, ok: true, ms: Math.round(performance.now() - t), detail });
  } catch (e) {
    results.push({ check: name, ok: false, ms: Math.round(performance.now() - t), detail: (e as Error).message });
  }
}

function expectWord(text: string | null | undefined, word: string): void {
  if (!text?.toLowerCase().includes(word)) throw new Error(`expected "${word}", got ${JSON.stringify(text)}`);
}

const client = new OpenAI({ apiKey: key, baseURL: base, maxRetries: 0, timeout: 120_000 });
const PONG = [{ role: "user" as const, content: "Reply with exactly one word: pong" }];

await check("openai-node · non-streamed", async () => {
  const r = await client.chat.completions.create({ model, messages: PONG });
  expectWord(r.choices[0]?.message.content, "pong");
  if (r.choices[0]?.finish_reason !== "stop") throw new Error(`finish_reason ${r.choices[0]?.finish_reason}`);
  return `${r.model} · ${r.usage?.prompt_tokens}+${r.usage?.completion_tokens} tokens`;
});

await check("openai-node · streamed", async () => {
  const s = await client.chat.completions.create({
    model,
    messages: PONG,
    stream: true,
    stream_options: { include_usage: true },
  });
  let text = "";
  let chunks = 0;
  let usage = "";
  let finish = "";
  for await (const c of s) {
    chunks++;
    text += c.choices[0]?.delta.content ?? "";
    if (c.choices[0]?.finish_reason) finish = c.choices[0].finish_reason;
    if (c.usage) usage = `${c.usage.prompt_tokens}+${c.usage.completion_tokens} tokens`;
  }
  expectWord(text, "pong");
  if (finish !== "stop" || !usage) throw new Error(`finish=${finish} usage=${usage || "missing"}`);
  return `${chunks} chunks · ${usage}`;
});

await check("openai-node · multi-turn", async () => {
  const r = await client.chat.completions.create({
    model,
    messages: [
      { role: "user", content: "Remember this code word: teal. Reply only: ok" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "What was the code word? Reply with that one word." },
    ],
  });
  expectWord(r.choices[0]?.message.content, "teal");
  return "earlier turns reached the model";
});

await check("openai-node · system prompt", async () => {
  const r = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "Whatever the user says, your whole reply is the single word: lighthouse" },
      { role: "user", content: "hi" },
    ],
  });
  expectWord(r.choices[0]?.message.content, "lighthouse");
  return "system prompt applied";
});

const PY = `
import json, sys
out = {}
from openai import OpenAI
c = OpenAI(max_retries=0, timeout=120)
r = c.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "Reply with exactly one word: pong"}])
out["py_nonstream"] = r.choices[0].message.content
s = c.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "Reply with exactly one word: pong"}], stream=True, stream_options={"include_usage": True})
text, usage = "", None
for ch in s:
    if ch.choices and ch.choices[0].delta.content:
        text += ch.choices[0].delta.content
    if ch.usage:
        usage = ch.usage.total_tokens
out["py_stream"] = text
out["py_stream_usage"] = usage
if LANGCHAIN:
    from langchain_openai import ChatOpenAI
    llm = ChatOpenAI(model=MODEL, max_retries=0, timeout=120)
    out["lc_invoke"] = llm.invoke("Reply with exactly one word: pong").content
    out["lc_stream"] = "".join(ch.content for ch in llm.stream("Reply with exactly one word: pong"))
print(json.dumps(out))
`;

function hasPy(mod: string): boolean {
  const r = Bun.spawnSync(["python3", "-c", `import ${mod}`], {
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  return r.exitCode === 0;
}

const pyOpenAI = hasPy("openai");
const pyLangChain = pyOpenAI && hasPy("langchain_openai");
if (pyOpenAI) {
  const t = performance.now();
  const child = Bun.spawn(
    ["python3", "-c", `MODEL = ${JSON.stringify(model)}\nLANGCHAIN = ${pyLangChain ? "True" : "False"}\n${PY}`],
    {
      // Only what the SDKs need: no inherited secrets.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OPENAI_BASE_URL: base, OPENAI_API_KEY: key },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const ms = Math.round(performance.now() - t);
  if (code !== 0) {
    results.push({ check: "python SDKs", ok: false, ms, detail: stderr.trim().split("\n").slice(-1)[0] ?? "" });
  } else {
    const out = JSON.parse(stdout) as Record<string, string | number | null>;
    const word = (k: string, label: string, extra = "") => {
      const ok = String(out[k] ?? "")
        .toLowerCase()
        .includes("pong");
      results.push({ check: label, ok, ms, detail: ok ? extra || "ok" : `got ${JSON.stringify(out[k])}` });
    };
    word("py_nonstream", "openai-python · non-streamed");
    word("py_stream", "openai-python · streamed", out.py_stream_usage ? `${out.py_stream_usage} tokens` : "no usage");
    if (pyLangChain) {
      word("lc_invoke", "LangChain · invoke");
      word("lc_stream", "LangChain · stream");
    }
  }
}
if (!pyOpenAI) results.push({ check: "openai-python", ok: true, ms: 0, detail: "skipped: pip install openai" });
if (pyOpenAI && !pyLangChain)
  results.push({ check: "LangChain", ok: true, ms: 0, detail: "skipped: pip install langchain-openai" });

const width = Math.max(...results.map((r) => r.check.length));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(width)}  ${String(r.ms).padStart(6)} ms  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} failed.` : "\nAll passed.");
process.exit(failed ? 1 : 0);
