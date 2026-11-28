/**
 * The Claude CLI during setup: find it, install the tested version with Anthropic's official
 * installer (only after the user says yes), and hand the terminal to `claude auth login|logout`
 * inside sapi's own profile. sapi never reads the CLI's login (AGENTS.md); it checks exit codes.
 *
 * The installer is the one place sapi runs a shell script: Anthropic's own, fetched over HTTPS
 * from claude.ai, saved to a private file, shown with its SHA-256, and run with bash from an argv
 * array with a fixed version argument and a minimal environment. The installer then checks the
 * downloaded binary against Anthropic's release manifest itself.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { versionInRange } from "../config.ts";
import { ensurePrivateDir, type Paths } from "../paths.ts";
import { claudeChildEnv } from "../providers/claude-sub/spawn.ts";

/** The claude CLI release sapi was last tested against (docs/providers/claude-sub.md). */
export const TESTED_CLAUDE_VERSION = "2.1.332";
export const CLAUDE_INSTALLER_URL = "https://claude.ai/install.sh";

/** The places Anthropic's installer puts the CLI, for shells that haven't picked up PATH yet. */
export function findClaude(home: string, configured = "claude"): string | null {
  if (configured.startsWith("/")) return existsSync(configured) ? configured : null;
  const onPath = Bun.which(configured);
  if (onPath) return onPath;
  for (const p of [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")])
    if (existsSync(p)) return p;
  return null;
}

function cliEnv(bin: string, paths: Paths): Record<string, string> {
  return claudeChildEnv({
    binaryDir: dirname(bin),
    home: paths.home,
    user: userInfo().username,
    profileDir: ensurePrivateDir(paths.claudeProfileDir),
  });
}

export function claudeVersion(bin: string, paths: Paths): string | null {
  const r = spawnSync(bin, ["--version"], { env: cliEnv(bin, paths), encoding: "utf8", timeout: 15_000 });
  return /(\d+\.\d+\.\d+)/.exec(r.stdout ?? "")?.[1] ?? null;
}

export function claudeVersionOk(version: string | null, range: string): boolean {
  return version !== null && versionInRange(version, range);
}

/** Hand the terminal to the real `claude auth login`, pointed at sapi's own profile. */
export function claudeLogin(bin: string, paths: Paths): boolean {
  const env = cliEnv(bin, paths);
  if (process.env.TERM) env.TERM = process.env.TERM;
  if (process.env.BROWSER) env.BROWSER = process.env.BROWSER;
  spawnSync(bin, ["auth", "login"], { env, stdio: "inherit" });
  return spawnSync(bin, ["auth", "status"], { env, stdio: "ignore", timeout: 15_000 }).status === 0;
}

/** Whether sapi's profile is signed in, by the exit code of `claude auth status` only. */
export function claudeProfileSignedIn(bin: string, paths: Paths): boolean {
  return spawnSync(bin, ["auth", "status"], { env: cliEnv(bin, paths), stdio: "ignore", timeout: 15_000 }).status === 0;
}

/** Sign sapi's profile out (removes its keychain entry on macOS). Exit code only. */
export function claudeLogout(bin: string, paths: Paths): boolean {
  const r = spawnSync(bin, ["auth", "logout"], { env: cliEnv(bin, paths), stdio: "ignore", timeout: 30_000 });
  return r.status === 0;
}

type InstallerResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
};

export type InstallerDeps = {
  /** Must not follow redirects itself: installerText checks each hop. */
  fetch: (url: string) => Promise<InstallerResponse>;
  run: (argv: string[], env: Record<string, string>, cwd: string) => number;
  info: (line: string) => void;
};

const realInstallerDeps = (info: (l: string) => void): InstallerDeps => ({
  fetch: (url) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) }),
  run: (argv, env, cwd) =>
    spawnSync(argv[0]!, argv.slice(1), { env, cwd, stdio: "inherit", timeout: 15 * 60_000 }).status ?? 1,
  info,
});

/** claude.ai/install.sh redirects to Anthropic's download host; nowhere else is followed. */
const INSTALLER_HOSTS = new Set(["claude.ai", "downloads.claude.ai"]);

export async function installerText(fetchImpl: InstallerDeps["fetch"]): Promise<string> {
  let url = CLAUDE_INSTALLER_URL;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetchImpl(url);
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get("location") ?? "", url);
      if (next.protocol !== "https:" || !INSTALLER_HOSTS.has(next.hostname))
        throw new Error(
          `The installer download was redirected to ${next.hostname.slice(0, 80)}, which isn't Anthropic's, so it was stopped.`,
        );
      url = next.href;
      continue;
    }
    if (!res.ok) throw new Error(`Couldn't download Anthropic's installer (HTTP ${res.status}).`);
    return res.text();
  }
  throw new Error("Too many redirects while downloading Anthropic's installer.");
}

/** Basic shape checks before running anything: Anthropic's bash installer, small, pointing at its CDN. */
export function looksLikeClaudeInstaller(text: string): boolean {
  return (
    text.length > 200 &&
    text.length < 256_000 &&
    text.startsWith("#!/bin/bash") &&
    text.includes("https://downloads.claude.ai/") &&
    text.includes("checksum")
  );
}

/**
 * Install TESTED_CLAUDE_VERSION with Anthropic's installer. Returns the installed binary path, or
 * throws with a message the user can act on.
 */
export async function installClaude(
  paths: Paths,
  info: (line: string) => void,
  deps: InstallerDeps = realInstallerDeps(info),
): Promise<string> {
  const text = await installerText(deps.fetch);
  if (!looksLikeClaudeInstaller(text))
    throw new Error(`${CLAUDE_INSTALLER_URL} didn't look like Anthropic's installer, so it wasn't run.`);
  const dir = mkdtempSync(join(ensurePrivateDir(paths.runDir), "claude-install-"));
  const file = join(dir, "install.sh");
  try {
    writeFileSync(file, text, { mode: 0o600 });
    info(
      `Anthropic's installer (sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 16)}…) installs claude ${TESTED_CLAUDE_VERSION}:`,
    );
    const env: Record<string, string> = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: paths.home,
      USER: userInfo().username,
      LANG: process.env.LANG ?? "C.UTF-8",
      // Anything the installer's own `claude install` step writes goes to sapi's profile, not yours.
      CLAUDE_CONFIG_DIR: ensurePrivateDir(paths.claudeProfileDir),
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    if (process.env.TERM) env.TERM = process.env.TERM;
    const code = deps.run(["/bin/bash", file, TESTED_CLAUDE_VERSION], env, dir);
    if (code !== 0) throw new Error(`Anthropic's installer stopped with exit code ${code}.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Where Anthropic's installer puts it; checked before PATH so an older copy elsewhere doesn't win.
  const installed = join(paths.home, ".local", "bin", "claude");
  if (existsSync(installed)) return installed;
  const bin = findClaude(paths.home);
  if (!bin) throw new Error("The installer finished but claude wasn't found in ~/.local/bin.");
  return bin;
}
