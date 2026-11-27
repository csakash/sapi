/**
 * Test helpers: a gateway in a throwaway directory, using the fake provider unless a test asks
 * for the Claude adapter. Nothing here touches the user's real sapi data or Claude login.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Budget, createClient, type Scope } from "../src/auth.ts";
import { parseConfig } from "../src/config.ts";
import { type Paths, resolvePaths } from "../src/paths.ts";
import { noLauncher } from "../src/sandbox/launchers.ts";
import { type Running, type StartOptions, startGateway } from "../src/start.ts";

process.env.SAPI_LOG = "off";

export const FIXTURES = join(import.meta.dir, "fixtures");

export const TEST_MODELS = {
  echo: { provider: "fake", model: "fake-echo-1" },
  slow: { provider: "fake", model: "fake-slow-1" },
  broken: { provider: "fake", model: "fake-error-1" },
  haiku: { provider: "claude-sub", model: "claude-haiku-5-5" },
};

export function tempRoot(prefix = "sapi-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function testPaths(root: string): Paths {
  return resolvePaths({
    SAPI_CONFIG_DIR: join(root, "config"),
    SAPI_DATA_DIR: join(root, "data"),
    SAPI_RUN_DIR: join(root, "run"),
  });
}

export type TestGateway = Running & {
  root: string;
  paths: Paths;
  addClient: (name: string, opts?: { scope?: Scope; budget?: Budget; expiresAt?: number | null }) => string;
  post: (path: string, body: unknown, headers?: Record<string, string>, signal?: AbortSignal) => Promise<Response>;
  get: (path: string, headers?: Record<string, string>) => Promise<Response>;
  cleanup: () => Promise<void>;
};

export async function startTestGateway(
  o: { config?: Record<string, unknown>; start?: Partial<StartOptions> } = {},
): Promise<TestGateway> {
  const root = tempRoot();
  const paths = testPaths(root);
  const cfg = parseConfig({ models: TEST_MODELS, ...o.config });
  const running = await startGateway({ paths, cfg, port: 0, launcher: noLauncher, switchPollMs: 50, ...o.start });
  const port = running.server.port;
  const base = `http://127.0.0.1:${port}`;
  return {
    ...running,
    root,
    paths,
    addClient: (name, opts = {}) => createClient(running.db, { name, ...opts }).key,
    post: (path, body, headers = {}, signal) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      }),
    get: (path, headers = {}) => fetch(base + path, { headers }),
    cleanup: async () => {
      await running.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/**
 * Credential-shaped test strings, built at runtime so secret scanners (gitleaks, ari42_scan) don't
 * mistake the test source for leaked keys. None of these is a real credential.
 */
export const fakeSecret = {
  anthropic: (kind = "api03") => ["sk", "ant", kind, "TESTONLY".repeat(4)].join("-"),
  openai: () => ["sk", "proj", "TESTONLY".repeat(4)].join("-"),
  sapi: () => ["sk", "sapi", `${"TESTONLY".repeat(5)}abc`].join("-"),
  github: () => ["ghp", "TESTONLY".repeat(5)].join("_"),
  aws: () => ["AK", "IA", "TESTONLYTESTONLY"].join(""),
  jwt: () => ["eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiJ0ZXN0In0", ".", "c2lnbmF0dXJlLXRlc3Qtb25seQ"].join(""),
};

/** A response body as loosely typed JSON, for assertions. */
export const jsonOf = (r: Response): Promise<any> => r.json() as Promise<any>;

/** Read an SSE body into its data payloads (strings), stopping at the end of the stream. */
export async function readSse(res: Response): Promise<string[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: "))
    .map((f) => f.slice(6));
}

/**
 * An executable stand-in for the `claude` binary: a tiny shell wrapper that runs
 * test/fixtures/fake-claude.ts with bun. It answers --version and `auth status`, and otherwise
 * replies in stream-json with whatever the mode asks for (its env, its argv, a fixture…).
 */
export function writeFakeClaude(dir: string, mode: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, "fake-claude.ts")}" "${mode}" "$@"\n`);
  chmodSync(bin, 0o755);
  return realpathSync(bin);
}
