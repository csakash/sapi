/**
 * The egress bridge runs inside the Linux sandbox (`sapi __egress-bridge`). The sandbox has no
 * network at all, so the bridge listens on 127.0.0.1 inside the sandbox's own network namespace
 * and forwards each connection to sapi's egress proxy through a bind-mounted Unix socket. Then it
 * runs the provider command and exits with its status.
 *
 * It passes on only the variables in CHILD_ENV_NAMES, never anything else (GW-1).
 */
import { connect, createServer } from "node:net";
import { CHILD_ENV_NAMES } from "../providers/claude-sub/spawn.ts";

export async function runBridge(args: string[]): Promise<number> {
  const sep = args.indexOf("--");
  const opts = args.slice(0, sep < 0 ? args.length : sep);
  const argv = sep < 0 ? [] : args.slice(sep + 1);
  const get = (name: string) => {
    const i = opts.indexOf(name);
    return i >= 0 ? opts[i + 1] : undefined;
  };
  const socketPath = get("--socket");
  const port = Number(get("--port"));
  if (!socketPath || !Number.isInteger(port) || argv.length === 0 || !argv[0]!.startsWith("/")) {
    process.stderr.write("usage: sapi __egress-bridge --socket <path> --port <n> -- </abs/command> [args…]\n");
    return 2;
  }

  const server = createServer((client) => {
    const upstream = connect(socketPath);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res());
  });

  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_NAMES) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  const child = Bun.spawn(argv, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const code = await child.exited;
  server.close();
  return code;
}
