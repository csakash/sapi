import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { run } from "../../src/cli.ts";
import { tempRoot } from "../helpers.ts";

let root: string;
const saved = { cfg: process.env.SAPI_CONFIG_DIR, data: process.env.SAPI_DATA_DIR, run: process.env.SAPI_RUN_DIR };

beforeAll(() => {
  root = tempRoot();
  process.env.SAPI_CONFIG_DIR = join(root, "config");
  process.env.SAPI_DATA_DIR = join(root, "data");
  process.env.SAPI_RUN_DIR = join(root, "run");
});
afterAll(() => {
  for (const [k, v] of [
    ["SAPI_CONFIG_DIR", saved.cfg],
    ["SAPI_DATA_DIR", saved.data],
    ["SAPI_RUN_DIR", saved.run],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("cli", () => {
  test("--version prints the package version", async () => {
    expect(await run(["--version"])).toEqual({ code: 0, out: pkg.version });
  });

  test("--help names the project and the non-affiliation notice", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("127.0.0.1:8787");
    expect(out).toContain("not affiliated with Anthropic or OpenAI");
  });

  test("unknown commands fail clearly; planned ones say so", async () => {
    expect((await run(["frobnicate"])).code).toBe(2);
    const planned = await run(["setup"]);
    expect(planned.code).toBe(2);
    expect(planned.out).toContain("not implemented yet");
  });

  test("clients add prints the key once; list shows only the prefix", async () => {
    const add = await run(["clients", "add", "my-scripts", "--models", "haiku", "--rpm", "30"]);
    expect(add.code).toBe(0);
    const key = /sk-sapi-[A-Za-z0-9_-]{43}/.exec(add.out)?.[0];
    expect(key).toBeDefined();
    const list = await run(["clients", "list"]);
    expect(list.out).toContain("my-scripts");
    expect(list.out).not.toContain(key!);
    expect(list.out).toContain(key!.slice(0, 16));
  });

  test("clients add refuses unknown models, bad names and duplicates", async () => {
    expect((await run(["clients", "add", "x", "--models", "gpt-9"])).code).toBe(1);
    expect((await run(["clients", "add", "Bad Name"])).code).toBe(1);
    expect((await run(["clients", "add", "my-scripts"])).code).toBe(1);
  });

  test("pause and resume write kill-switch state", async () => {
    expect((await run(["pause", "--provider", "claude-sub"])).code).toBe(0);
    expect((await run(["pause", "--client", "nobody"])).code).toBe(1);
    expect((await run(["resume", "--provider", "claude-sub"])).code).toBe(0);
  });
});
