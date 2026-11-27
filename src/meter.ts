/**
 * The meter: one hash-chained row per request (ARI-42 LOG-1). Metadata only: no prompt or
 * response text, no keys. Header-derived strings are cleaned and bounded.
 */
import type { LimitWindow } from "./canonical.ts";
import { appendChained, type Db } from "./db.ts";
import { type ChainResult, type ChainRow, verifyChain } from "./hashchain.ts";
import { cleanHeaderValue } from "./redact.ts";

export type RequestRecord = {
  id: string;
  clientId: string;
  receivedAt: number;
  door: "chat" | "responses" | "messages" | "models";
  provider?: string;
  modelAlias?: string;
  modelId?: string;
  templateVersion?: string;
  stream?: boolean;
  status: "ok" | "error" | "rejected" | "aborted";
  httpStatus: number;
  errorKind?: string;
  queueMs?: number;
  ttftMs?: number;
  totalMs?: number;
  overheadMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  apiEquivUsd?: number;
  ignoredParams?: string[];
  headers?: Headers;
};

export function sdkFingerprint(h: Headers | undefined): {
  lang: string | null;
  version: string | null;
  ua: string | null;
} {
  if (!h) return { lang: null, version: null, ua: null };
  return {
    lang: cleanHeaderValue(h.get("x-stainless-lang"), 32),
    version: cleanHeaderValue(h.get("x-stainless-package-version"), 32),
    ua: cleanHeaderValue(h.get("user-agent"), 200),
  };
}

export function recordRequest(db: Db, r: RequestRecord): void {
  const fp = sdkFingerprint(r.headers);
  appendChained(db, "requests", {
    id: r.id,
    client_id: r.clientId,
    received_at: r.receivedAt,
    door: r.door,
    provider: r.provider ?? null,
    model_alias: r.modelAlias ?? null,
    model_id: r.modelId ?? null,
    template_version: r.templateVersion ?? null,
    stream: r.stream === undefined ? null : r.stream,
    status: r.status,
    http_status: r.httpStatus,
    error_kind: r.errorKind ?? null,
    queue_ms: r.queueMs ?? null,
    ttft_ms: r.ttftMs ?? null,
    total_ms: r.totalMs ?? null,
    overhead_ms: r.overheadMs ?? null,
    input_tokens: r.inputTokens ?? null,
    output_tokens: r.outputTokens ?? null,
    cache_read_tokens: r.cacheReadTokens ?? null,
    cache_write_tokens: r.cacheWriteTokens ?? null,
    reasoning_tokens: r.reasoningTokens ?? null,
    api_equiv_usd: r.apiEquivUsd ?? null,
    tool_calls_json: null,
    ignored_params: r.ignoredParams?.length ? r.ignoredParams.join(",") : null,
    sdk_lang: fp.lang,
    sdk_version: fp.version,
    user_agent: fp.ua,
  });
}

const lastSnapshot = new Map<string, { at: number; pct: number }>();

/** Store a usage-window reading when it changed, or at most once a minute. */
export function recordLimit(db: Db, provider: string, l: LimitWindow, now = Date.now()): void {
  const key = `${provider}/${l.window}`;
  const prev = lastSnapshot.get(key);
  if (prev && prev.pct === l.usedPct && now - prev.at < 60_000) return;
  lastSnapshot.set(key, { at: now, pct: l.usedPct });
  db.query(
    "INSERT INTO limit_snapshots (at, provider, window, used_pct, resets_at, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(now, provider, l.window, l.usedPct, l.resetsAt ? Date.parse(l.resetsAt) : null, l.source);
}

/** Check both hash chains (used by tests now and by `sapi doctor` in Phase 2). */
export function verifyLogs(db: Db): { requests: ChainResult; events: ChainResult } {
  return {
    requests: verifyChain(db.query("SELECT * FROM requests ORDER BY seq").all() as ChainRow[]),
    events: verifyChain(db.query("SELECT * FROM events ORDER BY seq").all() as ChainRow[]),
  };
}
