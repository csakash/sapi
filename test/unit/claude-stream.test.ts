/**
 * Replays the recorded CLI fixtures through the stream parser (OUT-1: every line parsed with a
 * schema; GOV-4/MCP-1: an init event with tools or MCP servers stops the request).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalEvent } from "../../src/canonical.ts";
import { ClaudeStreamParser, NotSignedInError, windowName } from "../../src/providers/claude-sub/stream.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../fixtures/claude-cli", `${name}.jsonl`), "utf8").split("\n");

function run(lines: string[], allowStructuredOutput = false): { events: CanonicalEvent[]; parser: ClaudeStreamParser } {
  const parser = new ClaudeStreamParser({ allowStructuredOutput });
  const events: CanonicalEvent[] = [];
  for (const l of lines) events.push(...parser.feed(l));
  parser.end(0);
  return { events, parser };
}

const init = (extra: object = {}) =>
  JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: "claude-haiku-5-5", ...extra });

describe("recorded fixtures", () => {
  test("short-ok: start, text, weekly window, usage, done", () => {
    const { events } = run(fixture("short-ok"));
    expect(events[0]).toEqual({ type: "start", providerModel: "claude-haiku-5-5" });
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("ok");
    expect(events).toContainEqual({
      type: "limit",
      limit: { window: "weekly", usedPct: 42, resetsAt: new Date(1800000000 * 1000).toISOString(), source: "reported" },
    });
    const usage = events.find((e) => e.type === "usage") as Extract<CanonicalEvent, { type: "usage" }>;
    expect(usage.usage.output).toBe(4);
    expect(usage.usage.cacheWrite).toBe(628);
    expect(usage.usage.apiEquivUsd).toBeGreaterThan(0);
    expect(events[events.length - 1]).toEqual({ type: "done", finish: "stop" });
  });

  test("long-stream: many deltas join into the result text", () => {
    const { events } = run(fixture("long-stream"));
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(3);
    const result = fixture("long-stream")
      .map((l) => (l ? JSON.parse(l) : null))
      .find((d) => d?.type === "result");
    expect(text).toBe(result.result);
  });

  test("json-schema: allowed only when structured output was requested", () => {
    expect(() => run(fixture("json-schema"), false)).toThrow(/tools or MCP servers/);
    expect(() => run(fixture("json-schema"), true)).not.toThrow();
  });

  test("not-logged-in → NotSignedInError (provider_not_ready)", () => {
    let err: unknown;
    try {
      run(fixture("not-logged-in"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotSignedInError);
    expect((err as NotSignedInError).kind).toBe("provider_not_ready");
  });

  test("invalid-model → upstream_error naming the config, not echoing CLI text", () => {
    expect(() => run(fixture("invalid-model"))).toThrow(/Check \[models\]/);
  });
});

describe("hostile or broken streams", () => {
  test("an init event listing a tool stops the request", () => {
    expect(() => run([init({ tools: ["Bash"] })])).toThrow(/tools or MCP servers/);
  });

  test("an init event listing an MCP server stops the request", () => {
    expect(() => run([init({ mcp_servers: [{ name: "evil", status: "connected" }] })])).toThrow(/tools or MCP servers/);
  });

  test("output before init is refused", () => {
    const p = new ClaudeStreamParser({ allowStructuredOutput: false });
    expect(() =>
      p.feed(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
        }),
      ),
    ).toThrow();
  });

  test("garbage and unknown lines are dropped, not trusted", () => {
    const p = new ClaudeStreamParser({ allowStructuredOutput: false });
    p.feed(init());
    expect(p.feed("not json")).toEqual([]);
    expect(p.feed(JSON.stringify({ type: "tool_use", name: "Bash", input: { command: "rm -rf /" } }))).toEqual([]);
    expect(p.stats.dropped).toBe(2);
  });

  test("a stream that ends without a result is an upstream error", () => {
    const p = new ClaudeStreamParser({ allowStructuredOutput: false });
    p.feed(init());
    expect(() => p.end(1)).toThrow(/before finishing/);
  });

  test("a rejected usage window marks the provider exhausted until reset", () => {
    const p = new ClaudeStreamParser({ allowStructuredOutput: false });
    p.feed(init());
    const reset = Math.floor(Date.now() / 1000) + 3600;
    p.feed(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: reset,
          unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset, status: "rejected" } },
        },
      }),
    );
    expect(p.exhaustedUntil).toBe(reset * 1000);
    let err: { kind?: string; retryAfterSec?: number } = {};
    try {
      p.feed(JSON.stringify({ type: "result", is_error: true, result: "limit", api_error_status: 429 }));
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.kind).toBe("provider_window_exhausted");
    expect(err.retryAfterSec).toBeGreaterThan(3000);
  });

  test("window names map to sapi's names", () => {
    expect(windowName("five_hour")).toBe("5h");
    expect(windowName("seven_day")).toBe("weekly");
    expect(windowName("seven_day_opus")).toBe("weekly_opus");
    expect(windowName("<script>")).toBe("script");
  });
});
