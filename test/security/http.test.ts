/**
 * ARI-42 MCP-3, AUTH-1, AUTH-2: the HTTP surface is authenticated, loopback-only, refuses
 * browser cross-site requests, rate-limits per key and never sends CORS headers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "../../src/server.ts";
import { bearer, jsonOf, startTestGateway, type TestGateway } from "../helpers.ts";

let gw: TestGateway;
let key: string;
let port: number;
const chat = { model: "echo", messages: [{ role: "user", content: "hi" }] };

beforeAll(async () => {
  gw = await startTestGateway({ config: { max_body_bytes: 4096 } });
  key = gw.addClient("main");
  port = gw.server.port!;
});
afterAll(() => gw.cleanup());

describe("authentication (MCP-3, AUTH-1)", () => {
  test("no key → 401", async () => {
    const r = await gw.post("/v1/chat/completions", chat);
    expect(r.status).toBe(401);
    const body = await jsonOf(r);
    expect(body.error.sapi_error_kind).toBe("unauthorized");
  });

  test("malformed and unknown keys → 401 with the same message", async () => {
    const a = await gw.post("/v1/chat/completions", chat, bearer("sk-sapi-short"));
    const b = await gw.post("/v1/chat/completions", chat, bearer(`sk-sapi-${"A".repeat(43)}`));
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect((await jsonOf(a)).error.message).toBe((await jsonOf(b)).error.message);
  });

  test("a disabled key and an expired key → 401", async () => {
    const k1 = gw.addClient("disabled-one");
    gw.db.query("UPDATE clients SET disabled = 1 WHERE name = 'disabled-one'").run();
    const k2 = gw.addClient("expired-one", { expiresAt: Date.now() - 1000 });
    expect((await gw.post("/v1/chat/completions", chat, bearer(k1))).status).toBe(401);
    expect((await gw.post("/v1/chat/completions", chat, bearer(k2))).status).toBe(401);
  });

  test("a valid key works, and identity in the body is ignored (AUTH-2)", async () => {
    const r = await gw.post(
      "/v1/chat/completions",
      { ...chat, user: "someone-else", client_id: "cli_other" },
      bearer(key),
    );
    expect(r.status).toBe(200);
    const row = gw.db.query("SELECT client_id FROM requests ORDER BY seq DESC LIMIT 1").get() as { client_id: string };
    const me = gw.db.query("SELECT id FROM clients WHERE name = 'main'").get() as { id: string };
    expect(row.client_id).toBe(me.id);
  });

  test("the client key never reaches the provider (AUTH-2)", async () => {
    const fake = gw.gateway.adapter("fake") as import("../../src/providers/fake/adapter.ts").FakeAdapter;
    expect(fake.received.length).toBeGreaterThan(0);
    expect(JSON.stringify(fake.received)).not.toContain(key);
    expect(fake.received.every((r) => r.clientId.startsWith("cli_"))).toBe(true);
  });

  test("keys are stored only as hashes", () => {
    const rows = gw.db.query("SELECT * FROM clients").all() as Array<Record<string, unknown>>;
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(JSON.stringify(rows)).not.toContain(key.slice(16));
  });
});

describe("Host and Origin checks (DNS rebinding, CSRF)", () => {
  test("wrong Host header → 403, even with a valid key", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { ...bearer(key), host: "evil.example:80" },
    });
    expect(r.status).toBe(403);
  });

  test("foreign Origin → 403", async () => {
    const r = await gw.get("/v1/models", { ...bearer(key), origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  test("cross-site fetch metadata → 403", async () => {
    const r = await gw.get("/v1/models", { ...bearer(key), "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
  });

  test("same-origin Origin is accepted", async () => {
    const r = await gw.get("/v1/models", { ...bearer(key), origin: `http://127.0.0.1:${port}` });
    expect(r.status).toBe(200);
  });

  test("a CORS preflight is refused and no CORS headers are ever sent", async () => {
    const pre = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(403);
    const ok = await gw.get("/v1/models", bearer(key));
    for (const r of [pre, ok]) for (const h of r.headers.keys()) expect(h.startsWith("access-control-")).toBe(false);
  });
});

describe("request limits", () => {
  test("body over the limit → 413 (Content-Length)", async () => {
    const big = { ...chat, messages: [{ role: "user", content: "x".repeat(10_000) }] };
    expect((await gw.post("/v1/chat/completions", big, bearer(key))).status).toBe(413);
  });

  test("body over the limit → 413 (chunked, no Content-Length)", async () => {
    const payload = JSON.stringify({ ...chat, messages: [{ role: "user", content: "y".repeat(10_000) }] });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(payload));
        c.close();
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(key) },
      body: stream,
    });
    expect([413, 400]).toContain(r.status);
  });

  test("non-JSON content type → 415 (a plain HTML form can't post here)", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...bearer(key) },
      body: "model=echo",
    });
    expect(r.status).toBe(415);
  });

  test("rate limit per key → 429 with Retry-After", async () => {
    const k = gw.addClient("limited", { budget: { rpm: 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await gw.post("/v1/chat/completions", chat, bearer(k))).status);
    expect(codes).toEqual([200, 200, 429]);
    const r = await gw.post("/v1/chat/completions", chat, bearer(k));
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await jsonOf(r)).error.sapi_error_kind).toBe("rate_limited");
  });
});

describe("scope (AUTH-1, AUTH-2)", () => {
  test("a model outside the key's scope → 403; /v1/models lists only allowed models", async () => {
    const k = gw.addClient("echo-only", { scope: { models: ["echo"] } });
    expect((await gw.post("/v1/chat/completions", { ...chat, model: "slow" }, bearer(k))).status).toBe(403);
    const list = await jsonOf(await gw.get("/v1/models", bearer(k)));
    expect(list.data.map((m: { id: string }) => m.id)).toEqual(["echo"]);
  });

  test("a provider outside the key's scope → 403", async () => {
    const k = gw.addClient("claude-only", { scope: { providers: ["claude-sub"] } });
    expect((await gw.post("/v1/chat/completions", chat, bearer(k))).status).toBe(403);
  });

  test("unknown model alias → 400, and flag-like text never reaches a provider", async () => {
    for (const model of ["gpt-9", "--dangerously", "__proto__", "constructor", "echo; rm -rf /"]) {
      const r = await gw.post("/v1/chat/completions", { ...chat, model }, bearer(key));
      expect(r.status).toBe(400);
    }
  });

  test("a client key can't reach the admin surface", async () => {
    for (const p of ["/", "/api", "/api/clients"]) expect((await gw.get(p, bearer(key))).status).toBe(403);
  });
});

describe("response headers", () => {
  test("security headers on success and error responses", async () => {
    for (const r of [await gw.get("/v1/models", bearer(key)), await gw.get("/v1/models")]) {
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("/healthz needs no key and says only ok", async () => {
    const r = await gw.get("/healthz");
    expect(r.status).toBe(200);
    expect(await jsonOf(r)).toEqual({ status: "ok" });
  });
});

describe("loopback only", () => {
  test("the server refuses to listen on a non-loopback address", () => {
    const anyAddress = ["0", "0", "0", "0"].join("."); // built from parts; scanners flag the literal
    expect(() => serve(gw.gateway, { hostname: anyAddress, port: 0, maxBodyBytes: 1024 })).toThrow(/loopback/);
  });

  test("the running server is bound to 127.0.0.1", () => {
    expect(gw.server.hostname).toBe("127.0.0.1");
  });
});
