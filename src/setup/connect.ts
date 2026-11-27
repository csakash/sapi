/**
 * `sapi connect <client>` (plan §5): copy-paste setup for common SDKs and tools.
 *
 * Keys are stored as hashes, so an existing key can't be shown again. Snippets therefore read
 * OPENAI_BASE_URL and OPENAI_API_KEY from the environment (both OpenAI SDKs and LangChain do this
 * on their own); the key itself appears once, in the environment section, only when
 * `--new-key` issues one.
 */
import type { Client } from "../auth.ts";
import type { Config } from "../config.ts";

export const TOOLS = ["env", "curl", "python", "node", "langchain", "vercel-ai"] as const;
export type Tool = (typeof TOOLS)[number];

/** The model a snippet should use: one the client may call, preferring the cheapest default. */
export function snippetModel(cfg: Config, client: Client): string {
  const aliases = Object.keys(cfg.models).filter((a) => !client.scope.models || client.scope.models.includes(a));
  const allowed = aliases.filter((a) => {
    const m = cfg.models[a]!;
    return !("provider" in m) || !client.scope.providers || client.scope.providers.includes(m.provider);
  });
  return allowed.includes("haiku") ? "haiku" : (allowed[0] ?? Object.keys(cfg.models)[0] ?? "haiku");
}

export function snippets(o: { baseUrl: string; model: string; key?: string }): Record<Tool, string> {
  const m = JSON.stringify(o.model);
  return {
    env: o.key
      ? `export OPENAI_BASE_URL=${o.baseUrl}\nexport OPENAI_API_KEY=${o.key}    # shown once; keep it somewhere safe`
      : `export OPENAI_BASE_URL=${o.baseUrl}\nexport OPENAI_API_KEY=sk-sapi-…    # this client's key (shown once when it was made)`,
    curl: `curl -s "$OPENAI_BASE_URL/chat/completions" \\
  -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model": ${m}, "messages": [{"role": "user", "content": "Hello"}]}'`,
    python: `# pip install openai   (reads OPENAI_BASE_URL and OPENAI_API_KEY)
from openai import OpenAI

client = OpenAI()
r = client.chat.completions.create(model=${m}, messages=[{"role": "user", "content": "Hello"}])
print(r.choices[0].message.content)`,
    node: `// npm install openai   (reads OPENAI_BASE_URL and OPENAI_API_KEY)
import OpenAI from "openai";

const client = new OpenAI();
const r = await client.chat.completions.create({ model: ${m}, messages: [{ role: "user", content: "Hello" }] });
console.log(r.choices[0].message.content);`,
    langchain: `# pip install langchain-openai   (reads OPENAI_BASE_URL and OPENAI_API_KEY)
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model=${m})
print(llm.invoke("Hello").content)`,
    "vercel-ai": `// npm install ai @ai-sdk/openai
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const sapi = createOpenAI({ baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY });
// .chat() uses Chat Completions, which is what sapi serves today.
const { text } = await generateText({ model: sapi.chat(${m}), prompt: "Hello" });
console.log(text);`,
  };
}

const TITLES: Record<Tool, string> = {
  env: "Environment variables",
  curl: "curl",
  python: "OpenAI Python",
  node: "OpenAI Node",
  langchain: "LangChain (Python)",
  "vercel-ai": "Vercel AI SDK",
};

export function formatConnect(o: {
  client: string;
  baseUrl: string;
  model: string;
  key?: string;
  only?: Tool;
  disabled?: boolean;
}): string {
  const all = snippets(o);
  const tools = o.only ? [o.only] : [...TOOLS];
  const head =
    (o.key
      ? `New key for "${o.client}" (the old one no longer works).`
      : `Setup for "${o.client}". Lost its key? Issue a new one with: sapi connect ${o.client} --new-key`) +
    (o.disabled ? `\nThis client is disabled; turn it back on with: sapi clients enable ${o.client}` : "");
  const body = tools.map((t) => `## ${TITLES[t]}\n\n${all[t]}`).join("\n\n");
  const tail = "Anthropic SDK (/v1/messages) and OpenAI Responses (/v1/responses) arrive in a later version.";
  return `${head}\n\n${body}\n\n${o.only ? "" : tail}`.trimEnd();
}
