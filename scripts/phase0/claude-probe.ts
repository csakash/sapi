#!/usr/bin/env bun
/**
 * Phase 0 probe for the Claude adapter.
 *
 * Runs the unmodified `claude` CLI the way sapi will: argv array (never a shell), a fresh empty
 * working directory per run, an explicit minimal environment, no tools, no MCP servers, one turn.
 * It times each run, checks the init event, lists every event type seen, and can save sanitized
 * fixtures for replay tests.
 *
 * Every run uses real subscription quota. Keep prompts tiny.
 *
 *   bun scripts/phase0/claude-probe.ts --runs 10 --model haiku
 *   bun scripts/phase0/claude-probe.ts --runs 1 --save short --prompt "Reply with exactly: ok"
 *   bun scripts/phase0/claude-probe.ts --runs 1 --proxy http://127.0.0.1:18080
 *   bun scripts/phase0/claude-probe.ts --runs 1 --config-dir /tmp/empty-profile --save not-logged-in
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    runs: { type: "string", default: "1" },
    model: { type: "string", default: "haiku" },
    prompt: { type: "string", default: "Reply with exactly: ok" },
    system: { type: "string", default: "You are a terse assistant." },
    save: { type: "string" },
    proxy: { type: "string" },
    "config-dir": { type: "string" },
    "json-schema": { type: "string" },
    wrap: { type: "string" }, // optional launcher prefix, e.g. "sandbox-exec -f profile.sb"
    binary: { type: "string", default: "claude" },
    "allow-nonessential": { type: "boolean", default: false }, // drop CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  },
});

// Only what the CLI needs. USER is required on macOS: without it the CLI can't find its
// Keychain login (Phase 0 finding). Nothing else from this process's environment is passed on.
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `/usr/bin:/bin:${join(homedir(), ".local/bin")}`,
    HOME: homedir(),
    USER: userInfo().username,
    LANG: "en_US.UTF-8",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (opt["allow-nonessential"]) delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  if (opt.proxy) env.HTTPS_PROXY = env.https_proxy = opt.proxy;
  if (opt["config-dir"]) env.CLAUDE_CONFIG_DIR = opt["config-dir"];
  return env;
}

function argv(): string[] {
  const a = [
    opt.binary!,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    opt.model!,
    "--system-prompt",
    opt.system!,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--max-turns",
    "1",
    "--no-session-persistence",
    "--safe-mode",
  ];
  if (opt["json-schema"]) a.push("--json-schema", opt["json-schema"]);
  return opt.wrap ? [...opt.wrap.split(" "), ...a] : a;
}

/**
 * Replace anything personal or machine-specific before a fixture is committed: paths, user name,
 * emails, ids, the installed plugin and command lists, and the account's real usage numbers.
 */
function sanitize(line: string): string {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return sanitizeText(line);
  }
  if (obj.type === "system" && obj.subtype === "init") {
    for (const k of ["slash_commands", "plugins", "agents", "skills"]) if (k in obj) obj[k] = [];
  }
  if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
    const info = obj.rate_limit_info;
    if ("resetsAt" in info) info.resetsAt = 1800000000;
    for (const w of Object.values<any>(info.unifiedWindows ?? {})) {
      if ("utilization" in w) w.utilization = 0.42;
      if ("resetsAt" in w) w.resetsAt = 1800000000;
    }
  }
  if (obj.type === "result" && "credential_expires_at" in obj) obj.credential_expires_at = 1800000000000;
  return sanitizeText(JSON.stringify(obj));
}

function sanitizeText(line: string): string {
  const home = homedir();
  const user = userInfo().username;
  let s = line.split(home).join("/home/user");
  if (user.length > 2) s = s.split(user).join("user");
  s = s.replace(/\/(private\/)?var\/folders\/[^"\s]+/g, "/tmp/sapi-req");
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "redacted@example.invalid");
  s = s.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "00000000-0000-4000-8000-000000000000",
  );
  s = s.replace(/"(msg|req|toolu)_[A-Za-z0-9]+"/g, '"$1_REDACTED"');
  return s;
}

type RunResult = {
  ok: boolean;
  firstTokenMs?: number;
  totalMs: number;
  durationMs?: number;
  apiMs?: number;
  types: string[];
  tools?: unknown;
  mcp?: unknown;
  model?: string;
  version?: string;
  resultText?: string;
  usage?: unknown;
  costUsd?: number;
  lines: string[];
  stderr: string;
  exit: number;
};

async function runOnce(): Promise<RunResult> {
  const cwd = mkdtempSync(join(tmpdir(), "sapi-req-"));
  const t0 = performance.now();
  const child = Bun.spawn(argv(), {
    cwd,
    env: childEnv(),
    stdin: new Blob([opt.prompt!]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: string[] = [];
  const types = new Set<string>();
  let firstTokenMs: number | undefined;
  let buf = "";
  const r: Partial<RunResult> = {};
  const dec = new TextDecoder();
  for await (const chunk of child.stdout) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      lines.push(line);
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        types.add("unparseable");
        continue;
      }
      const t = d.type + (d.subtype ? `/${d.subtype}` : "") + (d.type === "stream_event" ? `:${d.event?.type}` : "");
      types.add(t);
      if (firstTokenMs === undefined && d.type === "stream_event" && d.event?.type === "content_block_delta") {
        firstTokenMs = performance.now() - t0;
      }
      if (d.type === "system" && d.subtype === "init") {
        r.tools = d.tools;
        r.mcp = d.mcp_servers;
        r.model = d.model;
        r.version = d.claude_code_version;
      }
      if (d.type === "result") {
        r.ok = !d.is_error;
        r.durationMs = d.duration_ms;
        r.apiMs = d.duration_api_ms;
        r.resultText = typeof d.result === "string" ? d.result.slice(0, 80) : undefined;
        r.usage = d.usage;
        r.costUsd = d.total_cost_usd;
      }
    }
  }
  const stderr = await new Response(child.stderr).text();
  const exit = await child.exited;
  rmSync(cwd, { recursive: true, force: true });
  return {
    ok: !!r.ok,
    firstTokenMs,
    totalMs: performance.now() - t0,
    types: [...types],
    lines,
    stderr,
    exit,
    ...r,
  } as RunResult;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const runs = Number(opt.runs);
const results: RunResult[] = [];
for (let i = 0; i < runs; i++) {
  const r = await runOnce();
  results.push(r);
  console.log(
    `run ${i + 1}: ok=${r.ok} exit=${r.exit} firstToken=${r.firstTokenMs?.toFixed(0) ?? "-"}ms total=${r.totalMs.toFixed(0)}ms ` +
      `cli=${r.durationMs ?? "-"}ms api=${r.apiMs ?? "-"}ms result=${JSON.stringify(r.resultText ?? "")}`,
  );
}

const ok = results.filter((r) => r.ok);
const ft = ok.map((r) => r.firstTokenMs!).filter(Number.isFinite);
const tot = ok.map((r) => r.totalMs);
const over = ok.filter((r) => r.durationMs != null && r.apiMs != null).map((r) => r.durationMs! - r.apiMs!);
const first = results[0];
console.log(
  "\nsummary",
  JSON.stringify(
    {
      runs,
      ok: ok.length,
      firstTokenMs: { p50: pct(ft, 50), p90: pct(ft, 90), min: Math.min(...ft), max: Math.max(...ft) },
      totalMs: { p50: pct(tot, 50), p90: pct(tot, 90) },
      cliOverheadMs: { p50: pct(over, 50), p90: pct(over, 90) },
      model: first?.model,
      version: first?.version,
      initTools: first?.tools,
      initMcpServers: first?.mcp,
      eventTypes: [...new Set(results.flatMap((r) => r.types))].sort(),
      usage: first?.usage,
      costUsd: first?.costUsd,
      stderr: first?.stderr.slice(0, 300),
    },
    null,
    2,
  ),
);

if (opt.save && first) {
  const dir = join(import.meta.dir, "../../test/fixtures/claude-cli");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${opt.save}.jsonl`);
  writeFileSync(file, `${first.lines.map(sanitize).join("\n")}\n`);
  console.log(`saved sanitized fixture: ${file}`);
}
