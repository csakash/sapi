/**
 * The one redactor every log line and exporter goes through (plan §6, ARI-42 LOG-1, GW-1).
 * It removes credential-shaped strings and drops fields whose names say they hold secrets or
 * personal data. Logs are metadata only by design; this is the safety net, not the plan.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-sapi-[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*/g, "sk-sapi-[redacted]"],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[redacted-email]"],
];

const SECRET_KEYS =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|credential[_-]?expires[_-]?at|email|claude_code_oauth_token|key)$/i;

export function redact(text: string): string {
  let s = text;
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redactValue(v, depth + 1);
    return out;
  }
  return value;
}

/** Printable ASCII only, bounded: for header values such as User-Agent that end up in logs and the dashboard. */
export function cleanHeaderValue(v: string | null, max = 200): string | null {
  if (v === null) return null;
  const s = redact(v.replace(/[^\x20-\x7e]/g, "?")).slice(0, max);
  return s.length ? s : null;
}

export type LogLevel = "info" | "warn" | "error";

/** JSON lines on stderr, always redacted. Never pass request bodies here. */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.SAPI_LOG === "off") return;
  const line = JSON.stringify(redactValue({ at: new Date().toISOString(), level, msg, ...fields }));
  process.stderr.write(`${line}\n`);
}
