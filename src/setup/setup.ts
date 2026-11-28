/**
 * `sapi setup` (plan §5): guided, or unattended with `--yes`. Safe to run again.
 *
 *   1. check the machine (refuses root)
 *   2. Claude: find the CLI or offer to install the tested version, hand off the sign-in
 *   3. write a config if there is none (never overwrites one)
 *   4. a tiny test call per provider, with time to first token
 *   5. the first client key: shown once, or written to a 0600 env file
 *   6. the background service (launchd or a systemd user unit), then a health check
 *
 * Progress goes to stderr; stdout carries only `--print-env` output, so it can be redirected.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createClient, findClientByName, rotateClientKey, setClientDisabled } from "../auth.ts";
import { type Config, DEFAULT_MODELS, listenAddress, loadConfig, parseConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { openEgress } from "../egress-fetch.ts";
import { ensurePrivateDir, type Paths } from "../paths.ts";
import { planModels } from "../providers/chatgpt-sub/adapter.ts";
import { loginChatGpt } from "../providers/chatgpt-sub/login.ts";
import { chatgptManifest } from "../providers/chatgpt-sub/manifest.ts";
import { parseSession, SESSION_SECRET, sessionState } from "../providers/chatgpt-sub/session.ts";
import { detectLauncher, noLauncher } from "../sandbox/launchers.ts";
import { openSecretStore } from "../secrets.ts";
import { claudeAdapterFor, type Running, startGateway, usesChatGpt, usesClaude } from "../start.ts";
import {
  claudeLogin,
  claudeVersion,
  claudeVersionOk,
  findClaude,
  installClaude,
  TESTED_CLAUDE_VERSION,
} from "./claude.ts";
import { absolutePaths, Service, serviceSpecFor } from "./context.ts";
import { describeMachine, detectMachine, isSapiHealthy, type Machine, portState, waitHealthy } from "./machine.ts";
import type { ServiceDeps } from "./service.ts";

export const SETUP_PROVIDERS = ["claude-sub", "chatgpt-sub", "fake"] as const;
export type SetupProvider = (typeof SETUP_PROVIDERS)[number];
/** Internal client used for the self-test; names starting with "sapi-" are reserved. */
export const SELFTEST_CLIENT = "sapi-selftest";

export type SetupOptions = {
  yes: boolean;
  providers: SetupProvider[];
  claudeAuth?: "cli" | "env";
  /** undefined: ask (default yes). */
  installClaude?: boolean;
  selfTest?: boolean;
  client?: string;
  printEnv: boolean;
  envFile?: string;
  service?: boolean;
  port?: number;
};

export type SetupIo = {
  interactive: boolean;
  info: (line: string) => void;
  out: (line: string) => void;
  confirm: (question: string, def: boolean) => Promise<boolean>;
  text: (question: string, def: string) => Promise<string>;
};

export function terminalIo(yes: boolean): SetupIo {
  const interactive = !yes && Boolean(process.stdin.isTTY);
  const ask = async (q: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    interactive,
    info: (l) => process.stderr.write(`${l}\n`),
    out: (l) => process.stdout.write(`${l}\n`),
    confirm: async (q, def) => {
      if (!interactive) return def;
      const a = (await ask(`${q} [${def ? "Y/n" : "y/N"}] `)).toLowerCase();
      return a === "" ? def : a === "y" || a === "yes";
    },
    text: async (q, def) => {
      if (!interactive) return def;
      return (await ask(`${q} [${def}]: `)) || def;
    },
  };
}

/** Test seams: everything that touches the system outside sapi's own files. */
export type SetupDeps = {
  machine?: Machine;
  serviceDeps?: ServiceDeps;
  findClaude?: (home: string, configured: string) => string | null;
  claudeVersion?: (bin: string, paths: Paths) => string | null;
  claudeSignedIn?: (paths: Paths, cfg: Config) => Promise<boolean>;
  claudeLogin?: (bin: string, paths: Paths) => boolean;
  /** The plan's models when signed in to ChatGPT already, else null. */
  chatgptSignedIn?: (paths: Paths, cfg: Config) => Promise<string[] | null>;
  /** Run the ChatGPT browser sign-in; returns the plan's models. */
  chatgptLogin?: (paths: Paths, cfg: Config, headless: boolean, say: (l: string) => void) => Promise<string[]>;
  installClaude?: (paths: Paths, info: (l: string) => void) => Promise<string>;
};

function tomlString(v: string): string {
  if ([...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    throw new Error("a config value contains a control character");
  return `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** A new config file. Claude-only setups leave [models] to sapi's defaults so they stay current. */
export function configTemplate(o: {
  port: number;
  providers: SetupProvider[];
  claudeBinary: string | null;
  claudeAuth: "cli" | "env";
  /** A model the ChatGPT plan offers, for the `gpt` alias. */
  chatgptModel?: string | null;
}): string {
  const claude = o.providers.includes("claude-sub");
  const chatgpt = o.providers.includes("chatgpt-sub");
  const lines = [
    "# sapi configuration. After editing, restart sapi: sapi stop && sapi start",
    "# sapi listens on loopback only and refuses other addresses.",
    `listen = ${tomlString(`127.0.0.1:${o.port}`)}`,
    "",
  ];
  if (claude) {
    lines.push(
      "[claude]",
      `binary = ${tomlString(o.claudeBinary ?? "claude")}`,
      `# "cli": signed in with sapi login claude. "env": a token in claude.env (advanced).`,
      `auth = ${tomlString(o.claudeAuth)}`,
      "",
    );
  }
  if (o.providers.includes("fake") || chatgpt) {
    lines.push("[models]", "# alias = { provider, model }: clients ask for the alias, sapi sends the pinned ID.");
    if (claude)
      for (const [alias, m] of Object.entries(DEFAULT_MODELS))
        lines.push(`${alias} = { provider = ${tomlString(m.provider)}, model = ${tomlString(m.model)} }`);
    if (chatgpt && o.chatgptModel) {
      lines.push(`gpt = { provider = "chatgpt-sub", model = ${tomlString(o.chatgptModel)} }`);
      if (claude)
        lines.push(
          '# "auto" uses sonnet until its window passes 90%, then gpt. Explicit aliases never fall back.',
          'auto = { route = ["sonnet", "gpt"], switch_at_window_pct = 90 }',
        );
    } else if (chatgpt) {
      lines.push(
        '# gpt = { provider = "chatgpt-sub", model = "<a model your plan offers: sapi login chatgpt lists them>" }',
      );
    }
    if (o.providers.includes("fake"))
      lines.push('echo = { provider = "fake", model = "fake-echo-1" }   # test provider: replies "echo: <message>"');
    lines.push("");
  } else {
    lines.push(
      "# Model aliases default to haiku, sonnet and opus (pinned IDs). To change them:",
      "# [models]",
      '# fast = { provider = "claude-sub", model = "claude-haiku-5-5" }',
      "",
    );
  }
  return lines.join("\n");
}

/** Write atomically with mode 0600; the parent folder must be the user's. */
export function writePrivateFile(file: string, content: string): void {
  const abs = resolve(file);
  const dir = dirname(abs);
  // Create a missing folder privately; never change the mode of a folder that already exists.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${abs}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  renameSync(tmp, abs);
}

type TestResult = { provider: SetupProvider; ok: boolean; detail: string };

/** First alias that sends traffic to this provider (haiku first for Claude: cheapest). */
function aliasFor(cfg: Config, provider: SetupProvider): string | null {
  const direct = Object.entries(cfg.models).filter(([, m]) => "provider" in m && m.provider === provider);
  return (direct.find(([a]) => a === "haiku") ?? direct[0])?.[0] ?? null;
}

async function streamOnce(base: string, key: string, model: string): Promise<{ ttftMs: number }> {
  const t0 = performance.now();
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "Reply with one word: ready" }] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `HTTP ${r.status}`);
  }
  let ttft = -1;
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of r.body!) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const ev = JSON.parse(line.slice(6)) as {
        error?: { message?: string };
        choices?: Array<{ delta?: { content?: string } }>;
      };
      if (ev.error) throw new Error(ev.error.message ?? "error during the stream");
      if (ttft < 0 && ev.choices?.[0]?.delta?.content) ttft = performance.now() - t0;
    }
  }
  if (ttft < 0) throw new Error("the reply was empty");
  return { ttftMs: ttft };
}

/**
 * One tiny call per provider through the real HTTP path. Uses the running gateway if there is
 * one, otherwise starts one in this process on a spare port. The reserved client sapi-selftest
 * gets a fresh key for the test and is disabled again afterwards.
 */
async function selfTest(paths: Paths, cfg: Config, providers: SetupProvider[]): Promise<TestResult[]> {
  const { hostname, port } = listenAddress(cfg);
  let running: Running | null = null;
  let base = `http://${hostname}:${port}`;
  if (!(await isSapiHealthy(hostname, port))) {
    running = await startGateway({ paths, cfg, port: 0 });
    base = running.url;
  }
  const db = running?.db ?? openDb(paths.dbFile);
  const results: TestResult[] = [];
  try {
    let key: string;
    if (findClientByName(db, SELFTEST_CLIENT)) {
      key = rotateClientKey(db, SELFTEST_CLIENT);
      setClientDisabled(db, SELFTEST_CLIENT, false);
    } else {
      key = createClient(db, { name: SELFTEST_CLIENT, budget: { requestsPerDay: 50 } }).key;
    }
    for (const p of providers) {
      const alias = aliasFor(cfg, p);
      if (!alias) {
        results.push({ provider: p, ok: false, detail: "no model alias uses it" });
        continue;
      }
      try {
        const { ttftMs } = await streamOnce(base, key, alias);
        results.push({ provider: p, ok: true, detail: `${(ttftMs / 1000).toFixed(1)} s to first token (${alias})` });
      } catch (e) {
        results.push({ provider: p, ok: false, detail: (e as Error).message.slice(0, 200) });
      }
    }
  } finally {
    if (findClientByName(db, SELFTEST_CLIENT)) setClientDisabled(db, SELFTEST_CLIENT, true);
    if (running) await running.stop();
    else db.close();
  }
  return results;
}

async function claudeSignedIn(paths: Paths, cfg: Config): Promise<boolean> {
  const probe = detectLauncher();
  const adapter = claudeAdapterFor(paths, cfg, {
    launcher: probe.launcher ?? noLauncher,
    egress: { tcpPort: 0, socketPath: "" },
    runDir: paths.runDir,
  });
  const r = await adapter.checkReady(true);
  return r.ready;
}

const PROVIDER_NAME: Record<SetupProvider, string> = {
  "claude-sub": "Claude",
  "chatgpt-sub": "ChatGPT",
  fake: "Test provider",
};

/** The plan's models if sapi is signed in to ChatGPT already (no refresh), else null. */
async function chatgptSignedIn(paths: Paths, cfg: Config): Promise<string[] | null> {
  const store = await openSecretStore(paths, cfg.secrets.backend);
  const st = sessionState(parseSession(await store.get(SESSION_SECRET)));
  if (!st.ok) return null;
  if (st.session.expires_at < Date.now() + 60_000) return [];
  const egress = await openEgress(chatgptManifest.egressHosts);
  try {
    return (await planModels(egress.fetch, st.session.access_token).catch(() => [])).map((m) => m.slug);
  } finally {
    await egress.close();
  }
}

async function chatgptLogin(paths: Paths, cfg: Config, headless: boolean, say: (l: string) => void): Promise<string[]> {
  const store = await openSecretStore(paths, cfg.secrets.backend);
  const egress = await openEgress(chatgptManifest.egressHosts);
  try {
    const r = await loginChatGpt({ paths, fetch: egress.fetch, store, ssh: headless, print: (l) => say(`   ${l}`) });
    return r.models.map((m) => m.slug);
  } finally {
    await egress.close();
  }
}

export async function runSetup(rawPaths: Paths, o: SetupOptions, io: SetupIo, deps: SetupDeps = {}): Promise<number> {
  const paths = absolutePaths(rawPaths);
  const left: string[] = [];
  let failed = false;
  const ok = (l: string) => io.info(` ✓ ${l}`);
  const warn = (l: string) => io.info(` ! ${l}`);
  const bad = (l: string) => io.info(` ✗ ${l}`);

  // 1. The machine.
  io.info("Checking this machine");
  const machine = deps.machine ?? detectMachine();
  if (machine.root) {
    bad("running as root: sapi runs as your normal user. Log in as that user and run sapi setup again.");
    return 1;
  }
  ok(describeMachine(machine));
  let existing: Config | null = null;
  try {
    existing = loadConfig(paths.configFile);
  } catch (e) {
    bad((e as Error).message);
    io.info(`   fix: correct ${paths.configFile}, or move it away and run sapi setup again`);
    return 1;
  }
  const configExists = await Bun.file(paths.configFile).exists();
  const port = o.port ?? listenAddress(existing).port;
  if (configExists && o.port && o.port !== listenAddress(existing).port)
    warn(
      `your config says port ${listenAddress(existing).port}; --port ${o.port} is ignored (edit ${paths.configFile})`,
    );
  const effectivePort = configExists ? listenAddress(existing).port : port;
  const ps = await portState("127.0.0.1", effectivePort);
  if (ps === "busy") {
    bad(`port ${effectivePort} on 127.0.0.1 is taken by another program`);
    io.info("   fix: stop that program, or run sapi setup --port <another port>");
    return 1;
  }
  const managerLine =
    machine.serviceManager === "none"
      ? `no background service here (${machine.serviceProblem ?? "no service manager"})`
      : `${machine.serviceManager === "launchd" ? "launchd" : "systemd user services"} available`;
  ok(`${managerLine} · port ${effectivePort} ${ps === "sapi" ? "already serves sapi" : "free"} · not root`);
  ensurePrivateDir(paths.configDir);
  ensurePrivateDir(paths.dataDir);

  const providers = o.providers;
  const wantsClaude = providers.includes("claude-sub");
  const auth = o.claudeAuth ?? existing.claude.auth;
  let claudeBin: string | null = null;
  let claudeReady = false;

  // 2. Claude.
  if (wantsClaude) {
    io.info("\nClaude");
    const probe = detectLauncher();
    if (probe.launcher) ok(`sandbox: ${probe.launcher.name}`);
    else {
      bad(`no sandbox works here (tried ${probe.tried.map((t) => t.name).join(", ") || "nothing"})`);
      io.info(
        machine.os === "linux"
          ? "   fix: install bubblewrap (sudo apt install bubblewrap); on Ubuntu 24.04 also allow it user namespaces, see docs/vm-setup.md"
          : "   fix: see docs/vm-setup.md",
      );
      left.push("make a sandbox available, then run sapi doctor");
    }
    const find = deps.findClaude ?? findClaude;
    claudeBin = find(paths.home, existing.claude.binary);
    if (!claudeBin) {
      warn("the claude CLI isn't installed");
      const yes =
        o.installClaude ??
        (await io.confirm(`Install claude ${TESTED_CLAUDE_VERSION} with Anthropic's official installer?`, true));
      if (yes) {
        try {
          claudeBin = await (deps.installClaude ?? installClaude)(paths, io.info);
          ok(`claude installed at ${claudeBin}`);
        } catch (e) {
          bad((e as Error).message);
          failed = true;
        }
      } else left.push(`install claude ${TESTED_CLAUDE_VERSION}: https://claude.com/download, then run sapi setup`);
    }
    if (claudeBin) {
      const version = (deps.claudeVersion ?? claudeVersion)(claudeBin, paths);
      if (claudeVersionOk(version, existing.claude.version_range)) ok(`claude ${version} at ${claudeBin}`);
      else {
        bad(`claude ${version ?? "(unknown version)"} is outside the tested range ${existing.claude.version_range}`);
        io.info(`   fix: claude install ${TESTED_CLAUDE_VERSION}`);
        left.push(`install a tested claude version: claude install ${TESTED_CLAUDE_VERSION}`);
      }
    }
  }

  // ChatGPT sign-in comes before the config, which needs one of the plan's models.
  const wantsChatGpt = providers.includes("chatgpt-sub");
  let chatgptReady = false;
  let chatgptModels: string[] = [];
  if (wantsChatGpt) {
    io.info("\nChatGPT");
    try {
      const already = await (deps.chatgptSignedIn ?? chatgptSignedIn)(paths, existing);
      if (already) {
        chatgptReady = true;
        chatgptModels = already;
        ok("signed in (Sign in with ChatGPT)");
      } else if (io.interactive) {
        io.info(
          machine.headless
            ? " → sapi prints an ssh tunnel command and a link: run the command on your laptop, then open the link there."
            : " → Your browser opens OpenAI's sign-in page; approve there.",
        );
        chatgptModels = await (deps.chatgptLogin ?? chatgptLogin)(paths, existing, machine.headless, io.info);
        chatgptReady = true;
        ok("signed in (Sign in with ChatGPT)");
      } else {
        warn("not signed in yet (that needs you at a browser)");
        left.push("sign in: sapi login chatgpt");
      }
    } catch (e) {
      bad((e as Error).message);
      left.push("sign in: sapi login chatgpt");
    }
    if (chatgptModels.length) ok(`your plan offers: ${chatgptModels.join(", ")}`);
    io.info(
      " ! sapi can't see ChatGPT's \"Improve the model for everyone\" setting. Check it once in ChatGPT's data controls.",
    );
  }

  // 3. Config (written once; never overwritten).
  io.info("\nConfig");
  if (configExists) ok(`kept your config: ${paths.configFile}`);
  else {
    const text = configTemplate({
      port: effectivePort,
      providers,
      claudeBinary: claudeBin,
      claudeAuth: auth,
      chatgptModel: chatgptModels[0] ?? null,
    });
    parseConfig(Bun.TOML.parse(text)); // never write a config sapi itself would reject
    writePrivateFile(paths.configFile, text);
    ok(`wrote ${paths.configFile}`);
  }
  const cfg = loadConfig(paths.configFile);
  if (wantsClaude && !usesClaude(cfg)) warn("your config has no model alias for Claude, so Claude won't be used");
  if (wantsChatGpt && !usesChatGpt(cfg)) {
    warn("your config has no model alias for ChatGPT, so ChatGPT won't be used");
    left.push(
      `add a ChatGPT alias under [models] in ${paths.configFile}, e.g. gpt = { provider = "chatgpt-sub", model = "${chatgptModels[0] ?? "<model>"}" }`,
    );
  }

  // Claude sign-in, now that the config names the binary.
  if (wantsClaude && claudeBin) {
    const signedIn = deps.claudeSignedIn ?? claudeSignedIn;
    if (auth === "env") {
      claudeReady = await signedIn(paths, cfg);
      if (claudeReady) ok("token found in claude.env (passed only to the claude process)");
      else left.push(`put CLAUDE_CODE_OAUTH_TOKEN=… in ${paths.claudeEnvFile} (chmod 600)`);
    } else if (await signedIn(paths, cfg)) {
      claudeReady = true;
      ok("signed in (sapi's own Claude profile)");
    } else if (io.interactive) {
      io.info(" → Signing in a separate Claude profile for sapi. Your own claude setup is untouched.");
      io.info(
        machine.headless
          ? "   claude shows a link: open it on your laptop or phone, approve, and paste the code back here."
          : "   claude opens your browser; approve there.",
      );
      claudeReady = (deps.claudeLogin ?? claudeLogin)(claudeBin, paths) && (await signedIn(paths, cfg));
      if (claudeReady) ok("signed in (sapi's own Claude profile)");
      else {
        bad("the sign-in didn't complete");
        left.push("sign in: sapi login claude");
      }
    } else {
      warn("not signed in yet (that needs you at a terminal)");
      left.push("sign in: sapi login claude");
    }
    io.info(" ! sapi can't see Claude's model-training setting. Check it once in Claude's privacy settings.");
  }

  // 4. Test calls.
  const testable = providers.filter(
    (p) => (p !== "claude-sub" || claudeReady) && (p !== "chatgpt-sub" || (chatgptReady && usesChatGpt(cfg))),
  );
  if (testable.length) {
    const run =
      o.selfTest ?? (await io.confirm(`\nTest call${testable.length > 1 ? "s" : ""} (uses a few tokens)?`, true));
    if (run) {
      io.info("\nTest calls");
      for (const r of await selfTest(paths, cfg, testable)) {
        if (r.ok) ok(`${PROVIDER_NAME[r.provider]}: ${r.detail}`);
        else {
          bad(`${PROVIDER_NAME[r.provider]}: ${r.detail}`);
          failed = true;
        }
      }
    }
  }

  // 5. The first client key.
  io.info("\nClient key");
  const { hostname, port: listenPort } = listenAddress(cfg);
  const base = `http://${hostname}:${listenPort}/v1`;
  const name = o.client ?? (await io.text("Name for your first client", "my-app"));
  let newKey: string | null = null;
  const db = openDb(paths.dbFile);
  try {
    if (name.startsWith("sapi-")) {
      bad('client names starting with "sapi-" are reserved');
      failed = true;
    } else if (findClientByName(db, name)) {
      ok(`"${name}" already exists; its key isn't shown again (new key: sapi connect ${name} --new-key)`);
    } else {
      newKey = createClient(db, { name }).key;
      ok(`created "${name}"`);
    }
  } catch (e) {
    bad((e as Error).message);
    failed = true;
  } finally {
    db.close();
  }
  if (newKey) {
    const env = `OPENAI_BASE_URL=${base}\nOPENAI_API_KEY=${newKey}\n`;
    if (o.envFile) {
      writePrivateFile(o.envFile, env);
      ok(`key written to ${resolve(o.envFile)} (mode 600)`);
    }
    if (o.printEnv) io.out(env.trimEnd());
  } else if (o.envFile) io.info(`   ${o.envFile} left as it was`);

  // 6. Background service.
  let serving = ps === "sapi";
  const spec = serviceSpecFor(paths, cfg, machine);
  if (!spec) {
    io.info(`\nBackground service: not available (${machine.serviceProblem ?? "no service manager"})`);
    io.info("   run it in the foreground with: sapi start --foreground");
  } else {
    const want =
      o.service ??
      (await io.confirm(
        `\nRun sapi in the background and start it at ${machine.os === "macos" ? "login" : "boot"}?`,
        true,
      ));
    if (want) {
      io.info("\nBackground service");
      const svc = new Service(spec, deps.serviceDeps);
      const r = svc.install();
      for (const d of r.done) ok(d);
      for (const w of r.warnings) warn(w);
      if (!r.ok) {
        bad(r.error ?? "the service couldn't be installed");
        failed = true;
      } else if (await waitHealthy(hostname, listenPort, 20_000)) {
        serving = true;
        ok(`answering on ${hostname}:${listenPort}`);
      } else {
        bad(`installed, but nothing answers on ${hostname}:${listenPort} yet`);
        io.info(
          `   fix: sapi doctor${machine.serviceManager === "systemd" ? "; logs: journalctl --user -u sapi -n 50" : `; logs: ${svc.file.logFile}`}`,
        );
        failed = true;
      }
    } else io.info("   skipped; start sapi yourself with: sapi start --foreground");
  }

  // Summary.
  io.info("");
  io.info(serving ? `Done. sapi is listening on ${hostname}:${listenPort}` : "Done.");
  // The key is shown on the terminal only when it went nowhere else, so it never lands in CI logs.
  const shown = newKey && !o.envFile && !o.printEnv;
  const keyText = shown
    ? `${newKey}    # shown once: copy it now`
    : newKey && o.envFile
      ? `…    # in ${resolve(o.envFile)}`
      : "sk-sapi-…    # this client's key";
  io.info(`Use it:\n  export OPENAI_BASE_URL=${base}\n  export OPENAI_API_KEY=${keyText}`);
  io.info(`More setups (Python, Node, LangChain, curl): sapi connect ${name}`);
  if (machine.ssh)
    io.info(
      `From your laptop: ssh -N -L ${listenPort}:127.0.0.1:${listenPort} ${process.env.USER ?? "you"}@<this machine>`,
    );
  io.info("Health: sapi doctor");
  if (left.length) {
    io.info("\nLeft for you:");
    for (const l of left) io.info(`  - ${l}`);
  }
  return failed ? 1 : 0;
}
