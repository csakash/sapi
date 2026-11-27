#!/usr/bin/env bun
/**
 * sapi command-line entry point.
 *
 * Phase 1: start, clients, pause/resume, login claude, status.
 * Phase 2: setup, doctor, connect, service install/uninstall, stop, uninstall.
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
import { listenAddress, loadConfig, PROVIDERS } from "./config.ts";
import { openDb } from "./db.ts";
import { pausedSwitches, type SwitchTarget, setPaused } from "./killswitch.ts";
import { verifyLogs } from "./meter.ts";
import { ensurePrivateDir, resolvePaths } from "./paths.ts";
import { claudeChildEnv } from "./providers/claude-sub/spawn.ts";
import { detectLauncher } from "./sandbox/launchers.ts";
import { claudeLogin, findClaude } from "./setup/claude.ts";
import { formatConnect, snippetModel, TOOLS, type Tool } from "./setup/connect.ts";
import { Service, serviceSpecFor } from "./setup/context.ts";
import { formatChecks, runDoctor } from "./setup/doctor.ts";
import { detectMachine, waitHealthy } from "./setup/machine.ts";
import { runSetup, SETUP_PROVIDERS, type SetupProvider, terminalIo } from "./setup/setup.ts";
import { runUninstall } from "./setup/uninstall.ts";
import { refuseRoot, startGateway, usesClaude } from "./start.ts";
import { VERSION } from "./version.ts";

const HELP = `sapi ${VERSION}: a local, single-user gateway for your own Claude and ChatGPT subscriptions

Usage: sapi <command> [options]

Getting started:
  setup                            Guided setup: checks, Claude sign-in, test call, first key, service
      --yes                        Accept every default (unattended); also --no-service, --no-self-test,
                                   --no-install-claude, --client NAME, --env-file FILE, --print-env,
                                   --port N, --claude-auth cli|env
  doctor [--json] [--offline]      Check everything; each problem comes with a fix
  connect <client> [--tool T] [--new-key]
                                   Copy-paste setup for curl, Python, Node, LangChain, Vercel AI SDK

Running:
  start [--foreground] [--port N]  Start the background service, or run here (127.0.0.1:8787)
  stop                             Stop the background service
  status                           Config, sandbox, Claude sign-in, service, clients, kill switches, logs
  service install|uninstall|status The background service (launchd agent or systemd user unit)
  login claude                     Sign in sapi's own Claude profile (your normal claude setup is untouched)

Clients and limits:
  clients add <name> [options]     Create a client key (shown once)
      --models a,b  --providers claude-sub  --expires 90d
      --rpm N  --requests-per-day N  --tokens-per-day N  --max-concurrency N  --print-env
  clients list                     Keys are shown by prefix only
  clients disable|enable <name>
  clients rotate <name>            New key; the old one stops working at once
  pause [--provider ID | --client NAME]    Kill switch: stops running requests, refuses new ones
  resume [--provider ID | --client NAME]

Removing:
  uninstall [--purge] [--yes]      Remove the service and binary; --purge also deletes keys, logs and
                                   sapi's Claude profile (after signing it out)

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
      if (name.startsWith("sapi-")) throw new Error('Client names starting with "sapi-" are reserved for sapi itself.');
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
  const machine = detectMachine();
  const spec = serviceSpecFor(paths, cfg, machine);
  lines.push(
    `service      ${spec ? `${new Service(spec).state()} (${spec.manager})` : `not available (${machine.serviceProblem ?? "no service manager"})`}`,
  );
  const db = openDb(paths.dbFile);
  try {
    lines.push(`clients      ${listClients(db).filter((c) => !c.name.startsWith("sapi-")).length}`);
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
  const bin = findClaude(paths.home, cfg.claude.binary);
  if (!bin) {
    console.error(
      "The claude CLI wasn't found. Run sapi setup (it can install it), or get it from https://claude.com/download.",
    );
    return 1;
  }
  const profile = ensurePrivateDir(paths.claudeProfileDir);
  console.log(
    `Signing in a separate Claude profile for sapi (${profile}).\nYour own claude setup is untouched. The claude CLI takes over now.\n`,
  );
  if (claudeLogin(bin, paths)) {
    console.log("\nsapi's Claude profile is signed in.");
    return 0;
  }
  console.error("\nThe sign-in didn't complete. Run sapi login claude again.");
  return 1;
}

function boolFlag(v: Record<string, unknown>, name: string): boolean | undefined {
  if (v[`no-${name}`]) return false;
  if (v[name]) return true;
  return undefined;
}

async function setupCmd(args: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      providers: { type: "string" },
      "claude-auth": { type: "string" },
      "install-claude": { type: "boolean" },
      "no-install-claude": { type: "boolean" },
      "self-test": { type: "boolean" },
      "no-self-test": { type: "boolean" },
      service: { type: "boolean" },
      "no-service": { type: "boolean" },
      client: { type: "string" },
      "print-env": { type: "boolean", default: false },
      "env-file": { type: "string" },
      port: { type: "string" },
    },
    strict: true,
  });
  const providers = (list(v.providers) ?? ["claude-sub"]) as SetupProvider[];
  for (const p of providers)
    if (!(SETUP_PROVIDERS as readonly string[]).includes(p))
      throw new Error(
        `Unknown provider "${p.slice(0, 32)}". Setup knows: claude-sub (ChatGPT arrives in a later version).`,
      );
  const auth = v["claude-auth"];
  if (auth !== undefined && auth !== "cli" && auth !== "env") throw new Error("--claude-auth is cli or env");
  const port = num(v.port, "port");
  if (port !== undefined && port > 65535) throw new Error("--port must be 1-65535");
  const installClaude = boolFlag(v, "install-claude");
  const selfTest = boolFlag(v, "self-test");
  const service = boolFlag(v, "service");
  return runSetup(
    resolvePaths(),
    {
      yes: v.yes ?? false,
      providers,
      printEnv: v["print-env"] ?? false,
      ...(auth ? { claudeAuth: auth } : {}),
      ...(installClaude !== undefined ? { installClaude } : {}),
      ...(selfTest !== undefined ? { selfTest } : {}),
      ...(service !== undefined ? { service } : {}),
      ...(v.client ? { client: v.client } : {}),
      ...(v["env-file"] ? { envFile: v["env-file"] } : {}),
      ...(port ? { port } : {}),
    },
    terminalIo(v.yes ?? false),
  );
}

async function doctorCmd(args: string[]): Promise<Out> {
  const { values: v } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false }, offline: { type: "boolean", default: false } },
    strict: true,
  });
  const checks = await runDoctor({ paths: resolvePaths(), offline: v.offline ?? false });
  const failed = checks.some((c) => c.status === "fail");
  return {
    code: failed ? 1 : 0,
    out: v.json ? JSON.stringify(checks, null, 2) : `sapi doctor\n${formatChecks(checks)}`,
  };
}

function connectCmd(args: string[]): Out {
  const { values: v, positionals } = parseArgs({
    args,
    options: { tool: { type: "string" }, "new-key": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (!name) return { code: 2, out: `Usage: sapi connect <client> [--tool ${TOOLS.join("|")}] [--new-key]` };
  if (v.tool !== undefined && !(TOOLS as readonly string[]).includes(v.tool))
    throw new Error(`--tool is one of: ${TOOLS.join(", ")}`);
  const { paths, cfg } = ctx();
  const db = openDb(paths.dbFile);
  try {
    const client = name.startsWith("sapi-") ? null : findClientByName(db, name);
    if (!client)
      throw new Error(`No client named "${name.slice(0, 48)}". Create one with: sapi clients add ${name.slice(0, 48)}`);
    const key = v["new-key"] ? rotateClientKey(db, name) : undefined;
    const { hostname, port } = listenAddress(cfg);
    return {
      code: 0,
      out: formatConnect({
        client: name,
        baseUrl: `http://${hostname}:${port}/v1`,
        model: snippetModel(cfg, client),
        disabled: client.disabled,
        ...(key ? { key } : {}),
        ...(v.tool ? { only: v.tool as Tool } : {}),
      }),
    };
  } finally {
    db.close();
  }
}

function serviceFor(): { svc: Service; host: string; port: number } {
  const { paths, cfg } = ctx();
  const machine = detectMachine();
  const spec = serviceSpecFor(paths, cfg, machine);
  if (!spec)
    throw new Error(
      `No background service on this machine (${machine.serviceProblem ?? "no service manager"}). Use: sapi start --foreground`,
    );
  const { hostname, port } = listenAddress(cfg);
  return { svc: new Service(spec), host: hostname, port };
}

async function serviceCmd(args: string[]): Promise<Out> {
  const [sub] = args;
  refuseRoot();
  const { svc, host, port } = serviceFor();
  if (sub === "status") return { code: 0, out: `${svc.state()} · ${svc.file.file}` };
  if (sub === "install") {
    const r = svc.install();
    const lines = [...r.done.map((d) => `✓ ${d}`), ...r.warnings.map((w) => `! ${w}`)];
    if (!r.ok) return { code: 1, out: [...lines, `✗ ${r.error}`].join("\n") };
    const healthy = await waitHealthy(host, port, 20_000);
    lines.push(healthy ? `✓ answering on ${host}:${port}` : `✗ nothing answers on ${host}:${port}; run sapi doctor`);
    return { code: healthy ? 0 : 1, out: lines.join("\n") };
  }
  if (sub === "uninstall") {
    const r = svc.uninstall();
    return {
      code: 0,
      out: r.done.length ? r.done.map((d) => `✓ ${d}`).join("\n") : "The service wasn't installed.",
    };
  }
  return { code: 2, out: "Usage: sapi service install|uninstall|status" };
}

function stopCmd(): Out {
  const { svc } = serviceFor();
  const r = svc.stop();
  return r.ok ? { code: 0, out: r.done.join("\n") } : { code: 1, out: `sapi: ${r.error}` };
}

async function uninstallCmd(args: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args,
    options: {
      purge: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
    strict: true,
  });
  return runUninstall(resolvePaths(), { purge: v.purge ?? false, yes: v.yes ?? false }, terminalIo(v.yes ?? false));
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
    if (cmd === "doctor") return await doctorCmd(rest);
    if (cmd === "connect") return connectCmd(rest);
    if (cmd === "service") return await serviceCmd(rest);
    if (cmd === "stop") return stopCmd();
    // These two stream their progress to the terminal themselves.
    if (cmd === "setup") return { code: await setupCmd(rest), out: "" };
    if (cmd === "uninstall") return { code: await uninstallCmd(rest), out: "" };
  } catch (e) {
    return { code: 1, out: `sapi: ${(e as Error).message}` };
  }
  if (["stats", "export", "purge", "eval", "providers", "logout"].includes(cmd)) {
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
    const { values: v } = parseArgs({
      args: rest,
      options: { port: { type: "string" }, foreground: { type: "boolean", default: false } },
      strict: true,
    });
    const { paths, cfg } = ctx();
    // With a background service installed (and no --foreground or --port), start that instead.
    if (!v.foreground && !v.port) {
      const spec = serviceSpecFor(paths, cfg, detectMachine());
      const svc = spec ? new Service(spec) : null;
      if (svc?.installed()) {
        const r = svc.start();
        if (!r.ok) {
          console.error(`sapi: ${r.error}`);
          process.exit(1);
        }
        const { hostname, port } = listenAddress(cfg);
        const healthy = await waitHealthy(hostname, port, 20_000);
        console.log(
          healthy ? `sapi is running on ${hostname}:${port}` : "Started, but sapi isn't answering yet: run sapi doctor",
        );
        process.exit(healthy ? 0 : 1);
      }
    }
    const running = await startGateway({ paths, cfg, ...(v.port ? { port: num(v.port, "port")! } : {}) });
    console.log(`sapi ${VERSION} listening on ${running.url}  (sandbox: ${running.launcher?.name ?? "none"})`);
    if (usesClaude(cfg)) {
      const ready = await running.gateway.adapter("claude-sub")?.checkReady();
      if (ready && !ready.ready) console.log(`Claude: not ready. ${ready.reason} Fix: ${ready.fix}`);
    }
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
