import { describe, expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { run } from "../../src/cli.ts";

describe("cli skeleton", () => {
  test("--version prints the package version", () => {
    expect(run(["--version"])).toEqual({ code: 0, out: pkg.version });
  });

  test("--help names the project and the non-affiliation notice", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("127.0.0.1:8787");
    expect(out).toContain("not affiliated with Anthropic or OpenAI");
  });

  test("unknown commands fail clearly instead of pretending to work", () => {
    const { code, out } = run(["start"]);
    expect(code).toBe(2);
    expect(out).toContain("not implemented yet");
  });
});
