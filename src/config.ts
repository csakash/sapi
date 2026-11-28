/**
 * Configuration: ~/.config/sapi/config.toml, validated with Zod (plan §15).
 *
 * Security-relevant rules enforced here rather than by convention:
 * - The listen address must be loopback (non-loopback needs TLS, which isn't built yet).
 * - Model aliases map to full, pinned provider model IDs; "-latest" style IDs are refused (GW-3).
 * - Model IDs must match the provider's ID pattern, so config text can never become a CLI flag.
 * - Telemetry and body logging can't be switched on: the keys exist to say so.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { assertNotWritableByOthers } from "./paths.ts";

export const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Provider model IDs: lowercase letters, digits, dots and dashes; never starts with a dash. */
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{1,99}$/;
export const PROVIDERS = ["claude-sub", "chatgpt-sub", "fake"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

const ModelEntry = z
  .object({
    provider: z.enum(PROVIDERS),
    model: z
      .string()
      .regex(MODEL_ID_RE, "model IDs are lowercase letters, digits, dots and dashes")
      .refine((m) => !/latest/.test(m), 'use a full, pinned model ID, not a moving "latest" alias'),
  })
  .strict();

const RouteEntry = z
  .object({
    route: z.array(z.string().regex(ALIAS_RE)).min(1).max(8),
    switch_at_window_pct: z.number().min(1).max(100).default(90),
  })
  .strict();

const Listen = z
  .string()
  .regex(/^(127\.0\.0\.1|\[::1\]|localhost):\d{1,5}$/, "sapi listens on loopback only (127.0.0.1:<port>)")
  .refine((s) => {
    const port = Number(s.slice(s.lastIndexOf(":") + 1));
    return port >= 1 && port <= 65535;
  }, "port must be 1-65535");

export const ConfigSchema = z
  .object({
    listen: Listen.default("127.0.0.1:8787"),
    log_bodies: z.literal(false, { message: "body logging is not available in this version" }).default(false),
    strict_params: z.boolean().default(false),
    telemetry: z.literal(false, { message: "sapi has no telemetry" }).default(false),
    max_body_bytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    clients: z
      .object({
        default_rpm: z.number().int().min(1).max(10_000).default(60),
        default_max_concurrency: z.number().int().min(1).max(64).default(4),
        max_queue_per_provider: z.number().int().min(1).max(1000).default(64),
      })
      .strict()
      .default({ default_rpm: 60, default_max_concurrency: 4, max_queue_per_provider: 64 }),
    claude: z
      .object({
        binary: z.string().min(1).default("claude"),
        version_range: z.string().default(">=2.1.332"),
        auth: z.enum(["cli", "env"]).default("cli"),
        confinement: z.enum(["required", "best-effort"]).default("required"),
        max_concurrency: z.number().int().min(1).max(16).default(3),
        first_token_timeout_s: z.number().int().min(5).max(600).default(60),
        total_timeout_s: z.number().int().min(10).max(3600).default(600),
        memory_max_mb: z.number().int().min(256).max(16384).default(2048),
      })
      .strict()
      .default({
        binary: "claude",
        version_range: ">=2.1.332",
        auth: "cli",
        confinement: "required",
        max_concurrency: 3,
        first_token_timeout_s: 60,
        total_timeout_s: 600,
        memory_max_mb: 2048,
      }),
    chatgpt: z
      .object({
        max_concurrency: z.number().int().min(1).max(16).default(4),
        first_token_timeout_s: z.number().int().min(5).max(600).default(60),
        total_timeout_s: z.number().int().min(10).max(3600).default(600),
      })
      .strict()
      .default({ max_concurrency: 4, first_token_timeout_s: 60, total_timeout_s: 600 }),
    /**
     * Where provider sign-ins (ChatGPT tokens, later API keys) are kept. "auto" picks the OS store
     * (Keychain or Secret Service), then systemd-creds, then a 0600 file, and remembers the choice.
     */
    secrets: z
      .object({ backend: z.enum(["auto", "os", "systemd-creds", "file"]).default("auto") })
      .strict()
      .default({ backend: "auto" }),
    models: z.record(
      z.string().regex(ALIAS_RE, "aliases are short lowercase names"),
      z.union([ModelEntry, RouteEntry]),
    ),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ModelTarget = { provider: ProviderId; model: string };

export const DEFAULT_MODELS: Record<string, z.input<typeof ModelEntry>> = {
  haiku: { provider: "claude-sub", model: "claude-haiku-5-5" },
  sonnet: { provider: "claude-sub", model: "claude-sonnet-5-5" },
  opus: { provider: "claude-sub", model: "claude-opus-5-5" },
};

/** Check each model entry against the branch it is meant to be, for clear messages. */
function modelIssues(models: unknown): string[] {
  if (!models || typeof models !== "object") return [];
  const out: string[] = [];
  for (const [alias, entry] of Object.entries(models)) {
    const where = `models.${alias.slice(0, 64)}`;
    if (!ALIAS_RE.test(alias))
      out.push(`  ${where}: aliases are short lowercase names (letters, digits, '.', '_', '-')`);
    const schema = entry && typeof entry === "object" && "route" in entry ? RouteEntry : ModelEntry;
    const r = schema.safeParse(entry);
    if (!r.success) for (const i of r.error.issues) out.push(`  ${[where, ...i.path].join(".")}: ${i.message}`);
  }
  return out;
}

export function parseConfig(raw: unknown): Config {
  const input = (raw && typeof raw === "object" ? { ...(raw as object) } : {}) as Record<string, unknown>;
  if (input.models === undefined) input.models = DEFAULT_MODELS;
  const mi = modelIssues(input.models);
  if (mi.length) throw new Error(`Invalid sapi config:\n${mi.join("\n")}`);
  const r = ConfigSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid sapi config:\n${issues}`);
  }
  const cfg = r.data;
  // Routes may only name direct aliases that exist.
  for (const [alias, entry] of Object.entries(cfg.models)) {
    if ("route" in entry) {
      for (const target of entry.route) {
        const t = cfg.models[target];
        if (!t || "route" in t)
          throw new Error(
            `Invalid sapi config:\n  models.${alias}: route target "${target}" must be a direct model alias`,
          );
      }
    }
  }
  return cfg;
}

export function loadConfig(file: string): Config {
  if (!existsSync(file)) return parseConfig({});
  assertNotWritableByOthers(file);
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Couldn't parse ${file}: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}

export function listenAddress(cfg: Config): { hostname: string; port: number } {
  const i = cfg.listen.lastIndexOf(":");
  let hostname = cfg.listen.slice(0, i);
  if (hostname === "localhost") hostname = "127.0.0.1";
  if (hostname.startsWith("[")) hostname = hostname.slice(1, -1);
  return { hostname, port: Number(cfg.listen.slice(i + 1)) };
}

/** Parse a simple version range like ">=2.1.332" or ">=2.1.332 <2.2.0". */
export function versionInRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  for (const part of range.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
    if (!m) return false;
    const bound = parseVersion(m[2]!)!;
    const c = compareVersions(v, bound);
    const op = m[1] ?? "=";
    const ok = op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

function parseVersion(s: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
