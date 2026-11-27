/**
 * The background service (plan §5): a launchd agent on macOS, a systemd user unit with lingering
 * on Linux. Both run `sapi start --foreground` as the user, never as root.
 *
 * The unit and plist hold paths and nothing else: no keys, no tokens (ARI-42 GW-1). They pin
 * SAPI_CONFIG_DIR and SAPI_DATA_DIR so the service uses the same files as the CLI that installed
 * it. Every command is an argv array (no shell), and every value written into a file is checked
 * and escaped for that file's syntax.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Paths } from "../paths.ts";
import { pickEnv, type Runner, type RunResult, runSync, type ServiceManager, systemdEnv } from "./machine.ts";

export const SYSTEMD_UNIT = "sapi.service";
export const LAUNCHD_LABEL = "local.sapi.gateway";

export type ServiceSpec = {
  manager: Exclude<ServiceManager, "none">;
  /** How to run sapi: the binary, or bun plus src/cli.ts from a source checkout. */
  self: string[];
  paths: Paths;
  /** Extra directories for PATH, such as the one holding the claude CLI. */
  pathDirs: string[];
  /** XDG_CONFIG_HOME, when the user set one (systemd looks for user units there). */
  xdgConfigHome?: string;
};

export type ServiceFile = { file: string; content: string; logFile?: string };

function assertSafeValue(v: string, what: string): void {
  if (/[\0\n\r]/.test(v)) throw new Error(`${what} contains a control character`);
}

function assertAbsolute(p: string, what: string): void {
  assertSafeValue(p, what);
  if (!p.startsWith("/")) throw new Error(`${what} must be an absolute path: ${p.slice(0, 80)}`);
}

/** systemd: quote one word; `%` is a specifier and `$` an expansion, so both are doubled. */
export function systemdQuote(v: string): string {
  assertSafeValue(v, "a systemd value");
  return `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;
}

function xml(v: string): string {
  assertSafeValue(v, "a plist value");
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function serviceEnv(spec: ServiceSpec): Record<string, string> {
  const dirs = [...spec.pathDirs, dirname(spec.self[0] ?? "/usr/bin/sapi"), "/usr/local/bin", "/usr/bin", "/bin"];
  const unique = [...new Set(dirs.filter((d) => d.startsWith("/")))];
  return {
    SAPI_CONFIG_DIR: spec.paths.configDir,
    SAPI_DATA_DIR: spec.paths.dataDir,
    PATH: unique.join(":"),
  };
}

export function serviceFile(spec: ServiceSpec): ServiceFile {
  const [exe, ...rest] = spec.self;
  assertAbsolute(exe ?? "", "the sapi executable");
  for (const a of rest) assertSafeValue(a, "an argument");
  assertAbsolute(spec.paths.configDir, "the config directory");
  assertAbsolute(spec.paths.dataDir, "the data directory");
  for (const d of spec.pathDirs) assertAbsolute(d, "a PATH directory");
  const argv = [...spec.self, "start", "--foreground"];
  const env = serviceEnv(spec);

  if (spec.manager === "systemd") {
    const base = spec.xdgConfigHome?.startsWith("/") ? spec.xdgConfigHome : join(spec.paths.home, ".config");
    const lines = [
      "# Written by `sapi service install`; remove it with `sapi service uninstall`.",
      "# It holds paths only: client keys and sign-ins never appear here.",
      "[Unit]",
      "Description=sapi: local gateway for your own AI subscriptions",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${argv.map(systemdQuote).join(" ")}`,
      ...Object.entries(env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
      "UMask=0077",
      "NoNewPrivileges=yes",
      "Restart=on-failure",
      "RestartSec=5",
      "TimeoutStopSec=20",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ];
    return { file: join(base, "systemd", "user", SYSTEMD_UNIT), content: lines.join("\n") };
  }

  const logFile = join(spec.paths.dataDir, "logs", "sapi.log");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`sapi service install\`; remove it with \`sapi service uninstall\`. Paths only, no keys. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>WorkingDirectory</key>
  <string>${xml(spec.paths.dataDir)}</string>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`;
  return { file: join(spec.paths.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`), content, logFile };
}

export type ServiceState = "not-installed" | "stopped" | "running";

export type ServiceDeps = {
  run: Runner;
  env: Record<string, string | undefined>;
  uid: number;
  user: string;
  write: (file: string, content: string) => void;
  remove: (file: string) => void;
  exists: (file: string) => boolean;
};

export function realServiceDeps(): ServiceDeps {
  return {
    run: runSync,
    // Only what systemctl --user needs to find the user manager; children get systemdEnv() only.
    env: pickEnv(["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    user: process.env.USER ?? process.env.LOGNAME ?? "",
    write: (file, content) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, content, { mode: 0o644 });
      chmodSync(file, 0o644);
    },
    remove: (file) => rmSync(file, { force: true }),
    exists: existsSync,
  };
}

export type StepResult = { ok: boolean; done: string[]; warnings: string[]; error?: string };

/** Install, remove, start, stop and inspect the service. */
export class Service {
  readonly file: ServiceFile;

  constructor(
    readonly spec: ServiceSpec,
    private readonly d: ServiceDeps = realServiceDeps(),
  ) {
    this.file = serviceFile(spec);
  }

  private sd(args: string[]): RunResult {
    return this.d.run(["systemctl", "--user", ...args], { env: systemdEnv(this.d.env, this.d.uid), timeoutMs: 30_000 });
  }

  /** launchd: the GUI session when someone is logged in at the desktop, else the user domain. */
  private domain(): string {
    const gui = `gui/${this.d.uid}`;
    return this.d.run(["/bin/launchctl", "print", gui], { timeoutMs: 5000 }).code === 0 ? gui : `user/${this.d.uid}`;
  }

  private lc(args: string[]): RunResult {
    return this.d.run(["/bin/launchctl", ...args], { timeoutMs: 30_000 });
  }

  installed(): boolean {
    return this.d.exists(this.file.file);
  }

  state(): ServiceState {
    if (!this.installed()) return "not-installed";
    if (this.spec.manager === "systemd") {
      return this.sd(["is-active", SYSTEMD_UNIT]).stdout.trim() === "active" ? "running" : "stopped";
    }
    const r = this.lc(["print", `${this.domain()}/${LAUNCHD_LABEL}`]);
    return r.code === 0 && /\bstate = running\b/.test(r.stdout) ? "running" : "stopped";
  }

  install(): StepResult {
    const done: string[] = [];
    const warnings: string[] = [];
    if (this.file.logFile) mkdirSync(dirname(this.file.logFile), { recursive: true, mode: 0o700 });
    this.d.write(this.file.file, this.file.content);
    done.push(`wrote ${this.file.file}`);
    if (this.spec.manager === "systemd") {
      for (const args of [["daemon-reload"], ["enable", SYSTEMD_UNIT], ["restart", SYSTEMD_UNIT]]) {
        const r = this.sd(args);
        if (r.code !== 0) return { ok: false, done, warnings, error: `systemctl --user ${args.join(" ")}: ${tail(r)}` };
      }
      done.push(`enabled and started ${SYSTEMD_UNIT}`);
      const env = systemdEnv(this.d.env, this.d.uid);
      const who = this.d.user || String(this.d.uid);
      const linger = this.d.run(["loginctl", "show-user", who, "--property=Linger", "--value"], { env });
      if (linger.stdout.trim() !== "yes") {
        const r = this.d.run(["loginctl", "enable-linger", who], { env, timeoutMs: 15_000 });
        if (r.code === 0) done.push("turned on lingering, so sapi keeps running after you log out");
        else
          warnings.push(
            `sapi stops when you log out until lingering is on. Turn it on with: sudo loginctl enable-linger ${who}`,
          );
      }
      return { ok: true, done, warnings };
    }
    const domain = this.domain();
    this.lc(["bootout", `${domain}/${LAUNCHD_LABEL}`]); // an older copy, if loaded; errors are fine
    for (const args of [
      ["bootstrap", domain, this.file.file],
      ["enable", `${domain}/${LAUNCHD_LABEL}`],
      ["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`],
    ]) {
      const r = this.lc(args);
      if (r.code !== 0) return { ok: false, done, warnings, error: `launchctl ${args.join(" ")}: ${tail(r)}` };
    }
    done.push(`loaded ${LAUNCHD_LABEL} (${domain}); it starts again at login`);
    return { ok: true, done, warnings };
  }

  uninstall(): StepResult {
    const done: string[] = [];
    if (this.spec.manager === "systemd") {
      this.sd(["disable", "--now", SYSTEMD_UNIT]);
      if (this.installed()) {
        this.d.remove(this.file.file);
        done.push(`removed ${this.file.file}`);
      }
      this.sd(["daemon-reload"]);
      this.sd(["reset-failed", SYSTEMD_UNIT]);
      return { ok: true, done, warnings: [] };
    }
    this.lc(["bootout", `${this.domain()}/${LAUNCHD_LABEL}`]);
    if (this.installed()) {
      this.d.remove(this.file.file);
      done.push(`removed ${this.file.file}`);
    }
    return { ok: true, done, warnings: [] };
  }

  start(): StepResult {
    if (!this.installed()) return { ok: false, done: [], warnings: [], error: "the service isn't installed" };
    if (this.spec.manager === "systemd") {
      const r = this.sd(["start", SYSTEMD_UNIT]);
      return r.code === 0
        ? { ok: true, done: [`started ${SYSTEMD_UNIT}`], warnings: [] }
        : { ok: false, done: [], warnings: [], error: tail(r) };
    }
    const domain = this.domain();
    if (this.lc(["print", `${domain}/${LAUNCHD_LABEL}`]).code !== 0) {
      const b = this.lc(["bootstrap", domain, this.file.file]);
      if (b.code !== 0) return { ok: false, done: [], warnings: [], error: tail(b) };
    }
    const r = this.lc(["kickstart", `${domain}/${LAUNCHD_LABEL}`]);
    return r.code === 0
      ? { ok: true, done: [`started ${LAUNCHD_LABEL}`], warnings: [] }
      : { ok: false, done: [], warnings: [], error: tail(r) };
  }

  stop(): StepResult {
    if (!this.installed()) return { ok: false, done: [], warnings: [], error: "the service isn't installed" };
    if (this.spec.manager === "systemd") {
      const r = this.sd(["stop", SYSTEMD_UNIT]);
      return r.code === 0
        ? { ok: true, done: [`stopped ${SYSTEMD_UNIT} (it starts again at boot)`], warnings: [] }
        : { ok: false, done: [], warnings: [], error: tail(r) };
    }
    this.lc(["bootout", `${this.domain()}/${LAUNCHD_LABEL}`]);
    return { ok: true, done: [`stopped ${LAUNCHD_LABEL} (it starts again at login)`], warnings: [] };
  }
}

function tail(r: RunResult): string {
  return (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300) || `exit ${r.code}`;
}
