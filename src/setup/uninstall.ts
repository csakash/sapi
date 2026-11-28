/**
 * `sapi uninstall [--purge]` (plan §5): removes the service and the binary. `--purge` also signs
 * sapi's Claude profile out (on macOS that removes its keychain entry, which deleting the folder
 * alone would leave behind) and deletes sapi's config, data and temporary folders.
 *
 * Deletion is guarded: only folders that are recognisably sapi's are removed, never the home
 * folder, a filesystem root or a shallow system path, and the user confirms unless --yes.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { loadConfig, parseConfig } from "../config.ts";
import type { Paths } from "../paths.ts";
import { isCompiled } from "../start.ts";
import { claudeLogout, claudeProfileSignedIn, findClaude } from "./claude.ts";
import { absolutePaths, Service, serviceSpecFor } from "./context.ts";
import { detectMachine, type Machine } from "./machine.ts";
import type { ServiceDeps } from "./service.ts";
import type { SetupIo } from "./setup.ts";

const MARKERS = ["sapi.db", "config.toml", "claude-profile", "claude.env"];

/** Why a folder must not be deleted, or null when it is safe to remove as sapi's. */
export function unsafeToDelete(dir: string, home = homedir()): string | null {
  const abs = resolve(dir);
  const depth = abs.split(sep).filter(Boolean).length;
  if (abs === resolve(home)) return "it is your home folder";
  if (depth < 2) return "it is too close to the filesystem root";
  if (resolve(home).startsWith(`${abs}${sep}`)) return "it contains your home folder";
  if (basename(abs) === "sapi" || /^sapi-\d+$/.test(basename(abs))) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(abs);
  } catch {
    return null; // nothing there
  }
  if (entries.some((e) => MARKERS.includes(e))) return null;
  return "it doesn't look like a sapi folder";
}

export type UninstallOptions = { purge: boolean; yes: boolean };
export type UninstallDeps = {
  machine?: Machine;
  serviceDeps?: ServiceDeps;
  /** The installed binary to remove; defaults to this executable when it is the compiled binary. */
  binary?: string | null;
  logout?: (bin: string, paths: Paths) => boolean;
  signedIn?: (bin: string, paths: Paths) => boolean;
};

export async function runUninstall(
  rawPaths: Paths,
  o: UninstallOptions,
  io: SetupIo,
  deps: UninstallDeps = {},
): Promise<number> {
  const paths = absolutePaths(rawPaths);
  let failed = false;
  const ok = (l: string) => io.info(` ✓ ${l}`);
  const bad = (l: string) => io.info(` ✗ ${l}`);
  let cfg = parseConfig({});
  try {
    cfg = loadConfig(paths.configFile);
  } catch {
    // A broken config shouldn't block removal; defaults are enough to find the service.
  }

  const machine = deps.machine ?? detectMachine();
  const spec = serviceSpecFor(paths, cfg, machine);
  if (spec) {
    const svc = new Service(spec, deps.serviceDeps);
    if (svc.installed()) {
      const r = svc.uninstall();
      for (const d of r.done) ok(d);
    } else ok("no background service installed");
  }

  const binary = deps.binary !== undefined ? deps.binary : isCompiled() ? process.execPath : null;
  if (binary && existsSync(binary)) {
    if (await io.confirm(`Remove ${binary}?`, true)) {
      rmSync(binary, { force: true });
      ok(`removed ${binary}`);
    }
  } else if (!binary) io.info(" - running from source: no binary to remove");

  if (!o.purge) {
    io.info(`\nKept your config and data:\n  ${paths.configDir}\n  ${paths.dataDir}`);
    io.info("Remove them too (and sign sapi's Claude profile out) with: sapi uninstall --purge");
    return 0;
  }

  const dirs = [paths.configDir, paths.dataDir, paths.runDir].filter((d) => existsSync(d));
  for (const d of dirs) {
    const why = unsafeToDelete(d, paths.home);
    if (why) {
      bad(`won't delete ${d}: ${why}. Remove it yourself if you're sure.`);
      return 1;
    }
  }
  if (dirs.length === 0) {
    ok("no sapi folders to delete");
    return 0;
  }
  io.info(`\nThis deletes sapi's keys, request log and Claude profile:\n${dirs.map((d) => `  ${d}`).join("\n")}`);
  if (!o.yes && !(await io.confirm("Delete them? This can't be undone.", false))) {
    io.info("Nothing deleted.");
    return 0;
  }

  // Sign out first: on macOS the profile's login lives in the keychain, outside the folder.
  const claude = existsSync(paths.claudeProfileDir) ? findClaude(paths.home, cfg.claude.binary) : null;
  if (claude) {
    if (!(deps.signedIn ?? claudeProfileSignedIn)(claude, paths)) ok("sapi's Claude profile wasn't signed in");
    else if ((deps.logout ?? claudeLogout)(claude, paths)) ok("signed sapi's Claude profile out");
    else {
      bad("couldn't sign sapi's Claude profile out. Remove its keychain entry or token yourself if one remains.");
      failed = true;
    }
  }
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
      ok(`deleted ${d}`);
    } catch (e) {
      bad(`couldn't delete ${d}: ${(e as Error).message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
