/**
 * ARI-42 AUTH-4: kill switches stop running requests and refuse new ones; budgets halt.
 * Switches are flipped through a separate database connection, the way `sapi pause` does it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { findClientByName } from "../../src/auth.ts";
import { openDb } from "../../src/db.ts";
import { setPaused } from "../../src/killswitch.ts";
import type { FakeAdapter } from "../../src/providers/fake/adapter.ts";
import { bearer, jsonOf, readSse, startTestGateway, type TestGateway } from "../helpers.ts";

let gw: TestGateway;
let key: string;
let other: string;
const fake = () => gw.gateway.adapter("fake") as FakeAdapter;
const cli = () => openDb(gw.paths.dbFile);
const slow = { model: "slow", stream: true, messages: [{ role: "user", content: "count" }] };
const echo = { model: "echo", messages: [{ role: "user", content: "hi" }] };

beforeAll(async () => {
  gw = await startTestGateway();
  key = gw.addClient("main");
  other = gw.addClient("other");
});
afterAll(() => gw.cleanup());

function flip(scope: "global" | "provider" | "client", target: string, paused: boolean) {
  const db = cli();
  setPaused(db, { scope, target }, paused, "test");
  db.close();
}

describe("kill switch", () => {
  test("global switch mid-stream: the running request stops and the next call gets 503", async () => {
    const res = await gw.post("/v1/chat/completions", slow, bearer(key));
    expect(res.status).toBe(200);
    const reading = readSse(res);
    await Bun.sleep(200);
    expect(fake().active).toBe(1);
    const t0 = performance.now();
    flip("global", "*", true);
    const frames = await reading;
    const stoppedAfter = performance.now() - t0;
    expect(stoppedAfter).toBeLessThan(1500);
    expect(fake().active).toBe(0);
    const last = JSON.parse(frames[frames.length - 1]!);
    expect(last.error.sapi_error_kind).toBe("provider_paused");
    expect(frames).not.toContain("[DONE]");

    const next = await gw.post("/v1/chat/completions", echo, bearer(key));
    expect(next.status).toBe(503);
    flip("global", "*", false);
    await Bun.sleep(100);
    expect((await gw.post("/v1/chat/completions", echo, bearer(key))).status).toBe(200);
  });

  test("provider switch stops only that provider", async () => {
    flip("provider", "fake", true);
    await Bun.sleep(100);
    expect((await gw.post("/v1/chat/completions", echo, bearer(key))).status).toBe(503);
    flip("provider", "fake", false);
    await Bun.sleep(100);
    expect((await gw.post("/v1/chat/completions", echo, bearer(key))).status).toBe(200);
  });

  test("client switch stops only that client", async () => {
    const id = findClientByName(gw.db, "main")!.id;
    flip("client", id, true);
    await Bun.sleep(100);
    expect((await gw.post("/v1/chat/completions", echo, bearer(key))).status).toBe(503);
    expect((await gw.post("/v1/chat/completions", echo, bearer(other))).status).toBe(200);
    flip("client", id, false);
  });

  test("switch changes are recorded in the hash-chained event log", () => {
    const kinds = (gw.db.query("SELECT kind FROM events").all() as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toContain("kill_switch_on");
    expect(kinds).toContain("kill_switch_off");
  });

  test("a revoked key stops working on the next request", async () => {
    const k = gw.addClient("revoke-me");
    expect((await gw.post("/v1/chat/completions", echo, bearer(k))).status).toBe(200);
    gw.db.query("UPDATE clients SET disabled = 1 WHERE name = 'revoke-me'").run();
    expect((await gw.post("/v1/chat/completions", echo, bearer(k))).status).toBe(401);
  });
});

describe("budgets halt", () => {
  test("daily request budget → 429 client_budget_exceeded", async () => {
    const k = gw.addClient("two-a-day", { budget: { requestsPerDay: 2 } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await gw.post("/v1/chat/completions", echo, bearer(k))).status);
    expect(codes).toEqual([200, 200, 429]);
    const r = await gw.post("/v1/chat/completions", echo, bearer(k));
    expect((await jsonOf(r)).error.sapi_error_kind).toBe("client_budget_exceeded");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("daily token budget → 429 once used up", async () => {
    const k = gw.addClient("few-tokens", { budget: { tokensPerDay: 5 } });
    expect((await gw.post("/v1/chat/completions", echo, bearer(k))).status).toBe(200);
    expect((await gw.post("/v1/chat/completions", echo, bearer(k))).status).toBe(429);
  });

  test("per-key concurrency cap → 429 while the cap is in use", async () => {
    const k = gw.addClient("one-at-a-time", { budget: { maxConcurrency: 1 } });
    const hangUp = new AbortController();
    const first = await gw.post("/v1/chat/completions", slow, bearer(k), hangUp.signal);
    expect(first.status).toBe(200);
    const second = await gw.post("/v1/chat/completions", echo, bearer(k));
    expect(second.status).toBe(429);
    hangUp.abort();
    await Bun.sleep(200);
    expect(fake().active).toBe(0);
  });

  test("a client that disconnects stops its provider work", async () => {
    const hangUp = new AbortController();
    const res = await gw.post("/v1/chat/completions", slow, bearer(other), hangUp.signal);
    expect(res.status).toBe(200);
    await Bun.sleep(150);
    expect(fake().active).toBe(1);
    hangUp.abort();
    await Bun.sleep(200);
    expect(fake().active).toBe(0);
    const row = gw.db.query("SELECT status, error_kind FROM requests ORDER BY seq DESC LIMIT 1").get() as {
      status: string;
      error_kind: string;
    };
    expect(row).toEqual({ status: "aborted", error_kind: "client_closed" });
  });
});

describe("request log (LOG-1)", () => {
  test("every request above left a hash-chained row, and both chains verify", async () => {
    const { verifyLogs } = await import("../../src/meter.ts");
    const v = verifyLogs(gw.db);
    expect(v.requests.ok).toBe(true);
    expect(v.events.ok).toBe(true);
    expect(v.requests.rows).toBeGreaterThan(10);
    const kinds = gw.db.query("SELECT DISTINCT status FROM requests").all() as Array<{ status: string }>;
    expect(kinds.map((k) => k.status).sort()).toEqual(expect.arrayContaining(["aborted", "error", "ok", "rejected"]));
  });

  test("rows hold metadata only: no prompt text, no keys", () => {
    const dump = JSON.stringify(gw.db.query("SELECT * FROM requests").all());
    expect(dump).not.toContain("count");
    expect(dump).not.toContain("echo: hi");
    expect(dump).not.toContain(key);
    expect(dump).toContain("transcript-v1");
  });
});
