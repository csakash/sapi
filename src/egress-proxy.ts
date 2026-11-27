/**
 * The egress proxy (ARI-42 INJ-4): every outbound connection from a provider child goes through
 * here, and only to the hosts in that provider's manifest.
 *
 * - HTTP CONNECT only, port 443 only, hostnames only (IP literals are refused).
 * - The host must be on the allowlist exactly (no wildcards).
 * - Every DNS answer is checked; if any resolved address is private, loopback, link-local
 *   (cloud metadata), shared or reserved, the request is refused. The tunnel then connects to the
 *   address that was checked, so a second DNS answer can't swap it (rebinding).
 * - Listens on 127.0.0.1 (macOS sandbox) and/or a Unix socket (bind-mounted into the Linux sandbox).
 */
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { isBlockedAddress, normaliseHost } from "./ssrf.ts";

export type EgressDecision =
  | { allow: true; host: string; port: number; address: string }
  | { allow: false; host: string; port: number; reason: EgressBlockReason };

export type EgressBlockReason =
  | "bad_request"
  | "port"
  | "ip_literal_or_bad_host"
  | "not_on_allowlist"
  | "dns_failed"
  | "private_address";

export type EgressEvent = {
  kind: "egress_allowed" | "egress_blocked";
  host: string;
  port: number;
  reason?: EgressBlockReason;
};

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const MAX_HEADER_BYTES = 8192;
const HEADER_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

export type EgressProxyOptions = {
  allow: string[];
  onEvent?: (e: EgressEvent) => void;
  resolve?: Resolver;
  /** Test hook: where to actually connect once a destination is approved. */
  connectTo?: (port: number, address: string) => Socket;
};

export class EgressProxy {
  private readonly allow: Set<string>;
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly resolve: Resolver;
  private socketPath?: string;

  constructor(private readonly opts: EgressProxyOptions) {
    this.allow = new Set(opts.allow.map((h) => normaliseHost(h)).filter((h): h is string => h !== null));
    if (this.allow.size !== opts.allow.length) throw new Error("egress allowlist entries must be plain hostnames");
    this.resolve = opts.resolve ?? defaultResolver;
  }

  get allowlist(): string[] {
    return [...this.allow].sort();
  }

  /** Decide whether a CONNECT target may be reached. Exposed for tests. */
  async decide(target: string): Promise<EgressDecision> {
    const m = /^([^:\s]+):(\d{1,5})$/.exec(target);
    if (!m) return { allow: false, host: target.slice(0, 64), port: 0, reason: "bad_request" };
    const port = Number(m[2]);
    const host = normaliseHost(m[1]!);
    if (port !== 443) return { allow: false, host: host ?? m[1]!.slice(0, 64), port, reason: "port" };
    if (!host) return { allow: false, host: m[1]!.slice(0, 64), port, reason: "ip_literal_or_bad_host" };
    if (!this.allow.has(host)) return { allow: false, host, port, reason: "not_on_allowlist" };
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch {
      return { allow: false, host, port, reason: "dns_failed" };
    }
    if (addresses.length === 0) return { allow: false, host, port, reason: "dns_failed" };
    if (addresses.some(isBlockedAddress)) return { allow: false, host, port, reason: "private_address" };
    return { allow: true, host, port, address: addresses[0]! };
  }

  async listenTcp(): Promise<number> {
    const server = this.makeServer();
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("egress proxy failed to bind");
    return addr.port;
  }

  async listenUnix(path: string): Promise<void> {
    if (existsSync(path)) unlinkSync(path);
    const server = this.makeServer();
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(path, () => res());
    });
    chmodSync(path, 0o600);
    this.socketPath = path;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await Promise.all(this.servers.map((s) => new Promise<void>((res) => s.close(() => res()))));
    if (this.socketPath && existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }

  private makeServer(): Server {
    const server = createServer((socket) => this.handle(socket));
    this.servers.push(server);
    return server;
  }

  private handle(client: Socket): void {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(HEADER_TIMEOUT_MS, () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_HEADER_BYTES) client.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
        return;
      }
      client.off("data", onData);
      client.pause();
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      void this.tunnel(client, head, rest);
    };
    client.on("data", onData);
  }

  private async tunnel(client: Socket, head: string, rest: Buffer): Promise<void> {
    const [line = ""] = head.split("\r\n");
    const m = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(line);
    if (!m) {
      this.emit({ kind: "egress_blocked", host: "", port: 0, reason: "bad_request" });
      client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
      return;
    }
    const d = await this.decide(m[1]!);
    if (!d.allow) {
      this.emit({ kind: "egress_blocked", host: d.host, port: d.port, reason: d.reason });
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = this.opts.connectTo ? this.opts.connectTo(d.port, d.address) : connect(d.port, d.address);
    this.sockets.add(upstream);
    upstream.on("close", () => this.sockets.delete(upstream));
    upstream.once("connect", () => {
      this.emit({ kind: "egress_allowed", host: d.host, port: d.port });
      client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
      upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
      client.resume();
    });
    upstream.on("error", () => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  private emit(e: EgressEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch {
      // Event recording must never break the proxy.
    }
  }
}
