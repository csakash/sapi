/**
 * Starting the gateway: refuse root, lock down file permissions, open the database, start the
 * egress proxy, pick the strongest launcher, build the adapters and listen on loopback.
 */
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import type { Config, ProviderId } from "./config.ts";
import { listenAddress } from "./config.ts";
import { type Db, openDb, recordEvent } from "./db.ts";
import { type EgressEvent, EgressProxy } from "./egress-proxy.ts";
import { Gateway } from "./gateway.ts";
import { ensurePrivateDir, type Paths } from "./paths.ts";
import { ClaudeAdapter } from "./providers/claude-sub/adapter.ts";
import { claudeManifest } from "./providers/claude-sub/manifest.ts";
import { FakeAdapter } from "./providers/fake/adapter.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { log } from "./redact.ts";
import { detectLauncher, type Launcher, noLauncher } from "./sandbox/launchers.ts";
import { serve } from "./server.ts";
import { VERSION } from "./version.ts";

export function refuseRoot(): void {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("sapi refuses to run as root. Run it as your normal user.");
  }
}

/** How to start this same program as the egress bridge inside a Linux sandbox. */
export function bridgeCommand(): { command: string[]; readOnly: string[] } {
  const compiled = import.meta.path.startsWith("/$bunfs/") || import.meta.path.startsWith("B:/~BUN/");
  if (compiled) return { command: [process.execPath, "__egress-bridge"], readOnly: [process.execPath] };
  const cli = join(import.meta.dir, "cli.ts");
  // Running from source: bun itself plus the source tree and its node_modules.
  return {
    command: [process.execPath, cli, "__egress-bridge"],
    readOnly: [process.execPath, resolve(dirname(import.meta.dir))],
  };
}

export type StartOptions = {
  paths: Paths;
  cfg: Config;
  port?: number;
  /** Tests: force a launcher instead of detecting one. */
  launcher?: Launcher | null;
  /** Tests: replace or add adapters. */
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  switchPollMs?: number;
};

export type Running = {
  url: string;
  server: Server<undefined>;
  gateway: Gateway;
  db: Db;
  proxy: EgressProxy;
  launcher: Launcher | null;
  stop: () => Promise<void>;
};

export async function startGateway(o: StartOptions): Promise<Running> {
  refuseRoot();
  process.umask(0o077);
  const { paths, cfg } = o;
  ensurePrivateDir(paths.dataDir);
  ensurePrivateDir(paths.configDir);
  const runDir = ensurePrivateDir(paths.runDir);
  // Work dirs left behind by a crash may hold a system prompt; remove them before serving.
  for (const name of readdirSync(runDir))
    if (name.startsWith("req-")) rmSync(join(runDir, name), { recursive: true, force: true });
  ensurePrivateDir(paths.claudeProfileDir);
  const db = openDb(paths.dbFile);

  const egressThrottle = new Map<string, number>();
  const onEgress = (e: EgressEvent) => {
    if (e.kind !== "egress_blocked") return;
    const key = `${e.host}:${e.port}:${e.reason}`;
    const now = Date.now();
    if (now - (egressThrottle.get(key) ?? 0) < 60_000) return;
    egressThrottle.set(key, now);
    recordEvent(db, "egress_blocked", { provider: "claude-sub", host: e.host, port: e.port, reason: e.reason ?? "" });
    log("warn", "egress blocked", { host: e.host, port: e.port, reason: e.reason });
  };
  const proxy = new EgressProxy({ allow: claudeManifest.egressHosts, onEvent: onEgress });
  const tcpPort = await proxy.listenTcp();
  const socketPath = join(runDir, "egress-claude.sock");
  if (process.platform === "linux") await proxy.listenUnix(socketPath);

  let launcher: Launcher | null;
  let launcherProblem: string | undefined;
  if (o.launcher !== undefined) launcher = o.launcher;
  else launcher = detectLauncher().launcher;
  if (!launcher) {
    if (cfg.claude.confinement === "best-effort") {
      launcher = noLauncher;
      log("warn", "no sandbox available; running the claude child with reduced isolation (confinement = best-effort)");
    } else {
      launcherProblem =
        process.platform === "linux"
          ? 'No sandbox is available (bwrap couldn\'t create namespaces and the systemd user fallback failed). On Ubuntu 24.04 see docs/phase0-findings.md, or set [claude] confinement = "best-effort".'
          : 'No sandbox is available on this system. Set [claude] confinement = "best-effort" to run without one.';
    }
  }

  const bridge = bridgeCommand();
  const adapters = new Map<ProviderId, ProviderAdapter>();
  const claude = new ClaudeAdapter({
    binary: cfg.claude.binary,
    versionRange: cfg.claude.version_range,
    auth: cfg.claude.auth,
    launcher: launcher ?? noLauncher,
    ...(launcherProblem ? { launcherProblem } : {}),
    profileDir: paths.claudeProfileDir,
    runDir,
    claudeEnvFile: paths.claudeEnvFile,
    hostHome: paths.home,
    hiddenPaths: [ensurePrivateDir(paths.dataDir), ensurePrivateDir(paths.configDir)],
    egress: { tcpPort, socketPath },
    bridgeCommand: bridge.command,
    bridgeReadOnlyPaths: bridge.readOnly,
    memoryMaxMb: cfg.claude.memory_max_mb,
    firstTokenTimeoutMs: cfg.claude.first_token_timeout_s * 1000,
    totalTimeoutMs: cfg.claude.total_timeout_s * 1000,
    onEvent: (kind, detail) => recordEvent(db, kind, detail),
  });
  adapters.set("claude-sub", claude);
  adapters.set("fake", new FakeAdapter());
  for (const [id, a] of Object.entries(o.adapters ?? {})) if (a) adapters.set(id as ProviderId, a);

  const gateway = new Gateway({ db, cfg, adapters, ...(o.switchPollMs ? { switchPollMs: o.switchPollMs } : {}) });
  gateway.startPolling();
  const { hostname, port } = listenAddress(cfg);
  const server = serve(gateway, { hostname, port: o.port ?? port, maxBodyBytes: cfg.max_body_bytes });
  recordEvent(db, "gateway_started", {
    version: VERSION,
    launcher: launcher?.name ?? "none",
    confinement: cfg.claude.confinement,
  });
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;

  return {
    url: `http://${host}:${server.port}`,
    server,
    gateway,
    db,
    proxy,
    launcher,
    stop: async () => {
      gateway.stop();
      server.stop(true);
      await proxy.close();
      for (const a of adapters.values()) await a.close?.();
      db.close();
    },
  };
}
