/**
 * ChatGPT in the rest of sapi: `auto` routing between providers (plan §12), the config setup
 * writes, the doctor's sign-in check, and `uninstall --purge` signing ChatGPT out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { parseConfig } from "../../src/config.ts";
import { ChatGptAdapter } from "../../src/providers/chatgpt-sub/adapter.ts";
import { ChatGptAuth, hostFilePath, SESSION_SECRET, saveHost } from "../../src/providers/chatgpt-sub/session.ts";
import { runDoctor } from "../../src/setup/doctor.ts";
import type { Machine } from "../../src/setup/machine.ts";
import { configTemplate, type SetupIo } from "../../src/setup/setup.ts";
import { runUninstall } from "../../src/setup/uninstall.ts";
import { fakeOpenAi, jsonResponse, memoryStore, testSession } from "../fixtures/fake-openai.ts";
import { bearer, jsonOf, startTestGateway, TEST_MODELS, tempRoot, testPaths } from "../helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("auto routing across providers", () => {
  test("auto skips a provider at its usage limit; an explicit alias never falls back", async () => {
    const up = fakeOpenAi({
      responses: () => jsonResponse({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, 429),
    });
    const auth = new ChatGptAuth({
      openStore: async () => memoryStore({ [SESSION_SECRET]: JSON.stringify(testSession()) }),
      fetch: up.fetch,
    });
    const gw = await startTestGateway({
      config: {
        models: {
          ...TEST_MODELS,
          gpt: { provider: "chatgpt-sub", model: "gpt-test-1" },
          auto: { route: ["gpt", "echo"], switch_at_window_pct: 90 },
        },
      },
      start: { adapters: { "chatgpt-sub": new ChatGptAdapter({ auth, fetch: up.fetch, usagePauseMs: 60_000 }) } },
    });
    try {
      const key = gw.addClient("router");
      const ask = (model: string) =>
        gw.post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hi" }] }, bearer(key));
      // First call: gpt is tried, hits the limit, and ChatGPT pauses itself.
      expect((await ask("gpt")).status).toBe(429);
      // auto now goes to the next route; gpt stays refused without reaching OpenAI.
      const before = up.calls.length;
      const r = await jsonOf(await ask("auto"));
      expect(r.choices[0].message.content).toBe("echo: hi");
      expect((await ask("gpt")).status).toBe(429);
      expect(up.calls.length).toBe(before);
      // The meter records which alias auto actually used.
      const row = gw.db.query("SELECT model_alias, provider FROM requests ORDER BY rowid DESC LIMIT 2").all();
      expect(row).toContainEqual({ model_alias: "echo", provider: "fake" });
    } finally {
      await gw.cleanup();
    }
  });

  test("a key scoped to Claude can't reach ChatGPT, even through auto", async () => {
    const gw = await startTestGateway({
      config: {
        models: {
          ...TEST_MODELS,
          gpt: { provider: "chatgpt-sub", model: "gpt-test-1" },
          auto: { route: ["gpt"], switch_at_window_pct: 90 },
        },
      },
    });
    try {
      const key = gw.addClient("scoped", { scope: { providers: ["fake"] } });
      const ask = (model: string) =>
        gw.post("/v1/chat/completions", { model, messages: [{ role: "user", content: "hi" }] }, bearer(key));
      expect((await ask("gpt")).status).toBe(403);
      expect((await ask("auto")).status).toBe(503);
    } finally {
      await gw.cleanup();
    }
  });
});

describe("setup's config", () => {
  test("Claude and ChatGPT: explicit aliases, gpt from the plan, and an auto route", () => {
    const text = configTemplate({
      port: 8787,
      providers: ["claude-sub", "chatgpt-sub"],
      claudeBinary: "/usr/bin/claude",
      claudeAuth: "cli",
      chatgptModel: "gpt-test-1",
    });
    const cfg = parseConfig(Bun.TOML.parse(text));
    expect(cfg.models.gpt).toEqual({ provider: "chatgpt-sub", model: "gpt-test-1" });
    expect(cfg.models.sonnet).toEqual({ provider: "claude-sub", model: "claude-sonnet-5-5" });
    expect(cfg.models.auto).toEqual({ route: ["sonnet", "gpt"], switch_at_window_pct: 90 });
  });

  test("ChatGPT before sign-in: a commented hint, and the config still parses", () => {
    const text = configTemplate({
      port: 8787,
      providers: ["chatgpt-sub"],
      claudeBinary: null,
      claudeAuth: "cli",
      chatgptModel: null,
    });
    expect(text).toContain('# gpt = { provider = "chatgpt-sub"');
    expect(() => parseConfig(Bun.TOML.parse(text))).not.toThrow();
  });
});

const machine: Machine = {
  os: process.platform === "darwin" ? "macos" : "linux",
  osName: "Test OS",
  arch: process.arch,
  ssh: false,
  headless: true,
  container: false,
  wsl: false,
  root: false,
  serviceManager: "none",
  serviceProblem: "test machine",
};

function withConfig() {
  const root = tempRoot();
  roots.push(root);
  const paths = testPaths(root);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, '[models]\ngpt = { provider = "chatgpt-sub", model = "gpt-test-1" }\n', {
    mode: 0o600,
  });
  return paths;
}

describe("doctor", () => {
  test("signed in: ok; not signed in: a failure with the fix; network checked for api.openai.com", async () => {
    const paths = withConfig();
    const reached: string[] = [];
    const reach = async (h: string) => {
      reached.push(h);
      return null;
    };
    const signedIn = memoryStore({ [SESSION_SECRET]: JSON.stringify(testSession()) });
    let checks = await runDoctor({ paths, machine, service: null, reach, openStore: async () => signedIn });
    expect(checks.find((c) => c.id === "chatgpt")).toMatchObject({ status: "ok" });
    expect(checks.find((c) => c.id === "egress-openai")).toMatchObject({ status: "ok" });
    expect(reached).toContain("api.openai.com");
    checks = await runDoctor({ paths, machine, service: null, offline: true, openStore: async () => memoryStore() });
    expect(checks.find((c) => c.id === "chatgpt")).toMatchObject({ status: "fail", fix: "sapi login chatgpt" });
    // Doctor never prints a token.
    expect(JSON.stringify(checks)).not.toContain(testSession().access_token);
  });
});

describe("uninstall --purge", () => {
  const io = (): SetupIo => ({
    interactive: false,
    info: () => {},
    out: () => {},
    confirm: async (_q, d) => d,
    text: async (_q, d) => d,
  });

  test("signs ChatGPT out (revoke and delete) when sapi was ever signed in here", async () => {
    const paths = withConfig();
    saveHost(paths, { ext_agent_host_id: "urn:uuid:3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" });
    let called = 0;
    const code = await runUninstall(paths, { purge: true, yes: true }, io(), {
      machine,
      binary: null,
      chatgptLogout: async () => {
        called++;
        return { hadSession: true, revoked: true };
      },
    });
    expect(code).toBe(0);
    expect(called).toBe(1);
  });

  test("leaves the secret store alone when sapi never signed in to ChatGPT", async () => {
    const paths = withConfig();
    let called = 0;
    await runUninstall(paths, { purge: true, yes: true }, io(), {
      machine,
      binary: null,
      chatgptLogout: async () => {
        called++;
        return { hadSession: false, revoked: false };
      },
    });
    expect(called).toBe(0);
    expect(existsSync(hostFilePath(paths))).toBe(false);
  });
});

describe("sapi connect", () => {
  test("the Anthropic snippet points the SDK at sapi's root and uses the Messages API", async () => {
    const { snippets } = await import("../../src/setup/connect.ts");
    const s = snippets({ baseUrl: "http://127.0.0.1:8787/v1", model: "sonnet" }).anthropic;
    expect(s).toContain('removesuffix("/v1")');
    expect(s).toContain('client.messages.create(model="sonnet"');
    expect(s).not.toContain("sk-sapi-");
  });
});
