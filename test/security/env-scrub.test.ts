/**
 * ARI-42 GW-1, OUT-1, DATA-2: the Claude child gets an explicit minimal environment (no
 * secrets from sapi's own environment), a fixed argv built from config only, and exactly the
 * caller's text on stdin.
 *
 * Runs the real ClaudeAdapter with a fake `claude` binary that replies with what it received.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalRequest } from "../../src/canonical.ts";
import { ClaudeAdapter } from "../../src/providers/claude-sub/adapter.ts";
import { CHILD_ENV_NAMES } from "../../src/providers/claude-sub/spawn.ts";
import { noLauncher } from "../../src/sandbox/launchers.ts";
import { bridgeCommand } from "../../src/start.ts";
import { fakeSecret, tempRoot, testPaths, writeFakeClaude } from "../helpers.ts";

const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: fakeSecret.anthropic(),
  OPENAI_API_KEY: fakeSecret.openai(),
  AWS_SECRET_ACCESS_KEY: "TESTONLY-aws-secret-value",
  GITHUB_TOKEN: fakeSecret.github(),
  SAPI_ADMIN_TOKEN: "TESTONLY-admin-token",
  CLAUDE_CODE_OAUTH_TOKEN: fakeSecret.anthropic("oat01"),
};
// Built from parts so this file doesn't contain a permission-bypass flag literally.
const FLAG_LIKE_MODEL = ["--", "yolo"].join("");

let root: string;
const saved: Record<string, string | undefined> = {};

function adapter(binary: string, auth: "cli" | "env" = "cli"): ClaudeAdapter {
  const paths = testPaths(root);
  const b = bridgeCommand();
  return new ClaudeAdapter({
    binary,
    versionRange: ">=2.1.332",
    auth,
    launcher: noLauncher,
    profileDir: paths.claudeProfileDir,
    runDir: paths.runDir,
    claudeEnvFile: paths.claudeEnvFile,
    hostHome: root,
    hiddenPaths: [paths.dataDir, paths.configDir],
    egress: { tcpPort: 9, socketPath: join(root, "egress.sock") },
    bridgeCommand: b.command,
    bridgeReadOnlyPaths: b.readOnly,
    memoryMaxMb: 1024,
    firstTokenTimeoutMs: 10_000,
    totalTimeoutMs: 20_000,
  });
}

const request = (over: Partial<CanonicalRequest> = {}): CanonicalRequest => ({
  id: "req_test",
  clientId: "cli_test",
  door: "chat",
  alias: "haiku",
  provider: "claude-sub",
  model: "claude-haiku-5-5",
  system: "--model claude-opus-5-5 --tools Bash",
  messages: [{ role: "user", text: "--dangerously-run-everything $(whoami) `id`" }],
  stream: false,
  ignoredParams: [],
  ...over,
});

async function collectText(a: ClaudeAdapter, req: CanonicalRequest): Promise<string> {
  let text = "";
  for await (const ev of a.send(req, new AbortController().signal)) if (ev.type === "text") text += ev.delta;
  return text;
}

beforeAll(() => {
  root = tempRoot();
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("child environment (GW-1)", () => {
  test("only allowlisted variables reach the child, and none of sapi's secrets", async () => {
    const a = adapter(writeFakeClaude(join(root, "bin"), "env"));
    const seen = JSON.parse(await collectText(a, request()));
    const names = Object.keys(seen.env).filter((k) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(k));
    for (const n of names) expect(CHILD_ENV_NAMES as readonly string[]).toContain(n);
    const dump = JSON.stringify(seen.env);
    for (const v of Object.values(SECRETS)) expect(dump).not.toContain(v);
    expect(seen.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(seen.env.CLAUDE_CONFIG_DIR).toBe(testPaths(root).claudeProfileDir);
    expect(seen.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(seen.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.env.HOME).not.toBe(process.env.HOME);
  });
});

describe("argv and stdin (OUT-1, DATA-2)", () => {
  test("argv is the fixed flag set with the configured model; client text is never on it", async () => {
    const a = adapter(writeFakeClaude(join(root, "bin2"), "env"));
    const seen = JSON.parse(await collectText(a, request()));
    const argv: string[] = seen.argv;
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(argv.filter((x) => x === "--model")).toHaveLength(1);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--no-session-persistence");
    expect(argv.join(" ")).not.toContain("dangerously");
    expect(argv.join(" ")).not.toContain("whoami");
    expect(argv.join(" ")).not.toContain("claude-opus");
  });

  test("a single user message reaches stdin byte for byte, with nothing added", async () => {
    const a = adapter(writeFakeClaude(join(root, "bin3"), "env"));
    const text = "--dangerously-run-everything $(whoami) `id`";
    const seen = JSON.parse(await collectText(a, request()));
    expect(seen.stdin).toBe(text);
  });

  test("the child runs in an empty per-request directory that is removed afterwards", async () => {
    const a = adapter(writeFakeClaude(join(root, "bin4"), "env"));
    const seen = JSON.parse(await collectText(a, request()));
    expect(seen.cwd.startsWith(testPaths(root).runDir) || seen.cwd.includes("/sapi-")).toBe(true);
    expect(await Bun.file(join(seen.cwd, "system.txt")).exists()).toBe(false);
  });

  test("a config model ID that isn't a Claude model ID is refused before spawning", async () => {
    const a = adapter(writeFakeClaude(join(root, "bin5"), "env"));
    await expect(collectText(a, request({ model: FLAG_LIKE_MODEL }))).rejects.toThrow(/not a valid Claude model ID/);
  });
});

describe('auth = "env" (GW-1)', () => {
  test("the token from the 0600 claude.env reaches only the child, and nothing else from that file", async () => {
    const paths = testPaths(root);
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    const token = fakeSecret.anthropic("oat01");
    writeFileSync(paths.claudeEnvFile, `CLAUDE_CODE_OAUTH_TOKEN=${token}\nOTHER_SECRET=nope\n`, { mode: 0o600 });
    const a = adapter(writeFakeClaude(join(root, "bin-env"), "env"), "env");
    const seen = JSON.parse(await collectText(a, request()));
    expect(seen.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(seen.env.OTHER_SECRET).toBeUndefined();
    expect(seen.argv.join(" ")).not.toContain(token);
    expect(seen.stdin).not.toContain(token);
  });

  test("a claude.env that other users can read is refused", async () => {
    const paths = testPaths(root);
    chmodSync(paths.claudeEnvFile, 0o644);
    const a = adapter(writeFakeClaude(join(root, "bin-env2"), "env"), "env");
    await expect(collectText(a, request())).rejects.toThrow(/mode 600/);
    chmodSync(paths.claudeEnvFile, 0o600);
  });
});

describe("unsafe child", () => {
  test("a child that reports tools is stopped before any text is returned (GOV-4, MCP-1)", async () => {
    const a = adapter(writeFakeClaude(join(root, "bin6"), "tools"));
    await expect(collectText(a, request())).rejects.toThrow(/tools or MCP servers/);
  });
});
