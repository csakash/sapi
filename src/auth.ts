/**
 * Client keys (ARI-42 AUTH-1, AUTH-2, MCP-3).
 *
 * - 256-bit random keys, shown once, stored only as SHA-256 plus a short lookup prefix.
 * - Compared in constant time.
 * - Each key carries its own scope (providers, models), budget and optional expiry.
 * - The client's identity comes only from the key; nothing in a request body can change it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { GatewayError, newId } from "./canonical.ts";
import { ALIAS_RE, PROVIDERS } from "./config.ts";
import { type Db, recordEvent } from "./db.ts";

export const KEY_PREFIX = "sk-sapi-";
const KEY_RE = /^sk-sapi-[A-Za-z0-9_-]{43}$/;
const LOOKUP_CHARS = 8;
export const CLIENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export const ScopeSchema = z
  .object({
    providers: z.array(z.enum(PROVIDERS)).optional(),
    models: z.array(z.string().regex(ALIAS_RE)).optional(),
  })
  .strict();
export type Scope = z.infer<typeof ScopeSchema>;

export const BudgetSchema = z
  .object({
    rpm: z.number().int().min(1).max(10_000).optional(),
    requestsPerDay: z.number().int().min(1).optional(),
    tokensPerDay: z.number().int().min(1).optional(),
    maxConcurrency: z.number().int().min(1).max(64).optional(),
  })
  .strict();
export type Budget = z.infer<typeof BudgetSchema>;

export type Client = {
  id: string;
  name: string;
  keyPrefix: string;
  scope: Scope;
  budget: Budget;
  expiresAt: number | null;
  disabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
};

type ClientRow = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scope_json: string;
  budget_json: string;
  expires_at: number | null;
  disabled: number;
  created_at: number;
  last_seen_at: number | null;
};

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function generateKey(): string {
  return KEY_PREFIX + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function lookupPrefix(key: string): string {
  return key.slice(0, KEY_PREFIX.length + LOOKUP_CHARS);
}

function toClient(r: ClientRow): Client {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    scope: ScopeSchema.parse(JSON.parse(r.scope_json)),
    budget: BudgetSchema.parse(JSON.parse(r.budget_json)),
    expiresAt: r.expires_at,
    disabled: r.disabled === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

export type NewClient = { name: string; scope?: Scope; budget?: Budget; expiresAt?: number | null };

/** Create a client and return its key. The key is not stored and can't be shown again. */
export function createClient(db: Db, input: NewClient): { client: Client; key: string } {
  if (!CLIENT_NAME_RE.test(input.name)) {
    throw new Error(
      "Client names are 1-48 characters: lowercase letters, digits, '-' and '_', starting with a letter or digit.",
    );
  }
  const scope = ScopeSchema.parse(input.scope ?? {});
  const budget = BudgetSchema.parse(input.budget ?? {});
  if (db.query("SELECT 1 FROM clients WHERE name = ?").get(input.name))
    throw new Error(`A client named "${input.name}" already exists.`);
  const id = newId("cli");
  const { key, prefix } = uniqueKey(db);
  const now = Date.now();
  db.query(
    `INSERT INTO clients (id, name, key_hash, key_prefix, scope_json, budget_json, expires_at, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    input.name,
    sha256(key).toString("hex"),
    prefix,
    JSON.stringify(scope),
    JSON.stringify(budget),
    input.expiresAt ?? null,
    now,
  );
  recordEvent(db, "client_created", { client: id, name: input.name, key_prefix: prefix });
  return { client: getClient(db, id)!, key };
}

function uniqueKey(db: Db): { key: string; prefix: string } {
  for (let i = 0; i < 5; i++) {
    const key = generateKey();
    const prefix = lookupPrefix(key);
    if (!db.query("SELECT 1 FROM clients WHERE key_prefix = ?").get(prefix)) return { key, prefix };
  }
  throw new Error("Couldn't generate a unique key prefix");
}

export function rotateClientKey(db: Db, name: string): string {
  const c = findClientByName(db, name);
  if (!c) throw new Error(`No client named "${name}".`);
  const { key, prefix } = uniqueKey(db);
  db.query("UPDATE clients SET key_hash = ?, key_prefix = ? WHERE id = ?").run(
    sha256(key).toString("hex"),
    prefix,
    c.id,
  );
  recordEvent(db, "client_key_rotated", { client: c.id, key_prefix: prefix });
  return key;
}

export function setClientDisabled(db: Db, name: string, disabled: boolean): void {
  const c = findClientByName(db, name);
  if (!c) throw new Error(`No client named "${name}".`);
  db.query("UPDATE clients SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, c.id);
  recordEvent(db, disabled ? "client_disabled" : "client_enabled", { client: c.id });
}

/** When the client's current key was issued: creation, or the latest rotation. */
export function keyIssuedAt(db: Db, c: Client): number {
  const r = db
    .query(
      "SELECT MAX(at) AS at FROM events WHERE kind = 'client_key_rotated' AND json_extract(detail_json, '$.client') = ?",
    )
    .get(c.id) as { at: number | null } | null;
  return Math.max(c.createdAt, r?.at ?? 0);
}

export function getClient(db: Db, id: string): Client | null {
  const r = db.query("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | null;
  return r ? toClient(r) : null;
}

export function findClientByName(db: Db, name: string): Client | null {
  const r = db.query("SELECT * FROM clients WHERE name = ?").get(name) as ClientRow | null;
  return r ? toClient(r) : null;
}

export function listClients(db: Db): Client[] {
  return (db.query("SELECT * FROM clients ORDER BY created_at").all() as ClientRow[]).map(toClient);
}

/** Pull the presented key from `Authorization: Bearer …` (OpenAI) or `x-api-key` (Anthropic). */
export function presentedKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    return m ? m[1]! : null;
  }
  return headers.get("x-api-key")?.trim() || null;
}

/**
 * Resolve a key to its client, or throw 401. Every failure gives the same message, so a caller
 * can't tell an unknown key from a disabled or expired one.
 */
export function authenticate(db: Db, key: string | null, now = Date.now()): Client {
  const fail = () =>
    new GatewayError("unauthorized", "Missing or invalid API key. Create one with: sapi clients add <name>");
  if (!key || !KEY_RE.test(key)) throw fail();
  const row = db.query("SELECT * FROM clients WHERE key_prefix = ?").get(lookupPrefix(key)) as ClientRow | null;
  // Hash and compare even when the prefix is unknown, to keep timing uniform.
  const presented = sha256(key);
  const stored = row ? Buffer.from(row.key_hash, "hex") : Buffer.alloc(32);
  const match = timingSafeEqual(presented, stored) && row !== null;
  if (!match || !row) throw fail();
  if (row.disabled === 1) throw fail();
  if (row.expires_at !== null && row.expires_at <= now) throw fail();
  db.query("UPDATE clients SET last_seen_at = ? WHERE id = ?").run(now, row.id);
  return toClient(row);
}

/** Model and provider scope checks (403 when outside the key's scope). */
export function assertInScope(client: Client, alias: string, provider: string): void {
  const { models, providers } = client.scope;
  if (models && !models.includes(alias))
    throw new GatewayError("forbidden", "This key isn't allowed to use that model.");
  if (providers && !(providers as string[]).includes(provider)) {
    throw new GatewayError("forbidden", "This key isn't allowed to use that provider.");
  }
}

export function modelAllowed(client: Client, alias: string, provider: string): boolean {
  try {
    assertInScope(client, alias, provider);
    return true;
  } catch {
    return false;
  }
}

/** "90d", "12h", "30m" → milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d{1,5})([dhm])$/.exec(s);
  if (!m) throw new Error(`Durations look like 90d, 12h or 30m (got "${s.slice(0, 20)}").`);
  const n = Number(m[1]);
  return n * (m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000);
}
