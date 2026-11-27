/**
 * What kind of machine sapi is on (plan §5): OS, CPU, desktop or headless, SSH session,
 * container, WSL, which service manager works, whether the port is free, and root (refused).
 *
 * Every probe goes through `MachineDeps` so tests can describe a machine without being on it.
 * Probes only read: nothing here changes the system.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";

export type ServiceManager = "launchd" | "systemd" | "none";

export type Machine = {
  os: "macos" | "linux" | "other";
  /** "macOS 26.2", "Ubuntu 24.04.1 LTS", ... */
  osName: string;
  arch: string;
  ssh: boolean;
  /** No graphical session: sign-ins must work from a link opened on another device. */
  headless: boolean;
  container: boolean;
  wsl: boolean;
  root: boolean;
  serviceManager: ServiceManager;
  /** Why no service manager works, when none does. */
  serviceProblem?: string;
  /** Linux: whether the systemd user manager keeps running after logout (loginctl linger). */
  linger?: boolean;
};

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) => RunResult;

export type MachineDeps = {
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  uid: number;
  user: string;
  exists: (p: string) => boolean;
  read: (p: string) => string | null;
  run: Runner;
};

/** Run a program with an argv array (never a shell) and a short timeout. */
export const runSync: Runner = (argv, opts = {}) => {
  const [cmd, ...args] = argv;
  if (!cmd) return { code: 127, stdout: "", stderr: "no command" };
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 10_000,
    ...(opts.env ? { env: opts.env } : {}),
  });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** A copy of just the named environment variables. */
export function pickEnv(names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}

/** The variables machine detection looks at, and no others. */
const DETECT_ENV = [
  "SSH_CONNECTION",
  "SSH_TTY",
  "SSH_CLIENT",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "WSL_DISTRO_NAME",
  "container",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

export function realMachineDeps(): MachineDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: pickEnv(DETECT_ENV),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    user: process.env.USER ?? process.env.LOGNAME ?? "",
    exists: existsSync,
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    run: runSync,
  };
}

/** The environment systemctl --user and loginctl need, and nothing else. */
export function systemdEnv(env: Record<string, string | undefined>, uid: number): Record<string, string> {
  const out: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin" };
  out.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  out.DBUS_SESSION_BUS_ADDRESS = env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${out.XDG_RUNTIME_DIR}/bus`;
  return out;
}

function linuxName(d: MachineDeps): string {
  const text = d.read("/etc/os-release") ?? "";
  const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text);
  return m?.[1]?.slice(0, 60) ?? "Linux";
}

function inContainer(d: MachineDeps): boolean {
  if (d.exists("/.dockerenv") || d.exists("/run/.containerenv")) return true;
  if (d.env.container) return true;
  const cg = d.read("/proc/1/cgroup") ?? "";
  return /docker|kubepods|containerd|libpod|lxc/.test(cg);
}

export function detectMachine(d: MachineDeps = realMachineDeps()): Machine {
  const ssh = Boolean(d.env.SSH_CONNECTION || d.env.SSH_TTY || d.env.SSH_CLIENT);
  const root = d.uid === 0;
  if (d.platform === "darwin") {
    const v = d.run(["/usr/bin/sw_vers", "-productVersion"]).stdout.trim();
    const launchctl = d.exists("/bin/launchctl");
    return {
      os: "macos",
      osName: v ? `macOS ${v}` : "macOS",
      arch: d.arch,
      ssh,
      headless: ssh,
      container: false,
      wsl: false,
      root,
      serviceManager: launchctl ? "launchd" : "none",
      ...(launchctl ? {} : { serviceProblem: "launchctl wasn't found" }),
    };
  }
  if (d.platform === "linux") {
    const wsl = Boolean(d.env.WSL_DISTRO_NAME) || /microsoft/i.test(d.read("/proc/version") ?? "");
    const container = inContainer(d);
    const headless = !d.env.DISPLAY && !d.env.WAYLAND_DISPLAY;
    const env = systemdEnv(d.env, d.uid);
    let serviceManager: ServiceManager = "none";
    let serviceProblem: string | undefined;
    let linger: boolean | undefined;
    const probe = d.run(["systemctl", "--user", "show-environment"], { env, timeoutMs: 5000 });
    if (probe.code === 0) {
      serviceManager = "systemd";
      const l = d.run(["loginctl", "show-user", d.user || String(d.uid), "--property=Linger", "--value"], {
        env,
        timeoutMs: 5000,
      });
      linger = l.code === 0 ? l.stdout.trim() === "yes" : false;
    } else if (container) {
      serviceProblem = "this is a container; run sapi in the foreground or under the container's own supervisor";
    } else if (wsl) {
      serviceProblem = "systemd isn't enabled in this WSL distribution (set systemd=true in /etc/wsl.conf)";
    } else {
      serviceProblem = "the systemd user manager isn't reachable from this session";
    }
    return {
      os: "linux",
      osName: linuxName(d),
      arch: d.arch,
      ssh,
      headless,
      container,
      wsl,
      root,
      serviceManager,
      ...(serviceProblem ? { serviceProblem } : {}),
      ...(linger !== undefined ? { linger } : {}),
    };
  }
  return {
    os: "other",
    osName: d.platform,
    arch: d.arch,
    ssh,
    headless: true,
    container: false,
    wsl: false,
    root,
    serviceManager: "none",
    serviceProblem: "sapi supports macOS and Linux",
  };
}

export type PortState = "free" | "sapi" | "busy";

/** Is the loopback port free, already serving sapi, or taken by something else? */
export async function portState(host: string, port: number): Promise<PortState> {
  const free = await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
  if (free) return "free";
  return (await isSapiHealthy(host, port)) ? "sapi" : "busy";
}

/** GET /healthz with a short timeout. */
export async function isSapiHealthy(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    const r = await fetch(`http://${h}:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const body = (await r.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/** Wait until /healthz answers, for up to `timeoutMs`. */
export async function waitHealthy(host: string, port: number, timeoutMs = 15_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await isSapiHealthy(host, port, 1000)) return true;
    await Bun.sleep(250);
  }
  return false;
}

export function describeMachine(m: Machine): string {
  const parts = [m.osName, m.arch];
  if (m.wsl) parts.push("WSL");
  if (m.container) parts.push("container");
  parts.push(m.ssh ? "SSH session" : m.headless ? "no desktop" : "desktop");
  if (m.headless) parts.push("sign-ins by link");
  return parts.join(" · ");
}
