/**
 * The secret store (plan §6, ARI-42 GW-1): where provider sign-ins live, such as the ChatGPT
 * tokens. Never in config, logs, the database, an error message or a child's environment.
 *
 *   os             macOS Keychain or Linux Secret Service, through Bun.secrets. In-process: the
 *                  value never touches argv, a pipe or a file.
 *   systemd-creds  Linux with systemd 256 or later: encrypted for this user with
 *                  `systemd-creds --user`. The plaintext goes over stdin and stdout, never argv.
 *   file           a 0600 file in a 0700 directory under sapi's config dir, written atomically.
 *
 * "auto" takes the first one that works and records the choice on the first write, so a sign-in
 * made from a terminal is found again by the background service, which may see different
 * services (no desktop keyring, for example).
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateFile, ensurePrivateDir, type Paths } from "./paths.ts";

export type SecretBackend = "os" | "systemd-creds" | "file";
export type SecretBackendChoice = SecretBackend | "auto";

/** Names are fixed in code (never request text), so they can be used as file names. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SERVICE = "local.sapi";

export interface SecretStore {
  readonly backend: SecretBackend;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** What the os backend needs from Bun.secrets (an interface so tests never touch the real keychain). */
export type OsSecrets = {
  get(o: { service: string; name: string }): Promise<string | null>;
  set(o: { service: string; name: string; value: string }): Promise<void>;
  delete(o: { service: string; name: string }): Promise<boolean>;
};

/** Runs a command with stdin; argv only, never a shell. */
export type StdinRunner = (
  argv: string[],
  stdin: string,
  env: Record<string, string>,
) => { code: number; stdout: string };

export type SecretDeps = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  os?: OsSecrets;
  run: StdinRunner;
};

export const realStdinRunner: StdinRunner = (argv, stdin, env) => {
  try {
    const r = Bun.spawnSync(argv, { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", env, timeout: 15_000 });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString() };
  } catch {
    return { code: 127, stdout: "" };
  }
};

export function realSecretDeps(): SecretDeps {
  const os = (Bun as { secrets?: OsSecrets }).secrets;
  return { platform: process.platform, env: process.env, run: realStdinRunner, ...(os ? { os } : {}) };
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error("invalid secret name");
}

/** A fixed, minimal environment for systemd-creds: never sapi's own. */
function credsEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const k of ["HOME", "USER", "XDG_RUNTIME_DIR"]) if (env[k]) out[k] = env[k]!;
  return out;
}

class OsStore implements SecretStore {
  readonly backend = "os" as const;
  constructor(private readonly api: OsSecrets) {}
  async get(name: string) {
    checkName(name);
    return (await this.api.get({ service: SERVICE, name })) ?? null;
  }
  async set(name: string, value: string) {
    checkName(name);
    await this.api.set({ service: SERVICE, name, value });
  }
  async delete(name: string) {
    checkName(name);
    return this.api.delete({ service: SERVICE, name });
  }
}

class FileStore implements SecretStore {
  readonly backend = "file" as const;
  constructor(private readonly dir: string) {}
  private file(name: string) {
    checkName(name);
    return join(ensurePrivateDir(this.dir), `${name}.secret`);
  }
  async get(name: string) {
    const f = this.file(name);
    if (!existsSync(f)) return null;
    assertPrivateFile(f);
    return readFileSync(f, "utf8");
  }
  async set(name: string, value: string) {
    const f = this.file(name);
    const tmp = `${f}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
    renameSync(tmp, f);
  }
  async delete(name: string) {
    const f = this.file(name);
    const had = existsSync(f);
    rmSync(f, { force: true });
    return had;
  }
}

class SystemdCredsStore implements SecretStore {
  readonly backend = "systemd-creds" as const;
  constructor(
    private readonly dir: string,
    private readonly d: SecretDeps,
  ) {}
  private file(name: string) {
    checkName(name);
    return join(ensurePrivateDir(this.dir), `${name}.cred`);
  }
  async get(name: string) {
    const f = this.file(name);
    if (!existsSync(f)) return null;
    assertPrivateFile(f);
    const r = this.d.run(
      ["systemd-creds", "decrypt", "--user", `--name=sapi-${name}`, f, "-"],
      "",
      credsEnv(this.d.env),
    );
    if (r.code !== 0) throw new Error("systemd-creds couldn't decrypt the stored sign-in");
    return r.stdout;
  }
  async set(name: string, value: string) {
    const f = this.file(name);
    const tmp = `${f}.${crypto.randomUUID()}.tmp`;
    const r = this.d.run(
      ["systemd-creds", "encrypt", "--user", `--name=sapi-${name}`, "-", tmp],
      value,
      credsEnv(this.d.env),
    );
    if (r.code !== 0 || !existsSync(tmp)) {
      rmSync(tmp, { force: true });
      throw new Error("systemd-creds couldn't encrypt the sign-in");
    }
    renameSync(tmp, f);
  }
  async delete(name: string) {
    const f = this.file(name);
    const had = existsSync(f);
    rmSync(f, { force: true });
    return had;
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms).unref?.())]);

/** Can this backend be used here? Checked without reading or writing any real sign-in. */
export async function backendAvailable(b: SecretBackend, d: SecretDeps): Promise<boolean> {
  if (b === "file") return true;
  if (b === "os") {
    if (!d.os) return false;
    if (d.platform === "darwin") return true;
    // Linux: Secret Service needs a session bus and a running keyring. Probe with a name that is
    // never written, and give up quickly rather than hang on a bus with no keyring behind it.
    if (d.platform !== "linux" || !d.env.DBUS_SESSION_BUS_ADDRESS) return false;
    try {
      await withTimeout(d.os.get({ service: SERVICE, name: "probe-never-written" }), 3000);
      return true;
    } catch {
      return false;
    }
  }
  if (d.platform !== "linux") return false;
  const env = credsEnv(d.env);
  const enc = d.run(["systemd-creds", "encrypt", "--user", "--name=sapi-probe", "-", "-"], "probe", env);
  if (enc.code !== 0 || !enc.stdout) return false;
  const dec = d.run(["systemd-creds", "decrypt", "--user", "--name=sapi-probe", "-", "-"], enc.stdout, env);
  return dec.code === 0 && dec.stdout === "probe";
}

function recordFile(paths: Paths): string {
  return join(paths.dataDir, "secrets-backend");
}

export function recordedBackend(paths: Paths): SecretBackend | null {
  const f = recordFile(paths);
  if (!existsSync(f)) return null;
  const v = readFileSync(f, "utf8").trim();
  return v === "os" || v === "systemd-creds" || v === "file" ? v : null;
}

function build(b: SecretBackend, paths: Paths, d: SecretDeps): SecretStore {
  const dir = join(paths.configDir, "secrets");
  if (b === "os") return new OsStore(d.os!);
  if (b === "systemd-creds") return new SystemdCredsStore(dir, d);
  return new FileStore(dir);
}

/** Records the backend the first time something is written, so every later process uses it. */
class Recording implements SecretStore {
  constructor(
    private readonly inner: SecretStore,
    private readonly paths: Paths,
  ) {}
  get backend() {
    return this.inner.backend;
  }
  get(name: string) {
    return this.inner.get(name);
  }
  async set(name: string, value: string) {
    await this.inner.set(name, value);
    if (recordedBackend(this.paths) !== this.inner.backend) {
      ensurePrivateDir(this.paths.dataDir);
      writeFileSync(recordFile(this.paths), `${this.inner.backend}\n`, { mode: 0o600 });
    }
  }
  delete(name: string) {
    return this.inner.delete(name);
  }
}

/**
 * Open the store: the configured backend, else the one recorded at the first sign-in, else the
 * first that works here. Throws a message with the fix when the needed backend can't be reached.
 */
export async function openSecretStore(
  paths: Paths,
  choice: SecretBackendChoice,
  d: SecretDeps = realSecretDeps(),
): Promise<SecretStore> {
  const want = choice !== "auto" ? choice : recordedBackend(paths);
  if (want) {
    if (!(await backendAvailable(want, d))) {
      throw new Error(
        want === "os"
          ? "The OS secret store (Keychain or Secret Service) isn't reachable from here. Sign in again from a desktop session, or set [secrets] backend in config.toml."
          : `The "${want}" secret store isn't available on this machine. Set [secrets] backend in config.toml.`,
      );
    }
    return new Recording(build(want, paths, d), paths);
  }
  for (const b of ["os", "systemd-creds", "file"] as const) {
    if (await backendAvailable(b, d)) return new Recording(build(b, paths, d), paths);
  }
  return new Recording(build("file", paths, d), paths);
}
