/**
 * ARI-42 OUT-4, INJ-4, SDLC-4: under the real launcher for this OS (sandbox-exec on macOS,
 * bwrap or the systemd fallback on Linux), a process started exactly the way the Claude child is
 * started can't read secrets or sapi's own data and config, can't write outside its work dir and
 * profile, isn't root, and can't reach the network except through the egress proxy, which refuses
 * anything off the allowlist.
 *
 * The probe runs through the real ClaudeAdapter (env, argv, work dir, launcher, proxy). When no
 * launcher works on the machine the test is skipped and says why; `bun run ci` refuses that skip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EgressProxy } from "../../src/egress-proxy.ts";
import { ensurePrivateDir } from "../../src/paths.ts";
import { ClaudeAdapter } from "../../src/providers/claude-sub/adapter.ts";
import { claudeManifest } from "../../src/providers/claude-sub/manifest.ts";
import { detectLauncher } from "../../src/sandbox/launchers.ts";
import { bridgeCommand } from "../../src/start.ts";
import { tempRoot, testPaths, writeFakeClaude } from "../helpers.ts";

const probe = detectLauncher();
const launcher = probe.launcher;
const tried = probe.tried.map((t) => t.name).join(", ") || "none";
if (!launcher) console.warn(`confinement tests skipped: no launcher works here (tried ${tried})`);

// `bun run ci` sets this so a missing sandbox fails the build instead of quietly skipping (EVAL-1).
test.if(process.env.SAPI_REQUIRE_SANDBOX_TESTS === "1")("a sandbox launcher is available", () => {
  expect({ launcher: launcher?.name ?? null, tried }).toEqual({ launcher: expect.any(String), tried });
});

let root: string;
let proxy: EgressProxy;
let report: Record<string, unknown>;
const blocked: Array<{ host: string; reason?: string }> = [];

beforeAll(async () => {
  if (!launcher) return;
  root = tempRoot();
  const paths = testPaths(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
  mkdirSync(join(home, "Library", "Preferences"), { recursive: true });
  // Where a background service would be installed: the child must never be able to add one.
  const persistenceDir =
    process.platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(home, ".config", "systemd", "user");
  mkdirSync(persistenceDir, { recursive: true });
  writeFileSync(join(home, ".ssh", "id_test"), "PRIVATE KEY MATERIAL");
  const dataDir = ensurePrivateDir(paths.dataDir);
  const configDir = ensurePrivateDir(paths.configDir);
  writeFileSync(join(dataDir, "sapi-test.db"), "client key hashes");
  writeFileSync(join(configDir, "config.toml"), 'listen = "127.0.0.1:8787"\n');
  const runDir = ensurePrivateDir(paths.runDir);

  proxy = new EgressProxy({
    allow: claudeManifest.egressHosts,
    onEvent: (e) => e.kind === "egress_blocked" && blocked.push(e),
  });
  const tcpPort = await proxy.listenTcp();
  const socketPath = join(runDir, "egress.sock");
  if (process.platform === "linux") await proxy.listenUnix(socketPath);

  const b = bridgeCommand();
  const adapter = new ClaudeAdapter({
    binary: writeFakeClaude(join(root, "bin"), "probe"),
    versionRange: ">=2.1.332",
    auth: "cli",
    launcher,
    profileDir: paths.claudeProfileDir,
    runDir,
    claudeEnvFile: paths.claudeEnvFile,
    hostHome: home,
    hiddenPaths: [dataDir, configDir],
    egress: { tcpPort, socketPath },
    bridgeCommand: b.command,
    bridgeReadOnlyPaths: b.readOnly,
    memoryMaxMb: 1024,
    firstTokenTimeoutMs: 30_000,
    totalTimeoutMs: 60_000,
  });
  const ask = JSON.stringify({
    sshFile: join(home, ".ssh", "id_test"),
    dataFile: join(dataDir, "sapi-test.db"),
    configFile: join(configDir, "config.toml"),
    outsideFile: join(home, "pwned.txt"),
    keychainDir: join(home, "Library", "Keychains"),
    libraryFile: join(home, "Library", "Preferences", "pwned.plist"),
    persistenceFile: join(persistenceDir, process.platform === "darwin" ? "pwned.plist" : "pwned.service"),
  });
  let text = "";
  for await (const ev of adapter.send(
    {
      id: "req_probe",
      clientId: "cli_probe",
      door: "chat",
      alias: "haiku",
      provider: "claude-sub",
      model: "claude-haiku-5-5",
      messages: [{ role: "user", text: ask }],
      stream: false,
      ignoredParams: [],
    },
    new AbortController().signal,
  )) {
    if (ev.type === "text") text += ev.delta;
  }
  report = JSON.parse(text);
}, 60_000);

afterAll(async () => {
  await proxy?.close();
});

describe.skipIf(!launcher)(`confinement under ${launcher?.name ?? "no launcher"} (OUT-4)`, () => {
  test("the child is not root", () => {
    expect(report.uidIsRoot).toBe(false);
  });

  test("secret folders under the home directory can't be read", () => {
    expect(report.readSshBlocked).toBe(true);
  });

  test("sapi's own data and config can't be read or changed (SDLC-4)", () => {
    expect(report.readSapiDataBlocked).toBe(true);
    expect(report.readSapiConfigBlocked).toBe(true);
  });

  test("writes outside the work dir and profile fail; inside them they work", () => {
    expect(report.writeOutsideBlocked).toBe(true);
    expect(report.writeWorkDirAllowed).toBe(true);
    expect(report.writeProfileAllowed).toBe(true);
  });

  test.if(process.platform === "darwin")(
    "macOS: the child's fresh HOME links only the keychain folder, which is the one writable spot under Library",
    () => {
      expect(report.keychainLinked).toBe(true);
      expect(report.writeKeychainAllowed).toBe(true);
      expect(report.writeOtherLibraryBlocked).toBe(true);
    },
  );

  test.if(process.platform !== "darwin")("Linux: no keychain link in the child's HOME", () => {
    expect(report.keychainLinked).toBe(false);
  });

  test("the child can't install a launchd agent or systemd unit (SDLC-4: no persistence)", () => {
    expect(report.writePersistenceBlocked).toBe(true);
  });

  test("no direct network: an internet address and the metadata address are unreachable (INJ-4)", () => {
    expect(report.directInternetBlocked).toBe(true);
    expect(report.directMetadataBlocked).toBe(true);
  });

  test("through the proxy, hosts off the allowlist and IP literals are refused (INJ-4)", () => {
    expect(report.proxyExampleCom).toBe(403);
    expect(report.proxyMetadataIp).toBe(403);
    expect(blocked.map((b) => b.reason)).toEqual(
      expect.arrayContaining(["not_on_allowlist", "ip_literal_or_bad_host"]),
    );
  });

  test("the child's environment holds only the allowlisted names (GW-1)", () => {
    const names = (report.envNames as string[]).filter((n) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(n));
    expect(
      names.every((n) =>
        /^(PATH|HOME|USER|LOGNAME|LANG|TZ|CLAUDE_|DISABLE_|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)/.test(n),
      ),
    ).toBe(true);
  });
});
