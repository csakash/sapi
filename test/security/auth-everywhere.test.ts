/**
 * ARI-42 GW-2, MCP-3: walk every route without credentials and expect 401. The only route that
 * answers without a key is /healthz, and it reveals nothing but "ok".
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { jsonOf, startTestGateway, type TestGateway } from "../helpers.ts";

let gw: TestGateway;
beforeAll(async () => {
  gw = await startTestGateway();
});
afterAll(() => gw.cleanup());

const API_ROUTES: Array<[string, string]> = [
  ["GET", "/v1/models"],
  ["POST", "/v1/chat/completions"],
];

test("every API route needs a client key", async () => {
  for (const [method, path] of API_ROUTES) {
    const r = await fetch(`http://127.0.0.1:${gw.server.port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST"
        ? { body: JSON.stringify({ model: "echo", messages: [{ role: "user", content: "x" }] }) }
        : {}),
    });
    expect({ method, path, status: r.status }).toEqual({ method, path, status: 401 });
  }
});

test("the admin surface is refused without the admin session", async () => {
  for (const path of ["/", "/api", "/api/live"]) expect((await gw.get(path)).status).toBe(403);
});

test("unknown paths are 404, not an open door", async () => {
  for (const path of ["/v1/completions", "/v1/embeddings", "/metrics", "/debug"])
    expect((await gw.get(path)).status).toBe(404);
});

test("/healthz is the only unauthenticated route and leaks nothing", async () => {
  const r = await gw.get("/healthz");
  const body = await jsonOf(r);
  expect(Object.keys(body)).toEqual(["status"]);
});
