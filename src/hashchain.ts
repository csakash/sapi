/**
 * Tamper evidence for the request and event logs (ARI-42 LOG-1).
 *
 * Each row stores the previous row's hash and its own: row_hash = SHA-256(prev_hash + "\n" +
 * canonical JSON of the row's fields). Editing, deleting or reordering any row breaks every hash
 * after it, and `verifyChain` reports the first broken row.
 */
import { createHash } from "node:crypto";

export const GENESIS = "0".repeat(64);

/** JSON with object keys sorted at every level, so the same row always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function rowHash(prevHash: string, fields: Record<string, unknown>): string {
  return createHash("sha256").update(prevHash).update("\n").update(canonicalJson(fields)).digest("hex");
}

export type ChainRow = { seq: number; prev_hash: string; row_hash: string } & Record<string, unknown>;

export type ChainResult = { ok: true; rows: number } | { ok: false; rows: number; brokenAtSeq: number; reason: string };

/**
 * Verify rows in seq order. `anchor` is the expected prev_hash of the first row: GENESIS for a
 * full log, or the recorded anchor after retention removed older rows.
 */
export function verifyChain(rows: Iterable<ChainRow>, anchor: string = GENESIS): ChainResult {
  let prev = anchor;
  let n = 0;
  for (const row of rows) {
    const { seq, prev_hash, row_hash, ...fields } = row;
    if (prev_hash !== prev) return { ok: false, rows: n, brokenAtSeq: seq, reason: "prev_hash does not match" };
    if (rowHash(prev_hash, fields) !== row_hash) {
      return { ok: false, rows: n, brokenAtSeq: seq, reason: "row contents changed" };
    }
    prev = row_hash;
    n++;
  }
  return { ok: true, rows: n };
}
