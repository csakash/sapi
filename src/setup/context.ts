/**
 * Shared pieces for setup, doctor, connect and uninstall: where the service would run sapi from,
 * and the absolute paths it pins.
 */
import { dirname, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { Paths } from "../paths.ts";
import { selfCommand } from "../start.ts";
import type { Machine } from "./machine.ts";
import type { ServiceSpec } from "./service.ts";

export { Service, type ServiceState } from "./service.ts";

/** The same paths, made absolute (a relative SAPI_DATA_DIR would mean something else to launchd). */
export function absolutePaths(p: Paths): Paths {
  return {
    home: resolve(p.home),
    configDir: resolve(p.configDir),
    configFile: resolve(p.configFile),
    claudeEnvFile: resolve(p.claudeEnvFile),
    dataDir: resolve(p.dataDir),
    dbFile: resolve(p.dbFile),
    claudeProfileDir: resolve(p.claudeProfileDir),
    runDir: resolve(p.runDir),
  };
}

/** Where the claude CLI is, if it can be found. */
export function claudeBinary(cfg: Config): string | null {
  if (cfg.claude.binary.startsWith("/")) return cfg.claude.binary;
  return Bun.which(cfg.claude.binary) ?? null;
}

export function serviceSpecFor(paths: Paths, cfg: Config, machine: Machine): ServiceSpec | null {
  if (machine.serviceManager === "none") return null;
  const claude = claudeBinary(cfg);
  const xdg = process.env.XDG_CONFIG_HOME;
  return {
    manager: machine.serviceManager,
    self: selfCommand().argv,
    paths: absolutePaths(paths),
    pathDirs: claude ? [dirname(claude)] : [],
    ...(xdg ? { xdgConfigHome: xdg } : {}),
  };
}
