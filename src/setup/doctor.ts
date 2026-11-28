/**
 * `sapi doctor` (plan §5): every check from setup plus egress reachability, log-chain integrity,
 * the CLI version range and key ages, each with a fix command. Doctor only reads: it never
 * changes files, keys or the service. (The one exception: checking the Claude sign-in runs
 * `claude auth status` in a throwaway work dir, exactly like a real request does.)
 */
import { existsSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { keyIssuedAt, listClients } from "../auth.ts";
import { type Config, listenAddress, loadConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { EgressProxy } from "../egress-proxy.ts";
import { pausedSwitches } from "../killswitch.ts";
import { verifyLogs } from "../meter.ts";
import type { Paths } from "../paths.ts";
import { chatgptManifest } from "../providers/chatgpt-sub/manifest.ts";
import { parseSession, SESSION_SECRET, sessionState } from "../providers/chatgpt-sub/session.ts";
import { claudeManifest } from "../providers/claude-sub/manifest.ts";
import { detectLauncher, type LauncherProbe, noLauncher } from "../sandbox/launchers.ts";
import { openSecretStore, type SecretStore } from "../secrets.ts";
import { claudeAdapterFor, isCompiled, usesChatGpt, usesClaude } from "../start.ts";
import { Service, type ServiceState, serviceSpecFor } from "./context.ts";
import { detectMachine, isSapiHealthy, type Machine, portState } from "./machine.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type Check = { id: string; title: string; status: CheckStatus; detail: string; fix?: string };

export type DoctorOptions = {
  paths: Paths;
  /** Skip the network check (CI without internet, or a quick run). */
  offline?: boolean;
  machine?: Machine;
  service?: Service | null;
  launcher?: LauncherProbe;
  /** Tests: how to reach api.anthropic.com and api.openai.com. */
  reach?: (host: string) => Promise<string | null>;
  /** Tests: the secret store holding the ChatGPT sign-in. */
  openStore?: () => Promise<SecretStore>;
  now?: number;
};

const KEY_AGE_WARN_DAYS = 180;

function privateDirCheck(id: string, title: string, dir: string): Check {
  if (!existsSync(dir)) return { id, title, status: "warn", detail: `${dir} doesn't exist yet`, fix: "sapi setup" };
  const st = statSync(dir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    return {
      id,
      title,
      status: "fail",
      detail: `${dir} belongs to another user`,
      fix: `move it away and run sapi setup`,
    };
  if ((st.mode & 0o077) !== 0)
    return { id, title, status: "fail", detail: `${dir} is open to other users`, fix: `chmod 700 ${dir}` };
  return { id, title, status: "ok", detail: `${dir} (private)` };
}

/** Resolve a provider host through the same checks the egress proxy applies, then open TCP 443. */
async function reachHost(host: string): Promise<string | null> {
  const allow = [...claudeManifest.egressHosts, ...chatgptManifest.egressHosts];
  const proxy = new EgressProxy({ allow, onEvent: () => {} });
  const d = await proxy.decide(`${host}:443`);
  if (!d.allow) return `the egress check refused it (${d.reason})`;
  return new Promise((resolve) => {
    const s = connect(443, d.address);
    const t = setTimeout(() => {
      s.destroy();
      resolve("no answer on port 443 within 5 seconds");
    }, 5000);
    s.once("connect", () => {
      clearTimeout(t);
      s.destroy();
      resolve(null);
    });
    s.once("error", (e) => {
      clearTimeout(t);
      resolve(e.message.slice(0, 120));
    });
  });
}

export async function runDoctor(o: DoctorOptions): Promise<Check[]> {
  const { paths } = o;
  const out: Check[] = [];
  const now = o.now ?? Date.now();
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  out.push(
    uid === 0
      ? { id: "user", title: "User", status: "fail", detail: "running as root", fix: "run sapi as your normal user" }
      : { id: "user", title: "User", status: "ok", detail: "not root" },
  );

  let cfg: Config | null = null;
  try {
    cfg = loadConfig(paths.configFile);
    out.push({
      id: "config",
      title: "Config",
      status: "ok",
      detail: existsSync(paths.configFile) ? paths.configFile : "defaults (no config file yet)",
    });
  } catch (e) {
    out.push({
      id: "config",
      title: "Config",
      status: "fail",
      detail: (e as Error).message.split("\n").slice(0, 3).join(" "),
      fix: `fix ${paths.configFile}, or move it away and run sapi setup`,
    });
  }
  out.push(privateDirCheck("config-dir", "Config folder", paths.configDir));
  out.push(privateDirCheck("data-dir", "Data folder", paths.dataDir));

  if (existsSync(paths.dbFile)) {
    const mode = statSync(paths.dbFile).mode & 0o077;
    const db = openDb(paths.dbFile);
    try {
      const chain = verifyLogs(db);
      const broken = [chain.requests, chain.events].find((c) => !c.ok);
      out.push(
        broken
          ? {
              id: "log-chain",
              title: "Request log",
              status: "fail",
              detail: `the hash chain breaks at row ${broken.brokenAtSeq} (${broken.reason}): the log was changed outside sapi`,
              fix: `keep a copy for review before anything else: cp ${paths.dbFile} ${paths.dbFile}.evidence`,
            }
          : {
              id: "log-chain",
              title: "Request log",
              status: mode ? "fail" : "ok",
              detail: `${chain.requests.rows} requests, ${chain.events.rows} events, chain intact${mode ? "; but the file is open to other users" : ""}`,
              ...(mode ? { fix: `chmod 600 ${paths.dbFile}` } : {}),
            },
      );

      const clients = listClients(db);
      const active = clients.filter((c) => !c.disabled && (!c.expiresAt || c.expiresAt > now));
      const userClients = active.filter((c) => !c.name.startsWith("sapi-"));
      const old = userClients.filter((c) => now - keyIssuedAt(db, c) > KEY_AGE_WARN_DAYS * 86_400_000);
      if (userClients.length === 0)
        out.push({
          id: "clients",
          title: "Client keys",
          status: "warn",
          detail: "no active client keys, so nothing can call sapi",
          fix: "sapi clients add my-app",
        });
      else if (old.length)
        out.push({
          id: "clients",
          title: "Client keys",
          status: "warn",
          detail: `${old.map((c) => c.name).join(", ")}: key older than ${KEY_AGE_WARN_DAYS} days`,
          fix: `sapi clients rotate ${old[0]!.name}`,
        });
      else out.push({ id: "clients", title: "Client keys", status: "ok", detail: `${userClients.length} active` });

      const sw = pausedSwitches(db);
      if (sw.length) {
        const first = sw[0]!;
        const name =
          first.scope === "client" ? (clients.find((c) => c.id === first.target)?.name ?? first.target) : first.target;
        out.push({
          id: "kill-switch",
          title: "Kill switches",
          status: "warn",
          detail: `on: ${sw.map((s) => (s.scope === "global" ? "everything" : `${s.scope} ${s.target}`)).join(", ")}`,
          fix: first.scope === "global" ? "sapi resume" : `sapi resume --${first.scope} ${name}`,
        });
      } else out.push({ id: "kill-switch", title: "Kill switches", status: "ok", detail: "none on" });
    } finally {
      db.close();
    }
  } else {
    out.push({ id: "log-chain", title: "Request log", status: "skip", detail: "no database yet", fix: "sapi setup" });
  }

  const machine = o.machine ?? detectMachine();
  const { hostname, port } = cfg ? listenAddress(cfg) : { hostname: "127.0.0.1", port: 8787 };
  const service = o.service !== undefined ? o.service : cfg ? serviceFromMachine(paths, cfg, machine) : null;
  let state: ServiceState = "not-installed";
  if (!service) {
    out.push({
      id: "service",
      title: "Background service",
      status: "warn",
      detail: `not available here: ${machine.serviceProblem ?? "no service manager"}`,
      fix: "run sapi start --foreground under your own supervisor",
    });
  } else {
    state = service.state();
    const healthy = await isSapiHealthy(hostname, port);
    if (state === "not-installed")
      out.push({
        id: "service",
        title: "Background service",
        status: "warn",
        detail: "not installed; sapi runs only while sapi start is open",
        fix: "sapi service install",
      });
    else if (state === "running" && healthy)
      out.push({
        id: "service",
        title: "Background service",
        status: "ok",
        detail: `running, answering on ${hostname}:${port}`,
      });
    else
      out.push({
        id: "service",
        title: "Background service",
        status: "fail",
        detail: state === "running" ? `running but not answering on ${hostname}:${port}` : "installed but stopped",
        fix:
          machine.serviceManager === "systemd"
            ? "sapi start, then: journalctl --user -u sapi -n 50"
            : `sapi start, then look at ${service.file.logFile ?? "the log"}`,
      });
    if (machine.os === "linux" && state !== "not-installed" && machine.linger === false)
      out.push({
        id: "linger",
        title: "Keep running after logout",
        status: "warn",
        detail: "lingering is off: the service stops when you log out",
        fix: `sudo loginctl enable-linger ${process.env.USER ?? "$USER"}`,
      });
  }
  if (state !== "running") {
    const p = await portState(hostname, port);
    if (p === "busy")
      out.push({
        id: "port",
        title: "Port",
        status: "fail",
        detail: `${hostname}:${port} is taken by another program`,
        fix: `stop that program, or set listen = "127.0.0.1:<port>" in ${paths.configFile}`,
      });
    else
      out.push({
        id: "port",
        title: "Port",
        status: "ok",
        detail: `${hostname}:${port} ${p === "sapi" ? "serves sapi" : "free"}`,
      });
  }

  if (!cfg || !usesClaude(cfg)) {
    out.push({ id: "claude", title: "Claude", status: "skip", detail: "no model alias uses the Claude subscription" });
  } else {
    const probe = o.launcher ?? detectLauncher();
    if (probe.launcher) out.push({ id: "sandbox", title: "Sandbox", status: "ok", detail: probe.launcher.name });
    else
      out.push({
        id: "sandbox",
        title: "Sandbox",
        status: cfg.claude.confinement === "required" ? "fail" : "warn",
        detail: `none works here (tried ${probe.tried.map((t) => t.name).join(", ") || "nothing"})`,
        fix:
          machine.os === "linux"
            ? "install bubblewrap (sudo apt install bubblewrap); on Ubuntu 24.04 see docs/vm-setup.md"
            : 'set [claude] confinement = "best-effort" only if you accept running Claude unconfined',
      });
    const adapter = claudeAdapterFor(paths, cfg, {
      launcher: probe.launcher ?? noLauncher,
      egress: { tcpPort: 0, socketPath: "" },
      runDir: paths.runDir,
    });
    const ready = await adapter.checkReady(true);
    out.push(
      ready.ready
        ? {
            id: "claude",
            title: "Claude",
            status: "ok",
            detail: `${ready.detail ?? "ready"} · signed in (sapi's profile)`,
          }
        : { id: "claude", title: "Claude", status: "fail", detail: ready.reason, fix: ready.fix },
    );
    if (o.offline) out.push({ id: "egress", title: "Network to Anthropic", status: "skip", detail: "--offline" });
    else {
      const err = await (o.reach ?? reachHost)("api.anthropic.com");
      out.push(
        err
          ? {
              id: "egress",
              title: "Network to Anthropic",
              status: "fail",
              detail: `api.anthropic.com:443: ${err}`,
              fix: "check this machine's internet connection, DNS and firewall",
            }
          : { id: "egress", title: "Network to Anthropic", status: "ok", detail: "api.anthropic.com:443 reachable" },
      );
    }
  }

  if (!cfg || !usesChatGpt(cfg)) {
    out.push({
      id: "chatgpt",
      title: "ChatGPT",
      status: "skip",
      detail: "no model alias uses the ChatGPT subscription",
    });
  } else {
    try {
      const store = await (o.openStore ?? (() => openSecretStore(paths, cfg.secrets.backend)))();
      const st = sessionState(parseSession(await store.get(SESSION_SECRET)), now);
      out.push(
        !st.ok
          ? { id: "chatgpt", title: "ChatGPT", status: "fail", detail: st.reason, fix: st.fix }
          : st.refreshTokenDaysLeft < 3
            ? {
                id: "chatgpt",
                title: "ChatGPT",
                status: "warn",
                detail: `signed in (${store.backend} store), but the sign-in lapses in ${st.refreshTokenDaysLeft} days without use`,
                fix: "send one request through a ChatGPT alias, or run sapi login chatgpt",
              }
            : {
                id: "chatgpt",
                title: "ChatGPT",
                status: "ok",
                detail: `signed in (${store.backend} store); renews on use, lapses after ${st.refreshTokenDaysLeft} idle days`,
              },
      );
    } catch (e) {
      out.push({
        id: "chatgpt",
        title: "ChatGPT",
        status: "fail",
        detail: `can't read the sign-in: ${(e as Error).message}`,
        fix: "sapi login chatgpt",
      });
    }
    if (o.offline) out.push({ id: "egress-openai", title: "Network to OpenAI", status: "skip", detail: "--offline" });
    else {
      const err = await (o.reach ?? reachHost)("api.openai.com");
      out.push(
        err
          ? {
              id: "egress-openai",
              title: "Network to OpenAI",
              status: "fail",
              detail: `api.openai.com:443: ${err}`,
              fix: "check this machine's internet connection, DNS and firewall",
            }
          : { id: "egress-openai", title: "Network to OpenAI", status: "ok", detail: "api.openai.com:443 reachable" },
      );
    }
  }

  // From a source checkout, sapi is run as `bun src/cli.ts`; only the installed binary belongs on PATH.
  if (isCompiled() && !Bun.which("sapi"))
    out.push({
      id: "path",
      title: "sapi on PATH",
      status: "warn",
      detail: `the sapi command isn't on your PATH (it is ${process.execPath})`,
      fix: `add its folder to PATH in your shell profile: export PATH="${dirname(process.execPath)}:$PATH"`,
    });
  return out;
}

function serviceFromMachine(paths: Paths, cfg: Config, machine: Machine): Service | null {
  const spec = serviceSpecFor(paths, cfg, machine);
  return spec ? new Service(spec) : null;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.title.length));
  const lines = checks.map((c) => {
    const head = ` ${MARK[c.status]} ${c.title.padEnd(width)}  ${c.detail}`;
    return c.fix && c.status !== "ok" ? `${head}\n   ${" ".repeat(width)}  fix: ${c.fix}` : head;
  });
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const summary =
    fails || warns
      ? `${fails} problem${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}.`
      : "Everything looks right.";
  return `${lines.join("\n")}\n\n${summary}`;
}
