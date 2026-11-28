/**
 * Phase 2 setup, doctor and uninstall, end to end in a temporary folder with the test provider.
 *
 *   AUTH-1 / GW-1  the first key is shown once: written to a 0600 env file or stdout when asked,
 *                  never echoed to the progress log (so it stays out of CI logs)
 *   setup          writes a valid loopback config (0600), runs a real self-test through HTTP, and
 *                  is safe to run again: no new key, the env file left alone
 *   LOG-1          doctor notices a log row deleted outside sapi, open permissions and kill switches
 *   uninstall      --purge deletes only folders that are recognisably sapi's, after confirmation
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { findClientByName, listClients } from "../../src/auth.ts";
import { loadConfig } from "../../src/config.ts";
import { openDb } from "../../src/db.ts";
import { setPaused } from "../../src/killswitch.ts";
import type { Paths } from "../../src/paths.ts";
import { findClaude } from "../../src/setup/claude.ts";
import { runDoctor } from "../../src/setup/doctor.ts";
import type { Machine } from "../../src/setup/machine.ts";
import { runSetup, type SetupIo, type SetupOptions } from "../../src/setup/setup.ts";
import { runUninstall } from "../../src/setup/uninstall.ts";
import { startGateway } from "../../src/start.ts";
import { bearer, jsonOf, tempRoot, testPaths } from "../helpers.ts";

const noServiceMachine: Machine = {
  os: process.platform === "darwin" ? "macos" : "linux",
  osName: "Test OS",
  arch: process.arch,
  ssh: false,
  headless: true,
  container: false,
  wsl: false,
  root: false,
  serviceManager: "none",
  serviceProblem: "test machine",
};

function captureIo(answers: { confirm?: boolean } = {}): SetupIo & { infoText: () => string; outText: () => string } {
  const info: string[] = [];
  const out: string[] = [];
  return {
    interactive: false,
    info: (l) => info.push(l),
    out: (l) => out.push(l),
    confirm: async (_q, def) => answers.confirm ?? def,
    text: async (_q, def) => def,
    infoText: () => info.join("\n"),
    outText: () => out.join("\n"),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

let root: string;
let paths: Paths;
let port: number;
let envFile: string;
let firstInfo: string;
let firstCode: number;
const KEY_RE = /sk-sapi-[A-Za-z0-9_-]{43}/;

const options = (over: Partial<SetupOptions> = {}): SetupOptions => ({
  yes: true,
  providers: ["fake"],
  printEnv: false,
  selfTest: true,
  service: false,
  client: "app",
  envFile,
  port,
  ...over,
});

beforeAll(async () => {
  root = tempRoot();
  paths = testPaths(root);
  port = await freePort();
  envFile = join(root, "secrets", "app.env");
  const io = captureIo();
  firstCode = await runSetup(paths, options(), io, { machine: noServiceMachine });
  firstInfo = io.infoText();
}, 60_000);

describe("sapi setup --yes (test provider)", () => {
  test("finishes without problems", () => {
    expect(firstInfo).not.toContain("✗");
    expect(firstCode).toBe(0);
  });

  test("writes a private, valid, loopback-only config", () => {
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    const cfg = loadConfig(paths.configFile);
    expect(cfg.listen).toBe(`127.0.0.1:${port}`);
    expect(cfg.models.echo).toEqual({ provider: "fake", model: "fake-echo-1" });
  });

  test("the key goes to a 0600 env file and never into the progress log (AUTH-1, GW-1)", () => {
    const env = readFileSync(envFile, "utf8");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(env).toContain(`OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`);
    const key = KEY_RE.exec(env)?.[0];
    expect(key).toBeDefined();
    expect(firstInfo).not.toContain(key!);
    expect(firstInfo).not.toMatch(KEY_RE);
  });

  test("the self-test went through HTTP as the reserved client, which is disabled afterwards", () => {
    expect(firstInfo).toMatch(/Test provider: [\d.]+ s to first token \(echo\)/);
    const db = openDb(paths.dbFile);
    try {
      const st = findClientByName(db, "sapi-selftest");
      expect(st?.disabled).toBe(true);
      const row = db.query("SELECT status FROM requests WHERE client_id = ?").get(st!.id) as { status: string };
      expect(row.status).toBe("ok");
    } finally {
      db.close();
    }
  });

  test("the key it wrote works against the gateway", async () => {
    const key = KEY_RE.exec(readFileSync(envFile, "utf8"))![0];
    const running = await startGateway({ paths, cfg: loadConfig(paths.configFile), port: 0, launcher: null });
    try {
      const r = await fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: { ...bearer(key), "content-type": "application/json" },
        body: JSON.stringify({ model: "echo", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(200);
      expect((await jsonOf(r)).choices[0].message.content).toBe("echo: hi");
    } finally {
      await running.stop();
    }
  });

  test("running it again is safe: no new key, the env file is left alone", async () => {
    const before = readFileSync(envFile, "utf8");
    const mtime = statSync(envFile).mtimeMs;
    const io = captureIo();
    expect(await runSetup(paths, options(), io, { machine: noServiceMachine })).toBe(0);
    expect(io.infoText()).toContain('"app" already exists');
    expect(io.infoText()).toContain("kept your config");
    expect(readFileSync(envFile, "utf8")).toBe(before);
    expect(statSync(envFile).mtimeMs).toBe(mtime);
    const db = openDb(paths.dbFile);
    try {
      expect(listClients(db).filter((c) => c.name === "app")).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 30_000);

  test("--print-env puts the two lines on stdout only", async () => {
    const io = captureIo();
    expect(
      await runSetup(paths, options({ client: "second", envFile: undefined, printEnv: true, selfTest: false }), io, {
        machine: noServiceMachine,
      }),
    ).toBe(0);
    expect(io.outText()).toMatch(new RegExp(`^OPENAI_BASE_URL=http://127.0.0.1:${port}/v1\nOPENAI_API_KEY=sk-sapi-`));
    expect(io.infoText()).not.toMatch(KEY_RE);
  });

  test("reserved client names are refused", async () => {
    const io = captureIo();
    expect(
      await runSetup(paths, options({ client: "sapi-sneaky", envFile: undefined, selfTest: false }), io, {
        machine: noServiceMachine,
      }),
    ).toBe(1);
    expect(io.infoText()).toContain("reserved");
  });

  test("root is refused before anything is written", async () => {
    const r2 = tempRoot();
    const io = captureIo();
    expect(await runSetup(testPaths(r2), options(), io, { machine: { ...noServiceMachine, root: true } })).toBe(1);
    expect(existsSync(testPaths(r2).configDir)).toBe(false);
  });

  test("a port taken by another program stops setup with a fix", async () => {
    const r2 = tempRoot();
    const busy: Server = createServer().listen({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => busy.once("listening", r));
    try {
      const io = captureIo();
      const p = (busy.address() as { port: number }).port;
      expect(await runSetup(testPaths(r2), options({ port: p }), io, { machine: noServiceMachine })).toBe(1);
      expect(io.infoText()).toContain("taken by another program");
      expect(io.infoText()).toContain("--port");
    } finally {
      busy.close();
    }
  });
});

describe("sapi doctor", () => {
  const doctor = () => runDoctor({ paths, offline: true, machine: noServiceMachine, service: null });

  test("a fresh setup checks out", async () => {
    const checks = await doctor();
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(by.config?.status).toBe("ok");
    expect(by["log-chain"]?.status).toBe("ok");
    expect(by.clients?.status).toBe("ok");
    expect(by.claude?.status).toBe("skip");
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  test("a kill switch left on is a warning with the resume command", async () => {
    const db = openDb(paths.dbFile);
    setPaused(db, { scope: "global", target: "*" }, true);
    db.close();
    const c = (await doctor()).find((x) => x.id === "kill-switch")!;
    expect(c.status).toBe("warn");
    expect(c.fix).toBe("sapi resume");
    const db2 = openDb(paths.dbFile);
    setPaused(db2, { scope: "global", target: "*" }, false);
    db2.close();
  });

  test("a data folder open to other users fails with the chmod fix", async () => {
    chmodSync(paths.dataDir, 0o755);
    try {
      const c = (await doctor()).find((x) => x.id === "data-dir")!;
      expect(c.status).toBe("fail");
      expect(c.fix).toBe(`chmod 700 ${paths.dataDir}`);
    } finally {
      chmodSync(paths.dataDir, 0o700);
    }
  });

  test("a log row deleted outside sapi is caught (LOG-1)", async () => {
    const r2 = tempRoot();
    const p2 = testPaths(r2);
    await runSetup(p2, options({ envFile: join(r2, "x.env"), port: await freePort() }), captureIo(), {
      machine: noServiceMachine,
    });
    const db = openDb(p2.dbFile);
    db.exec("DELETE FROM events WHERE seq = 2");
    db.close();
    const c = (await runDoctor({ paths: p2, offline: true, machine: noServiceMachine, service: null })).find(
      (x) => x.id === "log-chain",
    )!;
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("changed outside sapi");
  }, 30_000);
});

describe("sapi uninstall", () => {
  test("without --purge it keeps config and data", async () => {
    const io = captureIo();
    expect(
      await runUninstall(paths, { purge: false, yes: true }, io, { machine: noServiceMachine, binary: null }),
    ).toBe(0);
    expect(existsSync(paths.dbFile)).toBe(true);
    expect(io.infoText()).toContain("sapi uninstall --purge");
  });

  test("--purge asks first; saying no deletes nothing", async () => {
    const io = captureIo({ confirm: false });
    expect(
      await runUninstall(paths, { purge: true, yes: false }, io, { machine: noServiceMachine, binary: null }),
    ).toBe(0);
    expect(existsSync(paths.dbFile)).toBe(true);
  });

  test("--purge refuses a data folder that isn't recognisably sapi's", async () => {
    const r2 = tempRoot();
    const odd = { ...testPaths(r2), dataDir: join(r2, "photos"), dbFile: join(r2, "photos", "x") };
    mkdirSync(odd.dataDir);
    writeFileSync(join(odd.dataDir, "holiday.jpg"), "x");
    const io = captureIo();
    expect(await runUninstall(odd, { purge: true, yes: true }, io, { machine: noServiceMachine, binary: null })).toBe(
      1,
    );
    expect(existsSync(join(odd.dataDir, "holiday.jpg"))).toBe(true);
  });

  test("--purge --yes signs the profile out, removes the binary and sapi's folders", async () => {
    const fakeBinary = join(root, "bin-sapi");
    writeFileSync(fakeBinary, "x");
    let loggedOut = false;
    const io = captureIo();
    const code = await runUninstall(paths, { purge: true, yes: true }, io, {
      machine: noServiceMachine,
      binary: fakeBinary,
      signedIn: () => true,
      logout: () => {
        loggedOut = true;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(existsSync(fakeBinary)).toBe(false);
    for (const d of [paths.configDir, paths.dataDir]) expect(existsSync(d)).toBe(false);
    // Signing out happens whenever a claude CLI can be found (it removes the profile's keychain entry).
    expect(loggedOut).toBe(findClaude(paths.home) !== null);
    expect(existsSync(envFile)).toBe(true); // the user's own env file is not sapi's to delete
  });
});
