/**
 * A stand-in for the `claude` CLI used by the security tests. Started through the shell wrapper
 * written by test/helpers.ts as:  fake-claude.ts <mode> <claude argv…>
 *
 * Modes:
 *   env            reply with this process's environment, argv, cwd and uid as JSON text
 *   fixture:<name> replay test/fixtures/claude-cli/<name>.jsonl
 *   slow           stream 200 deltas, 50 ms apart, until killed
 *   tools          report a tool in the init event (the adapter must stop)
 *   probe          try to escape the sandbox; reply with what was blocked (paths come on stdin)
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const [mode = "env", ...argv] = process.argv.slice(2);
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (argv[0] === "--version") {
  console.log("2.1.332 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth") process.exit(0);

const stdin = await new Response(Bun.stdin.stream()).text();

const init = (tools: string[] = []) =>
  out({ type: "system", subtype: "init", tools, mcp_servers: [], model: argv[argv.indexOf("--model") + 1] ?? "unknown" });
const delta = (text: string) =>
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const result = () =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    stop_reason: "end_turn",
    duration_ms: 10,
    duration_api_ms: 5,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

async function blocked(fn: () => unknown | Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

function tcp(host: string, port: number): Promise<void> {
  return new Promise((res, rej) => {
    const s = connect(port, host);
    const t = setTimeout(() => {
      s.destroy();
      rej(new Error("timeout"));
    }, 2000);
    s.once("connect", () => {
      clearTimeout(t);
      s.destroy();
      res();
    });
    s.once("error", (e) => {
      clearTimeout(t);
      rej(e);
    });
  });
}

/** Ask the egress proxy for a tunnel; resolves with the status line's code. */
function viaProxy(target: string): Promise<number> {
  const u = new URL(process.env.HTTPS_PROXY ?? "http://127.0.0.1:1");
  return new Promise((res, rej) => {
    const s = connect(Number(u.port), u.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) {
        s.destroy();
        res(Number(m[1]));
      }
    });
    s.on("error", rej);
    setTimeout(() => rej(new Error("timeout")), 3000);
  });
}

switch (true) {
  case mode === "env": {
    init();
    delta(JSON.stringify({ env: process.env, argv, cwd: process.cwd(), stdin }));
    result();
    break;
  }
  case mode.startsWith("fixture:"): {
    const file = join(import.meta.dir, "claude-cli", `${mode.slice(8)}.jsonl`);
    process.stdout.write(readFileSync(file, "utf8"));
    break;
  }
  case mode === "slow": {
    init();
    for (let i = 0; i < 200; i++) {
      delta(`${i} `);
      await Bun.sleep(50);
    }
    result();
    break;
  }
  case mode === "tools": {
    init(["Bash"]);
    delta("should never be seen");
    result();
    break;
  }
  case mode === "probe": {
    const p = JSON.parse(stdin) as {
      sshFile: string;
      dataFile: string;
      configFile: string;
      outsideFile: string;
      keychainDir: string;
      libraryFile: string;
      persistenceFile: string;
    };
    const homeKeychains = join(process.env.HOME ?? "/nonexistent", "Library", "Keychains");
    const report = {
      uidIsRoot: process.getuid?.() === 0,
      readSshBlocked: await blocked(() => readFileSync(p.sshFile)),
      readSapiDataBlocked: await blocked(() => readFileSync(p.dataFile)),
      readSapiConfigBlocked: await blocked(() => readFileSync(p.configFile)),
      writeOutsideBlocked: await blocked(() => writeFileSync(p.outsideFile, "x")),
      writeWorkDirAllowed: !(await blocked(() => writeFileSync(join(process.cwd(), "ok.txt"), "x"))),
      writeProfileAllowed: !(await blocked(() => writeFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? "/nonexistent", "probe.txt"), "x"))),
      keychainLinked: await blocked(() => {
        if (realpathSync(homeKeychains) !== realpathSync(p.keychainDir)) throw new Error("other target");
      }).then((b) => !b),
      writeKeychainAllowed: !(await blocked(() => writeFileSync(join(homeKeychains, "probe.txt"), "x"))),
      writeOtherLibraryBlocked: await blocked(() => writeFileSync(p.libraryFile, "x")),
      writePersistenceBlocked: await blocked(() => writeFileSync(p.persistenceFile, "x")),
      directInternetBlocked: await blocked(() => tcp("1.1.1.1", 443)),
      directMetadataBlocked: await blocked(() => tcp("169.254.169.254", 80)),
      proxyExampleCom: await viaProxy("example.com:443").catch(() => -1),
      proxyMetadataIp: await viaProxy("169.254.169.254:443").catch(() => -1),
      envNames: Object.keys(process.env).sort(),
    };
    init();
    delta(JSON.stringify(report));
    result();
    break;
  }
  default:
    process.exit(3);
}
