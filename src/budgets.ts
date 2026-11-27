/**
 * Per-client rate limits and budgets (ARI-42 AUTH-4). These halt; they don't just alert.
 *
 * - Rate limit: a token bucket per client (requests per minute).
 * - Daily budgets: requests and tokens per local calendar day, counted from the request log plus
 *   requests still running.
 * - Concurrency: queued plus running requests per client.
 */
import type { Budget, Client } from "./auth.ts";
import { GatewayError } from "./canonical.ts";
import type { Db } from "./db.ts";

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  /** Take one request from the client's bucket, or throw 429 with Retry-After. */
  take(clientId: string, rpm: number, now = Date.now()): void {
    const b = this.buckets.get(clientId) ?? { tokens: rpm, at: now };
    const refill = ((now - b.at) / 60_000) * rpm;
    b.tokens = Math.min(rpm, b.tokens + refill);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(clientId, b);
      const waitSec = ((1 - b.tokens) / rpm) * 60;
      throw new GatewayError("rate_limited", "Rate limit reached for this key. Slow down and retry.", {
        retryAfterSec: waitSec,
      });
    }
    b.tokens -= 1;
    this.buckets.set(clientId, b);
  }
}

export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function secondsToNextLocalDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return (d.getTime() - now) / 1000;
}

export function usageToday(db: Db, clientId: string, now = Date.now()): { requests: number; tokens: number } {
  const r = db
    .query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_tokens,0)), 0) AS t
       FROM requests WHERE client_id = ? AND received_at >= ? AND status != 'rejected'`,
    )
    .get(clientId, startOfLocalDay(now)) as { n: number; t: number };
  return { requests: r.n, tokens: r.t };
}

/** Throws 429 client_budget_exceeded when a daily budget or the concurrency cap is reached. */
export function checkBudget(
  db: Db,
  client: Client,
  inFlightForClient: number,
  defaults: { maxConcurrency: number },
  now = Date.now(),
): void {
  const b: Budget = client.budget;
  const maxConc = b.maxConcurrency ?? defaults.maxConcurrency;
  if (inFlightForClient >= maxConc) {
    throw new GatewayError(
      "rate_limited",
      `This key already has ${maxConc} requests running. Wait for one to finish.`,
      {
        retryAfterSec: 2,
      },
    );
  }
  if (b.requestsPerDay === undefined && b.tokensPerDay === undefined) return;
  const used = usageToday(db, client.id, now);
  const retry = secondsToNextLocalDay(now);
  if (b.requestsPerDay !== undefined && used.requests + inFlightForClient >= b.requestsPerDay) {
    throw new GatewayError("client_budget_exceeded", "Daily request budget reached for this key.", {
      retryAfterSec: retry,
    });
  }
  if (b.tokensPerDay !== undefined && used.tokens >= b.tokensPerDay) {
    throw new GatewayError("client_budget_exceeded", "Daily token budget reached for this key.", {
      retryAfterSec: retry,
    });
  }
}
