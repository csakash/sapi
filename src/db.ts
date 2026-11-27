/**
 * SQLite storage (plan §13). One file, 0600, in a 0700 directory. No prompt or response bodies
 * are stored. `requests` and `events` are append-only and hash-chained (LOG-1).
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, GENESIS, rowHash } from "./hashchain.ts";
import { ensurePrivateDir } from "./paths.ts";

const MIGRATIONS: string[] = [
  `CREATE TABLE clients (
     id TEXT PRIMARY KEY,
     name TEXT UNIQUE NOT NULL,
     key_hash TEXT NOT NULL,
     key_prefix TEXT UNIQUE NOT NULL,
     scope_json TEXT NOT NULL DEFAULT '{}',
     budget_json TEXT NOT NULL DEFAULT '{}',
     expires_at INTEGER,
     disabled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER
   );
   CREATE TABLE requests (
     seq INTEGER PRIMARY KEY,
     id TEXT UNIQUE NOT NULL,
     client_id TEXT NOT NULL REFERENCES clients(id),
     received_at INTEGER NOT NULL,
     door TEXT NOT NULL,
     provider TEXT,
     model_alias TEXT,
     model_id TEXT,
     template_version TEXT,
     stream INTEGER,
     status TEXT NOT NULL,
     http_status INTEGER,
     error_kind TEXT,
     queue_ms INTEGER, ttft_ms INTEGER, total_ms INTEGER, overhead_ms INTEGER,
     input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
     cache_write_tokens INTEGER, reasoning_tokens INTEGER, api_equiv_usd REAL,
     tool_calls_json TEXT,
     ignored_params TEXT, sdk_lang TEXT, sdk_version TEXT, user_agent TEXT,
     prev_hash TEXT NOT NULL,
     row_hash TEXT NOT NULL
   );
   CREATE INDEX requests_client_time ON requests(client_id, received_at);
   CREATE TABLE events (
     seq INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     detail_json TEXT NOT NULL DEFAULT '{}',
     prev_hash TEXT NOT NULL,
     row_hash TEXT NOT NULL
   );
   CREATE TABLE limit_snapshots (
     at INTEGER NOT NULL,
     provider TEXT NOT NULL,
     window TEXT NOT NULL,
     used_pct REAL NOT NULL,
     resets_at INTEGER,
     source TEXT NOT NULL
   );
   CREATE INDEX limit_snapshots_provider_time ON limit_snapshots(provider, at);
   CREATE TABLE switches (
     scope TEXT NOT NULL,        -- 'global' | 'provider' | 'client'
     target TEXT NOT NULL,       -- '*' for global, else the provider or client id
     paused INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (scope, target)
   );
   -- Rows in the hash-chained tables are never edited.
   CREATE TRIGGER requests_no_update BEFORE UPDATE ON requests BEGIN SELECT RAISE(ABORT, 'requests are append-only'); END;
   CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
   PRAGMA user_version = 1;`,
];

/**
 * The columns of the hash-chained tables, in schema order, and their fixed SQL. Every column is
 * hashed (missing values as NULL) exactly as a later SELECT * reads it back. `openDb` checks these
 * lists against the real schema, so a migration can't silently drift from them.
 */
const REQUEST_COLUMNS = [
  "id",
  "client_id",
  "received_at",
  "door",
  "provider",
  "model_alias",
  "model_id",
  "template_version",
  "stream",
  "status",
  "http_status",
  "error_kind",
  "queue_ms",
  "ttft_ms",
  "total_ms",
  "overhead_ms",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "api_equiv_usd",
  "tool_calls_json",
  "ignored_params",
  "sdk_lang",
  "sdk_version",
  "user_agent",
] as const;
const EVENT_COLUMNS = ["at", "kind", "detail_json"] as const;

const CHAINED = {
  requests: {
    columns: REQUEST_COLUMNS as readonly string[],
    schema: "PRAGMA table_info(requests)",
    last: "SELECT row_hash FROM requests ORDER BY seq DESC LIMIT 1",
    insert:
      "INSERT INTO requests (id, client_id, received_at, door, provider, model_alias, model_id, template_version, stream, status, http_status, error_kind, queue_ms, ttft_ms, total_ms, overhead_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, api_equiv_usd, tool_calls_json, ignored_params, sdk_lang, sdk_version, user_agent, prev_hash, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  },
  events: {
    columns: EVENT_COLUMNS as readonly string[],
    schema: "PRAGMA table_info(events)",
    last: "SELECT row_hash FROM events ORDER BY seq DESC LIMIT 1",
    insert: "INSERT INTO events (at, kind, detail_json, prev_hash, row_hash) VALUES (?, ?, ?, ?, ?)",
  },
} as const;

export type Db = Database;

export function openDb(file: string): Db {
  ensurePrivateDir(dirname(file));
  const fresh = !existsSync(file);
  const db = new Database(file, { create: true, strict: true });
  if (fresh) chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  for (const f of [`${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  migrate(db);
  for (const t of Object.values(CHAINED)) {
    const actual = (db.query(t.schema).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((c) => c !== "seq" && c !== "prev_hash" && c !== "row_hash");
    if (actual.join(",") !== t.columns.join(","))
      throw new Error("database schema doesn't match the hash-chain column list");
  }
  return db;
}

function migrate(db: Db): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    // Each migration ends by setting its own user_version.
    db.transaction(() => db.exec(MIGRATIONS[v]!))();
  }
}

/**
 * Append a row to a hash-chained table inside one transaction (bun:sqlite is synchronous, so
 * appends from one process never interleave).
 */
export function appendChained(db: Db, table: keyof typeof CHAINED, fields: Record<string, unknown>): void {
  const t = CHAINED[table];
  for (const k of Object.keys(fields)) if (!t.columns.includes(k)) throw new Error(`${table} has no column ${k}`);
  const insert = db.prepare(t.insert);
  db.transaction(() => {
    const last = db.query(t.last).get() as { row_hash: string } | null;
    const prev = last?.row_hash ?? GENESIS;
    const values = t.columns.map((c) => normalise(fields[c]));
    const hashed = Object.fromEntries(t.columns.map((c, i) => [c, values[i]]));
    insert.run(...(values as never[]), prev, rowHash(prev, hashed));
  })();
}

/** SQLite stores booleans as 0/1 and objects as JSON; hash what is stored, not the JS value. */
function normalise(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return canonicalJson(v);
}

/** Events: admin actions, kill switches, blocked egress, auth failures. Details must be metadata only. */
export function recordEvent(db: Db, kind: string, detail: Record<string, unknown> = {}): void {
  appendChained(db, "events", { at: Date.now(), kind, detail_json: canonicalJson(detail) });
}
