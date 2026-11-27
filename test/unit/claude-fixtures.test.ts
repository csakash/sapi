/**
 * Guards for the recorded Claude CLI fixtures (test/fixtures/claude-cli/*.jsonl).
 *
 * 1. They must stay free of personal or machine data, because this repo is public.
 * 2. They pin the stream shape the Claude adapter will rely on in Phase 1, so a CLI upgrade that
 *    changes it shows up here first.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../fixtures/claude-cli");
const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
const load = (f: string) =>
  readFileSync(join(DIR, f), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("claude-cli fixtures", () => {
  test("there are fixtures to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const f of files) {
    test(`${f} contains no personal or machine data`, () => {
      const raw = readFileSync(join(DIR, f), "utf8");
      expect(raw).not.toMatch(/\/Users\/|\/home\/(?!user\b)|\/var\/folders\//);
      expect(raw).not.toMatch(/[\w.+-]+@(?!example\.invalid)[\w-]+\.[a-z]{2,}/i);
      expect(raw).not.toMatch(/sk-ant-|sk-proj-|sk-sapi-[0-9a-f]{8}/);
    });

    test(`${f} starts with an init event that has no tools and no MCP servers`, () => {
      const init = load(f).find((e) => e.type === "system" && e.subtype === "init");
      expect(init).toBeDefined();
      // Phase 0 finding: --json-schema adds the CLI's own output-only "StructuredOutput" tool even
      // with --tools "". That is the only tool the adapter may ever accept.
      const allowed = f === "json-schema.jsonl" ? ["StructuredOutput"] : [];
      expect(init.tools).toEqual(allowed);
      expect(init.mcp_servers).toEqual([]);
    });

    test(`${f} ends with exactly one result event`, () => {
      const events = load(f);
      expect(events.filter((e) => e.type === "result")).toHaveLength(1);
      expect(events.at(-1).type).toBe("result");
    });
  }

  test("successful runs stream text deltas and report usage, cost and timings", () => {
    for (const f of ["short-ok.jsonl", "long-stream.jsonl"]) {
      const events = load(f);
      expect(events.some((e) => e.type === "stream_event" && e.event?.type === "content_block_delta")).toBe(true);
      const result = events.at(-1);
      expect(result.is_error).toBe(false);
      for (const k of ["duration_ms", "duration_api_ms", "total_cost_usd", "usage", "num_turns"]) {
        expect(result).toHaveProperty(k);
      }
    }
  });

  test("successful runs carry a rate_limit_event with a utilization figure", () => {
    const rl = load("short-ok.jsonl").find((e) => e.type === "rate_limit_event");
    expect(rl?.rate_limit_info?.status).toBeString();
    const windows = Object.values<any>(rl.rate_limit_info.unifiedWindows ?? {});
    expect(windows.length).toBeGreaterThan(0);
    expect(typeof windows[0].utilization).toBe("number");
  });

  test("structured output returns the JSON object as the result", () => {
    const result = load("json-schema.jsonl").at(-1);
    expect(JSON.parse(result.result)).toEqual({ city: "Paris" });
  });

  test("error runs are marked is_error with a readable message", () => {
    expect(load("not-logged-in.jsonl").at(-1)).toMatchObject({ is_error: true });
    expect(load("not-logged-in.jsonl").at(-1).result).toContain("Not logged in");
    expect(load("invalid-model.jsonl").at(-1)).toMatchObject({ is_error: true });
  });
});
