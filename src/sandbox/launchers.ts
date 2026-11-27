/**
 * Launchers confine a provider child process (ARI-42 OUT-4, INJ-4, GW-1).
 *
 *   macOS   sandbox-exec with a profile that denies all outbound network except sapi's egress
 *           proxy on loopback, denies writes outside the Claude profile and the request's work
 *           dir, and denies reads of secret folders and sapi's own data and config.
 *   Linux   bwrap: no network namespace access at all (--unshare-all), read-only root, a tmpfs
 *           over the home directory, only the profile and work dir writable. The egress proxy is
 *           reached through a bind-mounted Unix socket that sapi's own bridge exposes on
 *           127.0.0.1 inside the sandbox.
 *   Linux   fallback when bwrap can't create namespaces: a transient systemd user service with
 *           PrivateUsers, PrivateNetwork, ProtectSystem=strict and ProtectHome=tmpfs.
 *   none    only allowed with `confinement = "best-effort"`; the environment is still minimal and
 *           egress still goes through the proxy, but nothing stops a direct connection.
 *
 * Every path passed to a launcher must already be resolved with realpath (Phase 0 finding: the
 * macOS sandbox matches /private/var/..., not /var/...).
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

export type LauncherName = "sandbox-exec" | "bwrap" | "systemd-run" | "none";

export type LaunchSpec = {
  /** Inner command; argv[0] must be an absolute path. */
  argv: string[];
  /** Already minimal and explicit; launchers only add the proxy variables. */
  env: Record<string, string>;
  workDir: string;
  /** The Claude profile: the only persistent path the child may write. */
  profileDir: string;
  /** Files and directories under the home directory the child must be able to read (its binary). */
  readOnlyPaths: string[];
  /** sapi's own data and config directories: never readable from the child. */
  hiddenPaths: string[];
  hostHome: string;
  /**
   * macOS only, and only with auth = "cli": the user's login keychain folder. The CLI keeps its
   * sign-in in the login keychain and writes the keychain file itself when it saves a refreshed
   * token, so the sandbox lets it write there. Unset, nothing under it is writable.
   */
  keychainDir?: string;
  egress: { tcpPort: number; socketPath: string };
  /** How to start sapi's egress bridge inside a Linux sandbox. */
  bridgeCommand: string[];
  memoryMaxMb: number;
  timeoutSec: number;
};

export type Launched = { argv: string[]; env: Record<string, string>; cwd: string };

/** Port the bridge listens on inside the Linux sandbox's private network namespace. */
export const BRIDGE_PORT = 18080;

const PROXY_VARS = (url: string) => ({
  HTTPS_PROXY: url,
  https_proxy: url,
  HTTP_PROXY: url,
  http_proxy: url,
  NO_PROXY: "",
  no_proxy: "",
});

/** Folders under the real home that the macOS child may never read. */
export const MACOS_DENIED_HOME_PATHS = [
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".docker",
  ".config",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".claude",
  ".claude.json",
  ".codex",
  "Documents",
  "Desktop",
  "Downloads",
  "Library/Mail",
  "Library/Messages",
  "Library/Cookies",
];

export const MACOS_PROFILE = `(version 1)
(allow default)
;; Network: nothing out except sapi's egress proxy on loopback. No direct DNS.
(deny network-outbound)
(allow network-outbound (remote ip (string-append "localhost:" (param "PROXYPORT"))))
;; Files: writes only to sapi's Claude profile, the request's work dir, the login keychain folder
;; (CLI sign-in only: the CLI saves refreshed tokens there) and a few devices.
(deny file-write*)
(allow file-write*
  (subpath (param "PROFILE"))
  (subpath (param "WORKDIR"))
  (subpath (param "KEYCHAINS"))
  (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))
;; Reads: no secret folders, no personal folders, no sapi data or config.
(deny file-read*
${MACOS_DENIED_HOME_PATHS.map((p) => `  (subpath (string-append (param "HOSTHOME") "/${p}"))`).join("\n")}
  (subpath (param "SAPIDATA"))
  (subpath (param "SAPICONFIG")))
;; ...except the profile and the work dir themselves.
(allow file-read* (subpath (param "PROFILE")) (subpath (param "WORKDIR")))
`;

export interface Launcher {
  readonly name: LauncherName;
  wrap(spec: LaunchSpec): Launched;
}

function assertAbsolute(paths: string[]): void {
  for (const p of paths) {
    if (!p.startsWith("/")) throw new Error(`launcher paths must be absolute: ${p}`);
    if (/[\n\r\0]/.test(p)) throw new Error("launcher paths must not contain control characters");
  }
}

export const sandboxExecLauncher: Launcher = {
  name: "sandbox-exec",
  wrap(s) {
    assertAbsolute([s.workDir, s.profileDir, s.hostHome, ...s.hiddenPaths, ...(s.keychainDir ? [s.keychainDir] : [])]);
    const [data = "/nonexistent-sapi-data", config = "/nonexistent-sapi-config"] = s.hiddenPaths;
    return {
      argv: [
        "/usr/bin/sandbox-exec",
        "-p",
        MACOS_PROFILE,
        "-D",
        `PROFILE=${s.profileDir}`,
        "-D",
        `WORKDIR=${s.workDir}`,
        "-D",
        `PROXYPORT=${s.egress.tcpPort}`,
        "-D",
        `HOSTHOME=${s.hostHome}`,
        "-D",
        `SAPIDATA=${data}`,
        "-D",
        `SAPICONFIG=${config}`,
        "-D",
        `KEYCHAINS=${s.keychainDir ?? "/nonexistent-sapi-keychains"}`,
        ...s.argv,
      ],
      env: { ...s.env, ...PROXY_VARS(`http://127.0.0.1:${s.egress.tcpPort}`) },
      cwd: s.workDir,
    };
  },
};

export const bwrapLauncher: Launcher = {
  name: "bwrap",
  wrap(s) {
    assertAbsolute([s.workDir, s.profileDir, s.hostHome, s.egress.socketPath, ...s.readOnlyPaths, ...s.hiddenPaths]);
    const a = [
      bin("bwrap"),
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      s.hostHome,
    ];
    // sapi's data and config usually live under the home tmpfs already; hide them if not.
    for (const p of s.hiddenPaths) if (!isUnder(p, s.hostHome) && existsSync(p)) a.push("--tmpfs", p);
    for (const p of s.readOnlyPaths) a.push("--ro-bind", p, p);
    a.push("--bind", s.profileDir, s.profileDir, "--bind", s.workDir, s.workDir);
    a.push("--bind", s.egress.socketPath, s.egress.socketPath);
    a.push("--chdir", s.workDir, "--", ...s.bridgeCommand);
    a.push("--socket", s.egress.socketPath, "--port", String(BRIDGE_PORT), "--", ...s.argv);
    return { argv: a, env: { ...s.env, ...PROXY_VARS(`http://127.0.0.1:${BRIDGE_PORT}`) }, cwd: s.workDir };
  },
};

export const systemdRunLauncher: Launcher = {
  name: "systemd-run",
  wrap(s) {
    const paths = [s.workDir, s.profileDir, s.hostHome, s.egress.socketPath, ...s.readOnlyPaths];
    assertAbsolute(paths);
    if (paths.some((p) => /\s/.test(p))) throw new Error("the systemd-run launcher needs paths without spaces");
    if (Object.keys(s.env).includes("CLAUDE_CODE_OAUTH_TOKEN")) {
      // --setenv values are stored in the transient unit and visible to `systemctl --user show`.
      throw new Error('auth = "env" is not supported with the systemd-run fallback; use bwrap or auth = "cli"');
    }
    const env = { ...s.env, ...PROXY_VARS(`http://127.0.0.1:${BRIDGE_PORT}`) };
    const a = [
      bin("systemd-run"),
      "--user",
      "--pipe",
      "--wait",
      "--quiet",
      "--collect",
      "-p",
      "PrivateUsers=yes",
      "-p",
      "PrivateNetwork=yes",
      "-p",
      "ProtectSystem=strict",
      "-p",
      "ProtectHome=tmpfs",
      "-p",
      "PrivateTmp=yes",
      "-p",
      "NoNewPrivileges=yes",
      "-p",
      `BindPaths=${s.profileDir} ${s.workDir} ${s.egress.socketPath}`,
      "-p",
      `MemoryMax=${s.memoryMaxMb}M`,
      "-p",
      `RuntimeMaxSec=${s.timeoutSec}`,
      "-p",
      `WorkingDirectory=${s.workDir}`,
    ];
    if (s.readOnlyPaths.length) a.push("-p", `BindReadOnlyPaths=${s.readOnlyPaths.join(" ")}`);
    for (const [k, v] of Object.entries(env)) a.push(`--setenv=${k}=${v}`);
    a.push("--", ...s.bridgeCommand, "--socket", s.egress.socketPath, "--port", String(BRIDGE_PORT), "--", ...s.argv);
    // systemd-run itself only needs to find the user manager.
    const outer: Record<string, string> = { PATH: "/usr/bin:/bin" };
    for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const) {
      const v = process.env[k];
      if (v) outer[k] = v;
    }
    return { argv: a, env: outer, cwd: s.workDir };
  },
};

export const noLauncher: Launcher = {
  name: "none",
  wrap(s) {
    return { argv: s.argv, env: { ...s.env, ...PROXY_VARS(`http://127.0.0.1:${s.egress.tcpPort}`) }, cwd: s.workDir };
  },
};

/** Absolute path of a system tool, so lookup never depends on the child's PATH. */
function bin(name: string): string {
  return Bun.which(name, { PATH: "/usr/bin:/bin:/usr/local/bin" }) ?? `/usr/bin/${name}`;
}

function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

function works(argv: string[], env: Record<string, string> = { PATH: "/usr/bin:/bin" }): boolean {
  try {
    const r = spawnSync(argv[0]!, argv.slice(1), { env, stdio: "ignore", timeout: 15_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export type LauncherProbe = { launcher: Launcher | null; tried: Array<{ name: LauncherName; ok: boolean }> };

/** Find the strongest launcher that works on this machine. */
export function detectLauncher(platform: NodeJS.Platform = process.platform): LauncherProbe {
  const tried: LauncherProbe["tried"] = [];
  const attempt = (l: Launcher, argv: string[], env?: Record<string, string>) => {
    const ok = works(argv, env);
    tried.push({ name: l.name, ok });
    return ok ? l : null;
  };
  if (platform === "darwin") {
    const l = attempt(sandboxExecLauncher, [
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1)(allow default)",
      "/usr/bin/true",
    ]);
    return { launcher: l, tried };
  }
  if (platform === "linux") {
    const bw = attempt(bwrapLauncher, [
      "bwrap",
      "--unshare-all",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "true",
    ]);
    if (bw) return { launcher: bw, tried };
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[k]) env[k] = process.env[k]!;
    const sd = attempt(
      systemdRunLauncher,
      [
        "systemd-run",
        "--user",
        "--pipe",
        "--wait",
        "--quiet",
        "--collect",
        "-p",
        "PrivateUsers=yes",
        "-p",
        "PrivateNetwork=yes",
        "true",
      ],
      env,
    );
    return { launcher: sd, tried };
  }
  return { launcher: null, tried };
}

/** realpath, or the path itself when it doesn't exist yet. */
export function resolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
