/**
 * The secret store (ARI-42 GW-1): file permissions and atomic writes, secrets never on argv,
 * a minimal environment for systemd-creds, and "auto" remembering its first choice. No test here
 * touches the real keychain: the OS backend is a fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  backendAvailable,
  type OsSecrets,
  openSecretStore,
  recordedBackend,
  type SecretDeps,
  type StdinRunner,
} from "../../src/secrets.ts";
import { tempRoot, testPaths } from "../helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function paths() {
  const r = tempRoot();
  roots.push(r);
  return testPaths(r);
}

function fakeOs(): OsSecrets & { items: Map<string, string>; services: Set<string> } {
  const items = new Map<string, string>();
  const services = new Set<string>();
  return {
    items,
    services,
    get: async ({ service, name }) => {
      services.add(service);
      return items.get(name) ?? null;
    },
    set: async ({ service, name, value }) => {
      services.add(service);
      items.set(name, value);
    },
    delete: async ({ name }) => items.delete(name),
  };
}

/** A systemd-creds stand-in that "encrypts" by base64 and records every call. */
function fakeCreds(works = true) {
  const calls: Array<{ argv: string[]; stdin: string; env: Record<string, string> }> = [];
  const run: StdinRunner = (argv, stdin, env) => {
    calls.push({ argv, stdin, env });
    if (!works) return { code: 1, stdout: "" };
    const [, verb] = argv;
    const src = argv[argv.length - 2]!;
    const dst = argv[argv.length - 1]!;
    if (verb === "encrypt") {
      const enc = Buffer.from(stdin).toString("base64");
      if (dst === "-") return { code: 0, stdout: enc };
      writeFileSync(dst, enc, { mode: 0o600 });
      return { code: 0, stdout: "" };
    }
    const input = src === "-" ? stdin : readFileSync(src, "utf8");
    return { code: 0, stdout: Buffer.from(input, "base64").toString("utf8") };
  };
  return { run, calls };
}

const SECRET = "secret-value-TESTONLY-0123456789";

describe("file backend", () => {
  test("round trip, 0600 file in a 0700 folder, no temp file left behind", async () => {
    const p = paths();
    const store = await openSecretStore(p, "file", { platform: "linux", env: {}, run: fakeCreds(false).run });
    expect(store.backend).toBe("file");
    expect(await store.get("chatgpt")).toBeNull();
    await store.set("chatgpt", SECRET);
    expect(await store.get("chatgpt")).toBe(SECRET);
    const dir = join(p.configDir, "secrets");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "chatgpt.secret")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["chatgpt.secret"]);
    expect(await store.delete("chatgpt")).toBe(true);
    expect(await store.get("chatgpt")).toBeNull();
  });

  test("refuses a secret file other users can read", async () => {
    const p = paths();
    const store = await openSecretStore(p, "file", { platform: "linux", env: {}, run: fakeCreds(false).run });
    await store.set("chatgpt", SECRET);
    chmodSync(join(p.configDir, "secrets", "chatgpt.secret"), 0o644);
    await expect(store.get("chatgpt")).rejects.toThrow(/readable by other users/);
  });

  test("names are fixed identifiers, never paths", async () => {
    const store = await openSecretStore(paths(), "file", { platform: "linux", env: {}, run: fakeCreds(false).run });
    for (const bad of ["../x", "a/b", "", "UPPER", "-flag"]) await expect(store.set(bad, "v")).rejects.toThrow();
  });
});

describe("os backend (Keychain / Secret Service via Bun.secrets)", () => {
  test("stores under sapi's own service name, in-process: no command runs", async () => {
    const os = fakeOs();
    const creds = fakeCreds();
    const store = await openSecretStore(paths(), "os", { platform: "darwin", env: {}, os, run: creds.run });
    await store.set("chatgpt", SECRET);
    expect(await store.get("chatgpt")).toBe(SECRET);
    expect([...os.services]).toEqual(["local.sapi"]);
    expect(creds.calls).toHaveLength(0);
  });

  test("Linux needs a session bus; without one it isn't offered", async () => {
    const d: SecretDeps = { platform: "linux", env: {}, os: fakeOs(), run: fakeCreds(false).run };
    expect(await backendAvailable("os", d)).toBe(false);
    expect(await backendAvailable("os", { ...d, env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" } })).toBe(true);
  });
});

describe("systemd-creds backend", () => {
  test("the secret goes over stdin only; argv and env carry nothing secret", async () => {
    const creds = fakeCreds();
    const env = { HOME: "/home/u", SAPI_SECRET: SECRET, OPENAI_API_KEY: SECRET, XDG_RUNTIME_DIR: "/run/user/1000" };
    const store = await openSecretStore(paths(), "systemd-creds", { platform: "linux", env, run: creds.run });
    await store.set("chatgpt", SECRET);
    expect(await store.get("chatgpt")).toBe(SECRET);
    expect(creds.calls.length).toBeGreaterThan(2);
    for (const c of creds.calls) {
      expect(c.argv[0]).toBe("systemd-creds");
      expect(c.argv).toContain("--user");
      expect(c.argv.join(" ")).not.toContain(SECRET);
      expect(Object.keys(c.env).sort()).toEqual(["HOME", "LANG", "PATH", "XDG_RUNTIME_DIR"]);
      expect(Object.values(c.env).join(" ")).not.toContain(SECRET);
    }
    expect(creds.calls.some((c) => c.argv[1] === "encrypt" && c.stdin === SECRET)).toBe(true);
  });

  test("not offered when systemd-creds can't round-trip, or off Linux", async () => {
    expect(await backendAvailable("systemd-creds", { platform: "linux", env: {}, run: fakeCreds(false).run })).toBe(
      false,
    );
    expect(await backendAvailable("systemd-creds", { platform: "darwin", env: {}, run: fakeCreds().run })).toBe(false);
  });
});

describe("auto", () => {
  test("macOS picks the OS store; a headless Linux VM falls back to systemd-creds, then a file", async () => {
    expect(
      (await openSecretStore(paths(), "auto", { platform: "darwin", env: {}, os: fakeOs(), run: fakeCreds().run }))
        .backend,
    ).toBe("os");
    expect(
      (await openSecretStore(paths(), "auto", { platform: "linux", env: {}, os: fakeOs(), run: fakeCreds().run }))
        .backend,
    ).toBe("systemd-creds");
    expect(
      (await openSecretStore(paths(), "auto", { platform: "linux", env: {}, run: fakeCreds(false).run })).backend,
    ).toBe("file");
  });

  test("the first write records the choice, and later processes use it even if another store appears", async () => {
    const p = paths();
    const first = await openSecretStore(p, "auto", { platform: "linux", env: {}, run: fakeCreds(false).run });
    expect(recordedBackend(p)).toBeNull();
    await first.set("chatgpt", SECRET);
    expect(recordedBackend(p)).toBe("file");
    // Later, a desktop session has a keyring: the sign-in must still be read from the file.
    const later = await openSecretStore(p, "auto", {
      platform: "linux",
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" },
      os: fakeOs(),
      run: fakeCreds().run,
    });
    expect(later.backend).toBe("file");
    expect(await later.get("chatgpt")).toBe(SECRET);
  });

  test("a recorded store that is unreachable now is an error with a fix, not a silent switch", async () => {
    const p = paths();
    const os = fakeOs();
    const s = await openSecretStore(p, "auto", { platform: "darwin", env: {}, os, run: fakeCreds().run });
    await s.set("chatgpt", SECRET);
    await expect(openSecretStore(p, "auto", { platform: "darwin", env: {}, run: fakeCreds().run })).rejects.toThrow(
      /isn't reachable from here/,
    );
  });
});
