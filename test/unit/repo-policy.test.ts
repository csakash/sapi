/**
 * Repository policy checks, run by `bun run ci` before every push (ARI-42 SDLC-2, SDLC-5, SDLC-6,
 * GW-2).
 *
 * These are cited as evidence in ARI42.md, so keep them strict.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((x) => p.endsWith(x))) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

describe("SDLC-2: no permission-bypass modes in shipped code", () => {
  // Built from parts so this file itself doesn't contain the literal flags.
  const banned = [
    ["--dangerously", "skip", "permissions"].join("-"),
    ["--allow", "dangerously", "skip", "permissions"].join("-"),
    ["bypass", "Permissions"].join(""),
    ["--", "yolo"].join(""),
  ];
  const files = [...filesUnder("src", [".ts"]), ...filesUnder("scripts", [".ts", ".sh", ".sb"])];

  test("there is code to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    test(`${relative(ROOT, f)} uses no bypass flag`, () => {
      const text = readFileSync(f, "utf8");
      for (const b of banned) expect(text.includes(b)).toBe(false);
    });
  }
});

/** What's wrong with a GitHub workflow file, as far as SDLC-5 and GW-2 go. */
function workflowProblems(text: string): string[] {
  const out: string[] = [];
  if (!/^permissions:\s*(read-all|\n\s+contents:\s*read)/m.test(text)) out.push("token isn't read-only by default");
  if (/^\s*(pull_request_target|issue_comment)\s*:/m.test(text))
    out.push("pull_request_target or issue_comment trigger");
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? "");
  if (uses.some((u) => !u.startsWith("./") && !/@[0-9a-f]{40}$/.test(u)))
    out.push("an action isn't pinned to a full commit SHA");
  const checkouts = text.split(/\n(?=\s*- )/).filter((s) => s.includes("actions/checkout@"));
  if (checkouts.some((c) => !/persist-credentials:\s*false/.test(c))) out.push("checkout persists credentials");
  if (/claude-code-action|codex-action|run-gemini-cli|\bclaude\s+-p\b|\bcodex\s+exec\b/.test(text))
    out.push("an AI agent step");
  return out;
}

describe("SDLC-5 / GW-2: GitHub workflows are locked down", () => {
  // sapi has no workflows: no hosted CI, at the owner's request (`bun run ci` runs the checks).
  // A workflow added later must pass the same policy.
  test("the policy passes a safe workflow and catches every problem in an unsafe one", () => {
    const safe = [
      "on: [pull_request]",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  t:",
      "    steps:",
      `      - uses: actions/checkout@${"a".repeat(40)}`,
      "        with:",
      "          persist-credentials: false",
    ].join("\n");
    const unsafe = [
      "on:",
      "  pull_request_target:",
      "permissions: write-all",
      "jobs:",
      "  t:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - uses: example/${["claude", "code", "action"].join("-")}@v1`, // built from parts
    ].join("\n");
    expect(workflowProblems(safe)).toEqual([]);
    expect(workflowProblems(unsafe)).toHaveLength(5);
  });

  const dir = join(ROOT, ".github/workflows");
  const workflows = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
  for (const wf of workflows) {
    test(`${wf} is locked down`, () => {
      expect(workflowProblems(read(`.github/workflows/${wf}`))).toEqual([]);
    });
  }
});

describe("SDLC-6 / GW-2: dependencies are locked and pinned", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = read("bun.lock");

  test("every dependency is pinned to an exact version", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [name, range] of Object.entries(all)) {
      expect({ name, range }).toEqual({ name, range: expect.stringMatching(/^\d+\.\d+\.\d+([-+][\w.]+)?$/) });
    }
  });

  test("every locked package carries an integrity hash", () => {
    const entries = [...lock.matchAll(/^\s{4}"([^"]+)": \["[^"]+@[^"]+", "[^"]*", \{.*?\}, "([^"]*)"\]/gm)];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, name, integrity] of entries) {
      expect({ name, integrity }).toEqual({ name, integrity: expect.stringMatching(/^sha512-/) });
    }
  });

  test("Bun refuses package versions younger than 7 days", () => {
    const m = read("bunfig.toml").match(/^minimumReleaseAge\s*=\s*(\d+)/m);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(7 * 24 * 3600);
  });

  test("Renovate waits at least 7 days before proposing a new release", () => {
    const renovate = JSON.parse(read("renovate.json"));
    expect(renovate.minimumReleaseAge).toBe("7 days");
    expect(renovate.internalChecksFilter).toBe("strict");
  });

  test("the dev container image is pinned by digest", () => {
    expect(read(".devcontainer/Dockerfile")).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
  });
});
