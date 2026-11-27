/**
 * Where sapi keeps its files. XDG layout on every OS (macOS included), overridable with
 * SAPI_CONFIG_DIR and SAPI_DATA_DIR. Directories are 0700 and files 0600 (plan §6).
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Paths = {
  home: string;
  configDir: string;
  configFile: string;
  /** Advanced: a file holding CLAUDE_CODE_OAUTH_TOKEN for `auth = "env"` mode. Read only to pass it to the child. */
  claudeEnvFile: string;
  dataDir: string;
  dbFile: string;
  /** sapi's own Claude profile (CLAUDE_CONFIG_DIR for the child). Separate from the user's. */
  claudeProfileDir: string;
  /** Parent of the per-request work directories. */
  runDir: string;
};

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = homedir();
  const configDir = env.SAPI_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "sapi");
  const dataDir = env.SAPI_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "sapi");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    home,
    configDir,
    configFile: join(configDir, "config.toml"),
    claudeEnvFile: join(configDir, "claude.env"),
    dataDir,
    dbFile: join(dataDir, "sapi.db"),
    claudeProfileDir: join(dataDir, "claude-profile"),
    runDir: join(env.SAPI_RUN_DIR || tmpdir(), `sapi-${uid}`),
  };
}

/**
 * Create a private directory (0700) or tighten an existing one. Refuses a directory owned by
 * someone else, since another user could then swap files under us.
 */
export function ensurePrivateDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} exists and is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user; refusing to use it`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return realpathSync(dir);
}

/** Refuse a file that other users could change (a config or token file). */
export function assertNotWritableByOthers(file: string): void {
  const st = statSync(file);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${file} is owned by another user; refusing to use it`);
  }
  if ((st.mode & 0o022) !== 0) throw new Error(`${file} is writable by other users. Fix it with: chmod 600 ${file}`);
}

/** Refuse a secret file that other users could read. */
export function assertPrivateFile(file: string): void {
  assertNotWritableByOthers(file);
  if ((statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} is readable by other users. Fix it with: chmod 600 ${file}`);
  }
}
