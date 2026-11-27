#!/usr/bin/env bun
/**
 * sapi command-line entry point.
 *
 * Phase 1: start, clients, pause/resume, login claude, status. Setup, doctor, connect and the
 * service installer arrive in Phase 2.
 */
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  createClient,
  findClientByName,
  listClients,
  parseDuration,
  rotateClientKey,
  setClientDisabled,
} from "./auth.ts";
import { loadConfig, PROVIDERS } from "./config.ts";
import { openDb } from "./db.ts";
import { pausedSwitches, type SwitchTarget, setPaused } from "./killswitch.ts";
import { verifyLogs } from "./meter.ts";
import { ensurePrivateDir, resolvePaths } from "./paths.ts";
import { claudeChildEnv } from "./providers/claude-sub/spawn.ts";
import { detectLauncher } from "./sandbox/launchers.ts";
import { refuseRoot, startGateway } from "./start.ts";
import { VERSION } from "./version.ts";

const HELP = `sapi ${VERSION}: a local, single-user gateway for your own Claude and ChatGPT subscriptions

Usage: sapi <command> [options]

Commands:
  start [--port N]                 Run the gateway in the foreground on 127.0.0.1:8787
  login claude                     Sign in sapi's own Claude profile (your normal claude setup is untouched)
  status                           Config, sandbox, Claude sign-in, clients, kill switches, log integrity
  clients add <name> [options]     Create a client key (shown once)
      --models a,b  --providers claude-sub  --expires 90d
      --rpm N  --requests-per-day N  --tokens-per-day N  --max-concurrency N  --print-env
  clients list                     Keys are shown by prefix only
  clients disable|enable <name>
  clients rotate <name>            New key; the old one stops working at once
  pause [--provider ID | --client NAME]    Kill switch: stops running requests, refuses new ones
  resume [--provider ID | --client NAME]

Planned: setup, doctor, connect, service install (Phase 2).

Options:
  -v, --version  Print the version
  -h, --help     Print this help

sapi is not affiliated with Anthropic or OpenAI.`;

type Out = { code: number; out: string };

function ctx() {
  const paths = resolvePaths();
  const cfg = loadConfig(paths.configFile);
  return { paths, cfg };
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

function list(v: string | undefined): string[] | undefined {
  return v === undefined
    ? undefined
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function clients(args: string[]): Out {
  const [sub, name, ...rest] = args;
  const { paths, cfg } = ctx();
  const db = openDb(paths.dbFile);
  try {
    if (sub === "list") {
      const rows = listClients(db).map(
        (c) =>
          `${c.name.padEnd(20)} ${c.keyPrefix}…  ${c.disabled ? "disabled" : "active  "}  ${c.expiresAt ? `expires ${new Date(c.expiresAt).toISOString().slice(0, 10)}` : "no expiry"}  models: ${c.scope.models?.join(",") ?? "all"}`,
      );
      return {
        code: 0,
        out: rows.length ? rows.join("\n") : "No clients yet. Create one with: sapi clients add <name>",
      };
    }
    if (!name) return { code: 2, out: "Usage: sapi clients add|disable|enable|rotate <name>" };
    if (sub === "add") {
      const { values: v } = parseArgs({
        args: rest,
        options: {
          models: { type: "string" },
          providers: { type: "string" },
          expires: { type: "string" },
          rpm: { type: "string" },
          "requests-per-day": { type: "string" },
          "tokens-per-day": { type: "string" },
          "max-concurrency": { type: "string" },
          "print-env": { type: "boolean", default: false },
        },
        strict: true,
      });
      const models = list(v.models);
      for (const m of models ?? [])
        if (!Object.hasOwn(cfg.models, m))
          throw new Error(`Unknown model alias "${m.slice(0, 64)}". Configured: ${Object.keys(cfg.models).join(", ")}`);
      const providers = list(v.providers);
      for (const p of providers ?? [])
        if (!(PROVIDERS as readonly string[]).includes(p))
          throw new Error(`Unknown provider "${p.slice(0, 32)}". Known: ${PROVIDERS.join(", ")}`);
      const budget: Record<string, number> = {};
      const set = (k: string, val: number | undefined) => {
        if (val !== undefined) budget[k] = val;
      };
      set("rpm", num(v.rpm, "rpm"));
      set("requestsPerDay", num(v["requests-per-day"], "requests-per-day"));
      set("tokensPerDay", num(v["tokens-per-day"], "tokens-per-day"));
      set("maxConcurrency", num(v["max-concurrency"], "max-concurrency"));
      const { client, key } = createClient(db, {
        name,
        scope: { ...(models ? { models } : {}), ...(providers ? { providers: providers as never } : {}) },
        budget,
        expiresAt: v.expires ? Date.now() + parseDuration(v.expires) : null,
      });
      const base = `http://${cfg.listen}/v1`;
      if (v["print-env"]) return { code: 0, out: `OPENAI_BASE_URL=${base}\nOPENAI_API_KEY=${key}` };
      return {
        code: 0,
        out: `Created client "${client.name}". This key is shown once; copy it now:\n\n  ${key}\n\nUse it:\n  export OPENAI_BASE_URL=${base}\n  export OPENAI_API_KEY=${key}`,
      };
    }
    if (sub === "disable" || sub === "enable") {
      setClientDisabled(db, name, sub === "disable");
      return { code: 0, out: `Client "${name}" ${sub}d.` };
    }
    if (sub === "rotate") {
      const key = rotateClientKey(db, name);
      return { code: 0, out: `New key for "${name}" (the old one no longer works). Shown once:\n\n  ${key}` };
    }
    return { code: 2, out: `Unknown clients command "${String(sub).slice(0, 20)}".` };
  } finally {
    db.close();
  }
}

function switchTarget(args: string[]): SwitchTarget {
  const { values: v } = parseArgs({
    args,
    options: { provider: { type: "string" }, client: { type: "string" } },
    strict: true,
  });
  if (v.provider && v.client) throw new Error("Use either --provider or --client, not both.");
  if (v.provider) {
    if (!(PROVIDERS as readonly string[]).includes(v.provider))
      throw new Error(`Unknown provider. Known: ${PROVIDERS.join(", ")}`);
    return { scope: "provider", target: v.provider };
  }
  if (v.client) return { scope: "client", target: v.client };
  return { scope: "global", target: "*" };
}

function pause(args: string[], paused: boolean): Out {
  const { paths } = ctx();
  const db = openDb(paths.dbFile);
  try {
    const t = switchTarget(args);
    const what =
      t.scope === "global" ? "Everything" : t.scope === "provider" ? `Provider ${t.target}` : `Client ${t.target}`;
    if (t.scope === "client") {
      const c = findClientByName(db, t.target);
      if (!c) throw new Error(`No client named "${t.target.slice(0, 48)}".`);
      t.target = c.id;
    }
    setPaused(db, t, paused);
    return {
      code: 0,
      out: paused ? `${what} paused. Running requests are stopped within a second.` : `${what} resumed.`,
    };
  } finally {
    db.close();
  }
}

function status(): Out {
  const { paths, cfg } = ctx();
  const lines = [
    `sapi ${VERSION}`,
    `listen       ${cfg.listen}`,
    `config       ${paths.configFile}`,
    `data         ${paths.dataDir}`,
  ];
  const probe = detectLauncher();
  lines.push(
    `sandbox      ${probe.launcher?.name ?? "none available"} (tried: ${probe.tried.map((t) => `${t.name} ${t.ok ? "ok" : "failed"}`).join(", ") || "none"})`,
  );
  lines.push(`confinement  ${cfg.claude.confinement}`);
  const bin = cfg.claude.binary.startsWith("/") ? cfg.claude.binary : Bun.which(cfg.claude.binary);
  if (!bin) lines.push("claude       not found: install it, then run sapi login claude");
  else {
    ensurePrivateDir(paths.claudeProfileDir);
    const env = claudeChildEnv({
      binaryDir: dirname(bin),
      home: paths.home,
      user: userInfo().username,
      profileDir: paths.claudeProfileDir,
    });
    const v = spawnSync(bin, ["--version"], { env, encoding: "utf8", timeout: 15_000 });
    const s = spawnSync(bin, ["auth", "status"], { env, stdio: "ignore", timeout: 15_000 });
    lines.push(
      `claude       ${(v.stdout ?? "").trim().split(/\s/)[0] || "unknown version"} · ${s.status === 0 ? "signed in (sapi profile)" : "not signed in: run sapi login claude"}`,
    );
  }
  const db = openDb(paths.dbFile);
  try {
    lines.push(`clients      ${listClients(db).length}`);
    const sw = pausedSwitches(db);
    lines.push(`kill switch  ${sw.length ? sw.map((s) => `${s.scope}:${s.target}`).join(", ") : "none on"}`);
    const chain = verifyLogs(db);
    const show = (r: typeof chain.requests) =>
      r.ok ? `ok (${r.rows} rows)` : `BROKEN at row ${r.brokenAtSeq}: ${r.reason}`;
    lines.push(`request log  ${show(chain.requests)}`, `event log    ${show(chain.events)}`);
    const ok = chain.requests.ok && chain.events.ok;
    return { code: ok ? 0 : 1, out: lines.join("\n") };
  } finally {
    db.close();
  }
}

/** Hand the terminal to the real `claude auth login`, pointed at sapi's own profile. */
function loginClaude(): number {
  const { paths, cfg } = ctx();
  const bin = cfg.claude.binary.startsWith("/") ? cfg.claude.binary : Bun.which(cfg.claude.binary);
  if (!bin) {
    console.error("The claude CLI wasn't found. Install it from https://claude.com/download and try again.");
    return 1;
  }
  const profile = ensurePrivateDir(paths.claudeProfileDir);
  console.log(
    `Signing in a separate Claude profile for sapi (${profile}).\nYour own claude setup is untouched. The claude CLI takes over now.\n`,
  );
  const env = claudeChildEnv({
    binaryDir: dirname(bin),
    home: paths.home,
    user: userInfo().username,
    profileDir: profile,
  });
  if (process.env.TERM) env.TERM = process.env.TERM;
  if (process.env.BROWSER) env.BROWSER = process.env.BROWSER;
  const r = spawnSync(bin, ["auth", "login"], { env, stdio: "inherit" });
  const s = spawnSync(bin, ["auth", "status"], { env, stdio: "ignore" });
  if (s.status === 0) {
    console.log("\nsapi's Claude profile is signed in.");
    return 0;
  }
  console.error("\nThe sign-in didn't complete. Run sapi login claude again.");
  return r.status ?? 1;
}

export async function run(argv: string[]): Promise<Out> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") return { code: 0, out: HELP };
  if (cmd === "-v" || cmd === "--version" || cmd === "version") return { code: 0, out: VERSION };
  try {
    if (cmd === "clients") return clients(rest);
    if (cmd === "pause") return pause(rest, true);
    if (cmd === "resume") return pause(rest, false);
    if (cmd === "status") return status();
  } catch (e) {
    return { code: 1, out: `sapi: ${(e as Error).message}` };
  }
  if (["setup", "doctor", "connect", "service", "stats", "export", "purge", "eval", "providers"].includes(cmd)) {
    return { code: 2, out: `sapi: "${cmd}" is planned for a later phase and not implemented yet.` };
  }
  return { code: 2, out: `sapi: unknown command "${cmd.slice(0, 40)}". Run sapi --help.` };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "__egress-bridge") {
    const { runBridge } = await import("./sandbox/bridge.ts");
    process.exit(await runBridge(rest));
  }
  if (cmd === "login") {
    if (rest[0] !== "claude") {
      console.error("Usage: sapi login claude   (ChatGPT sign-in arrives in a later phase)");
      process.exit(2);
    }
    refuseRoot();
    process.exit(loginClaude());
  }
  if (cmd === "start") {
    const { values: v } = parseArgs({ args: rest, options: { port: { type: "string" } }, strict: true });
    const { paths, cfg } = ctx();
    const running = await startGateway({ paths, cfg, ...(v.port ? { port: Number(v.port) } : {}) });
    const ready = await running.gateway.adapter("claude-sub")?.checkReady();
    console.log(`sapi ${VERSION} listening on ${running.url}  (sandbox: ${running.launcher?.name ?? "none"})`);
    if (ready && !ready.ready) console.log(`Claude: not ready. ${ready.reason} Fix: ${ready.fix}`);
    const shutdown = async () => {
      await running.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  const { code, out } = await run(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`sapi: ${(e as Error).message}`);
    process.exit(1);
  });
}
