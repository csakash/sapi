/**
 * Claude subscription adapter (plan §9). Runs the unmodified `claude -p` as the user, for the
 * user only, inside a launcher that confines it (OUT-4), with an explicit minimal environment
 * (GW-1), an empty per-request work dir, argv built only from config (OUT-1), and egress only
 * through the proxy (INJ-4). sapi never reads the CLI's login; it only checks the exit code of
 * `claude auth status`.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { CanonicalEvent, CanonicalRequest, LimitWindow } from "../../canonical.ts";
import { GatewayError } from "../../canonical.ts";
import { versionInRange } from "../../config.ts";
import { assertPrivateFile, ensurePrivateDir } from "../../paths.ts";
import { renderPrompt } from "../../prompts/transcript-v1.ts";
import { log } from "../../redact.ts";
import { type Launcher, resolved } from "../../sandbox/launchers.ts";
import type { ProviderAdapter, Readiness } from "../types.ts";
import { claudeManifest } from "./manifest.ts";
import { claudeArgv, claudeChildEnv } from "./spawn.ts";
import { ClaudeStreamParser, NotSignedInError } from "./stream.ts";

export type ClaudeAdapterOptions = {
  binary: string;
  versionRange: string;
  auth: "cli" | "env";
  /** The noLauncher only when confinement is "best-effort" and nothing stronger works. */
  launcher: Launcher;
  /** Set when confinement is required but no launcher works: the provider then reports not ready. */
  launcherProblem?: string;
  profileDir: string;
  runDir: string;
  claudeEnvFile: string;
  hostHome: string;
  hiddenPaths: string[];
  egress: { tcpPort: number; socketPath: string };
  bridgeCommand: string[];
  /** Paths the bridge needs inside the Linux sandbox (the sapi binary, or bun plus the source tree). */
  bridgeReadOnlyPaths: string[];
  memoryMaxMb: number;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
  onEvent?: (kind: string, detail: Record<string, unknown>) => void;
};

const READY_TTL_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const STDERR_KEEP = 2048;

export class ClaudeAdapter implements ProviderAdapter {
  readonly manifest = claudeManifest;
  private ready: { at: number; value: Readiness } | null = null;
  private readonly windows = new Map<string, LimitWindow>();
  private exhaustedUntil = 0;
  private binaryPath: string | null = null;

  constructor(private readonly o: ClaudeAdapterOptions) {}

  limits(): LimitWindow[] {
    return [...this.windows.values()];
  }

  assertWindowOpen(now = Date.now()): void {
    if (this.exhaustedUntil > now) {
      throw new GatewayError("provider_window_exhausted", "The Claude subscription's usage limit is reached.", {
        retryAfterSec: (this.exhaustedUntil - now) / 1000,
      });
    }
  }

  async checkReady(force = false): Promise<Readiness> {
    if (!force && this.ready && Date.now() - this.ready.at < READY_TTL_MS) return this.ready.value;
    const value = await this.computeReady();
    this.ready = { at: Date.now(), value };
    return value;
  }

  private resolveBinary(): string | null {
    const found = this.o.binary.startsWith("/") ? this.o.binary : Bun.which(this.o.binary);
    if (!found) return null;
    try {
      return realpathSync(found);
    } catch {
      return null;
    }
  }

  private baseEnv(workHome: string): Record<string, string> {
    const env = claudeChildEnv({
      binaryDir: dirname(this.binaryPath!),
      home: workHome,
      user: userInfo().username,
      profileDir: this.o.profileDir,
      ...(this.o.auth === "env" ? { oauthToken: this.readOauthToken() } : {}),
    });
    return env;
  }

  /** auth = "env": read the token only to hand it to the child. Never logged or stored. */
  private readOauthToken(): string {
    try {
      assertPrivateFile(this.o.claudeEnvFile);
      const text = readFileSync(this.o.claudeEnvFile, "utf8");
      const m = /^\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*"?([A-Za-z0-9_.-]+)"?\s*$/m.exec(text);
      if (!m) throw new Error("missing");
      return m[1]!;
    } catch {
      throw new GatewayError(
        "provider_not_ready",
        `auth = "env" needs CLAUDE_CODE_OAUTH_TOKEN in ${this.o.claudeEnvFile} (mode 600).`,
      );
    }
  }

  private async computeReady(): Promise<Readiness> {
    if (this.o.launcherProblem) return { ready: false, reason: this.o.launcherProblem, fix: "sapi status" };
    this.binaryPath = this.resolveBinary();
    if (!this.binaryPath) {
      return {
        ready: false,
        reason: "The claude CLI wasn't found.",
        fix: "Install it from https://claude.com/download, then run: sapi login claude",
      };
    }
    const work = this.newWorkDir();
    try {
      const v = Bun.spawnSync([this.binaryPath, "--version"], {
        env: claudeChildEnv({
          binaryDir: dirname(this.binaryPath),
          home: work,
          user: userInfo().username,
          profileDir: this.o.profileDir,
        }),
        cwd: work,
        stdout: "pipe",
        stderr: "ignore",
        timeout: 15_000,
      });
      const version = /(\d+\.\d+\.\d+)/.exec(v.stdout.toString())?.[1];
      if (!version)
        return { ready: false, reason: "Couldn't read the claude CLI version.", fix: "Run: claude --version" };
      if (!versionInRange(version, this.o.versionRange)) {
        return {
          ready: false,
          reason: `claude ${version} is outside the tested range ${this.o.versionRange}.`,
          fix: "Install a tested version with: claude install <version>",
        };
      }
      if (this.o.auth === "cli") {
        // Exit code only: the status output includes the account email, which sapi never reads.
        const s = Bun.spawnSync([this.binaryPath, "auth", "status"], {
          env: this.baseEnv(this.makeHome(work)),
          cwd: work,
          stdout: "ignore",
          stderr: "ignore",
          timeout: 15_000,
        });
        if (s.exitCode !== 0)
          return { ready: false, reason: "Claude isn't signed in for sapi.", fix: "sapi login claude" };
      } else {
        this.readOauthToken();
      }
      return { ready: true, detail: `claude ${version} · ${this.o.launcher.name}` };
    } catch (e) {
      if (e instanceof GatewayError) return { ready: false, reason: e.message, fix: "sapi login claude" };
      return { ready: false, reason: "The claude CLI couldn't be started.", fix: "Run: claude --version" };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** macOS keeps the CLI's sign-in in the login keychain (auth = "cli"). */
  private usesKeychain(): boolean {
    return process.platform === "darwin" && this.o.auth === "cli";
  }

  /**
   * The child's HOME: a fresh, empty folder inside the work dir, so the CLI never sees the user's
   * dotfiles. On macOS with CLI sign-in it holds one link, Library/Keychains, to the user's
   * keychain folder: the Security framework finds the login keychain through HOME, and without the
   * link `claude` reports "not logged in" (checked on 2.1.332). sapi never reads the keychain.
   */
  private makeHome(work: string): string {
    const home = join(work, "home");
    mkdirSync(home, { mode: 0o700 });
    if (this.usesKeychain()) {
      mkdirSync(join(home, "Library"), { mode: 0o700 });
      symlinkSync(join(resolved(this.o.hostHome), "Library", "Keychains"), join(home, "Library", "Keychains"));
    }
    return home;
  }

  private newWorkDir(): string {
    const run = ensurePrivateDir(this.o.runDir);
    return realpathSync(mkdtempSync(join(run, "req-")));
  }

  async *send(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    const ready = await this.checkReady();
    if (!ready.ready) throw new GatewayError("provider_not_ready", `${ready.reason} Fix: ${ready.fix}`);
    this.assertWindowOpen();
    let attempt = 0;
    while (true) {
      try {
        yield* this.runOnce(req, signal);
        return;
      } catch (e) {
        // A spurious "Not logged in" was seen once in ~25 runs (Phase 0). Retry once if the
        // profile really is signed in; it always fails before any text is produced.
        if (e instanceof NotSignedInError && attempt === 0 && !signal.aborted) {
          attempt++;
          const again = await this.checkReady(true);
          if (again.ready) continue;
        }
        throw e;
      }
    }
  }

  private async *runOnce(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    const work = this.newWorkDir();
    const systemFile = join(work, "system.txt");
    writeFileSync(systemFile, req.system ?? "", { mode: 0o600 });
    const home = this.makeHome(work);
    const inner = claudeArgv({ binary: this.binaryPath!, modelId: req.model, systemPromptFile: systemFile });
    const launched = this.o.launcher.wrap({
      argv: inner,
      env: this.baseEnv(home),
      workDir: work,
      profileDir: ensurePrivateDir(this.o.profileDir),
      readOnlyPaths: [this.binaryInstallDir(), ...this.o.bridgeReadOnlyPaths.map(resolved)],
      hiddenPaths: this.o.hiddenPaths,
      hostHome: resolved(this.o.hostHome),
      ...(this.usesKeychain() ? { keychainDir: join(resolved(this.o.hostHome), "Library", "Keychains") } : {}),
      egress: this.o.egress,
      bridgeCommand: this.o.bridgeCommand,
      memoryMaxMb: this.o.memoryMaxMb,
      timeoutSec: Math.ceil(this.o.totalTimeoutMs / 1000),
    });

    const prompt = renderPrompt(req.messages);
    const child = Bun.spawn(launched.argv, {
      cwd: launched.cwd,
      env: launched.env,
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });
    let killed = false;
    const kill = () => {
      if (killed || child.exitCode !== null) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    };
    const onAbort = () => kill();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) kill();

    // Drain stderr so the child never blocks; keep only a short tail for classification.
    let stderrTail = "";
    const stderrDone = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of child.stderr)
        stderrTail = (stderrTail + dec.decode(chunk, { stream: true })).slice(-STDERR_KEEP);
    })().catch(() => {});

    const parser = new ClaudeStreamParser({ allowStructuredOutput: false });
    try {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of child.stdout) {
        buf += dec.decode(chunk, { stream: true });
        if (buf.length > 4 * 1024 * 1024)
          throw new GatewayError("upstream_error", "The claude process sent an oversized line.");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          for (const ev of this.observe(parser.feed(line), parser)) yield ev;
          nl = buf.indexOf("\n");
        }
      }
      if (buf.trim()) for (const ev of this.observe(parser.feed(buf), parser)) yield ev;
      const code = await child.exited;
      await stderrDone;
      if (signal.aborted) throw signal.reason;
      if (!parser.done && /not logged in/i.test(stderrTail)) throw new NotSignedInError();
      parser.end(code);
    } catch (e) {
      if (parser.exhaustedUntil) this.exhaustedUntil = Math.max(this.exhaustedUntil, parser.exhaustedUntil);
      if (e instanceof GatewayError && e.kind === "upstream_error" && /tools or MCP/.test(e.message)) {
        this.o.onEvent?.("child_unsafe_init", { provider: "claude-sub" });
      }
      throw signal.aborted ? signal.reason : e;
    } finally {
      signal.removeEventListener("abort", onAbort);
      kill();
      if (parser.stats.dropped > 0)
        log("info", "claude stream lines dropped", { dropped: parser.stats.dropped, lines: parser.stats.lines });
      rmSync(work, { recursive: true, force: true });
    }
  }

  private observe(events: CanonicalEvent[], parser: ClaudeStreamParser): CanonicalEvent[] {
    for (const ev of events) if (ev.type === "limit") this.windows.set(ev.limit.window, ev.limit);
    if (parser.exhaustedUntil) this.exhaustedUntil = Math.max(this.exhaustedUntil, parser.exhaustedUntil);
    return events;
  }

  /** The directory holding the real claude binary (bound read-only into the Linux sandbox). */
  private binaryInstallDir(): string {
    return dirname(this.binaryPath!);
  }
}
