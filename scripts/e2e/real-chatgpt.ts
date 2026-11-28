/**
 * End-to-end check against a real ChatGPT sign-in (Phase 3 exit criterion).
 *
 *   sapi login chatgpt              # once
 *   bun scripts/e2e/real-chatgpt.ts [--model SLUG]
 *
 * It starts a throwaway gateway in a temporary folder (your config, keys and request log are not
 * touched), reads the ChatGPT sign-in from your secret store, and makes about eight small calls
 * through the three doors: openai-node Chat Completions and Responses, and the Anthropic SDK,
 * streamed and not, plus a multi-turn chat with a system prompt. The prompts are fixed probes;
 * only pass/fail, timings, token counts and the one-word answers are printed, never a token.
 * The model is the first one your plan lists unless you pass --model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createClient } from "../../src/auth.ts";
import { loadConfig, parseConfig } from "../../src/config.ts";
import { openEgress } from "../../src/egress-fetch.ts";
import { resolvePaths } from "../../src/paths.ts";
import { ChatGptAdapter } from "../../src/providers/chatgpt-sub/adapter.ts";
import { chatgptManifest } from "../../src/providers/chatgpt-sub/manifest.ts";
import { ChatGptAuth } from "../../src/providers/chatgpt-sub/session.ts";
import { openSecretStore } from "../../src/secrets.ts";
import { startGateway } from "../../src/start.ts";

const { values: v } = parseArgs({ options: { model: { type: "string" } }, strict: true });
process.env.SAPI_LOG = "off";

type Result = { check: string; ok: boolean; ms: number; detail: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t = performance.now();
  try {
    results.push({ check: name, ok: true, ms: Math.round(performance.now() - t), detail: await fn() });
    results[results.length - 1]!.ms = Math.round(performance.now() - t);
  } catch (e) {
    results.push({
      check: name,
      ok: false,
      ms: Math.round(performance.now() - t),
      detail: (e as Error).message.slice(0, 200),
    });
  }
}

function word(text: string | null | undefined, expected: string): string {
  const got = (text ?? "").trim();
  if (!got.toLowerCase().includes(expected))
    throw new Error(`expected "${expected}", got ${JSON.stringify(got.slice(0, 80))}`);
  return got.slice(0, 40);
}

const real = resolvePaths();
const realCfg = loadConfig(real.configFile);
const egress = await openEgress(chatgptManifest.egressHosts);
const auth = new ChatGptAuth({ openStore: () => openSecretStore(real, realCfg.secrets.backend), fetch: egress.fetch });
const adapter = new ChatGptAdapter({ auth, fetch: egress.fetch });

const ready = await adapter.checkReady();
if (!ready.ready) {
  console.error(`ChatGPT isn't ready: ${ready.reason}. Fix: ${ready.fix}`);
  await egress.close();
  process.exit(2);
}
const plan = await adapter.listModels();
const model = v.model ?? plan[0]?.slug;
if (!model || !chatgptManifest.modelIdPattern.test(model)) {
  console.error(`No usable model. Your plan lists: ${plan.map((m) => m.slug).join(", ") || "nothing"}`);
  await egress.close();
  process.exit(2);
}
console.log(`plan models: ${plan.map((m) => m.slug).join(", ")}\nusing: ${model}\n`);

const root = mkdtempSync(join(tmpdir(), "sapi-e2e-chatgpt-"));
const paths = resolvePaths({
  SAPI_CONFIG_DIR: join(root, "config"),
  SAPI_DATA_DIR: join(root, "data"),
  SAPI_RUN_DIR: join(root, "run"),
});
const cfg = parseConfig({ models: { gpt: { provider: "chatgpt-sub", model } } });
const running = await startGateway({ paths, cfg, port: 0, adapters: { "chatgpt-sub": adapter } });
try {
  const key = createClient(running.db, { name: "e2e" }).key;
  const openai = new OpenAI({ apiKey: key, baseURL: `${running.url}/v1`, maxRetries: 0, timeout: 120_000 });
  const anthropic = new Anthropic({ apiKey: key, baseURL: running.url, maxRetries: 0, timeout: 120_000 });
  const probe = "Reply with exactly one word: pong";

  await check("chat, non-streamed", async () => {
    const r = await openai.chat.completions.create({ model: "gpt", messages: [{ role: "user", content: probe }] });
    return `${word(r.choices[0]?.message.content, "pong")} · ${r.usage?.prompt_tokens} in / ${r.usage?.completion_tokens} out`;
  });
  await check("chat, streamed with usage", async () => {
    const t0 = performance.now();
    let ttft = 0;
    let text = "";
    let usage = "";
    const s = await openai.chat.completions.create({
      model: "gpt",
      messages: [{ role: "user", content: probe }],
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const c of s) {
      const d = c.choices[0]?.delta.content;
      if (d && !ttft) ttft = performance.now() - t0;
      text += d ?? "";
      if (c.usage) usage = `${c.usage.prompt_tokens} in / ${c.usage.completion_tokens} out`;
    }
    return `${word(text, "pong")} · first token ${(ttft / 1000).toFixed(2)} s · ${usage}`;
  });
  await check("chat, multi-turn with a system prompt", async () => {
    const r = await openai.chat.completions.create({
      model: "gpt",
      messages: [
        { role: "system", content: "Answer with one lowercase word and nothing else." },
        { role: "user", content: "Remember this fruit: kiwi." },
        { role: "assistant", content: "ok" },
        { role: "user", content: "Which fruit did I ask you to remember?" },
      ],
    });
    return word(r.choices[0]?.message.content, "kiwi");
  });
  await check("chat, ignored params are listed back", async () => {
    const res = await fetch(`${running.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt",
        temperature: 0.2,
        user: "u1",
        messages: [{ role: "user", content: probe }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ignored = res.headers.get("x-sapi-ignored-params");
    if (ignored !== "temperature,user") throw new Error(`x-sapi-ignored-params: ${ignored}`);
    return word(
      ((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content,
      "pong",
    );
  });
  await check("responses, non-streamed", async () => {
    const r = await openai.responses.create({ model: "gpt", instructions: "Be terse.", input: probe });
    return `${word(r.output_text, "pong")} · ${r.usage?.input_tokens} in / ${r.usage?.output_tokens} out`;
  });
  await check("responses, streamed", async () => {
    const s = openai.responses.stream({ model: "gpt", input: [{ role: "user", content: probe }] });
    let text = "";
    for await (const ev of s) if (ev.type === "response.output_text.delta") text += ev.delta;
    const final = await s.finalResponse();
    word(final.output_text, "pong");
    return word(text, "pong");
  });
  await check("messages (Anthropic SDK), non-streamed", async () => {
    const r = await anthropic.messages.create({
      model: "gpt",
      max_tokens: 64,
      messages: [{ role: "user", content: probe }],
    });
    const t = r.content[0]?.type === "text" ? r.content[0].text : "";
    return `${word(t, "pong")} · stop ${r.stop_reason}`;
  });
  await check("messages (Anthropic SDK), streamed", async () => {
    const s = anthropic.messages.stream({ model: "gpt", max_tokens: 64, messages: [{ role: "user", content: probe }] });
    let text = "";
    s.on("text", (t) => {
      text += t;
    });
    await s.finalMessage();
    return word(text, "pong");
  });
} finally {
  await running.stop();
  await egress.close();
  rmSync(root, { recursive: true, force: true });
}

const width = Math.max(...results.map((r) => r.check.length));
for (const r of results)
  console.log(`${r.ok ? "✓" : "✗"} ${r.check.padEnd(width)}  ${String(r.ms).padStart(6)} ms  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} failed.` : `\nAll ${results.length} passed.`);
process.exit(failed ? 1 : 0);
