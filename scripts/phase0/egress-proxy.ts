#!/usr/bin/env bun
/**
 * Phase 0 egress probe: a tiny HTTP CONNECT proxy on 127.0.0.1 that logs every host a child
 * process tries to reach.
 *
 *   report mode (default): allow everything, log it. Used to learn the host list.
 *   enforce mode:          allow only --allow hosts, refuse the rest, and refuse any host that
 *                          resolves to a private, loopback, link-local or metadata address.
 *
 *   bun scripts/phase0/egress-proxy.ts --port 18080
 *   bun scripts/phase0/egress-proxy.ts --port 18080 --allow api.anthropic.com,platform.claude.com
 *
 * This is a probe, not the production proxy (that one lands in Phase 1 as src/egress-proxy.ts).
 */
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { connect, isIP } from "node:net";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: { port: { type: "string", default: "18080" }, allow: { type: "string" } },
});
const allow = opt.allow ? new Set(opt.allow.split(",").map((h) => h.trim().toLowerCase())) : null;

function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::1" ||
    v6 === "::" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80") ||
    v6.startsWith("::ffff:127.") ||
    v6.startsWith("::ffff:10.") ||
    v6.startsWith("::ffff:169.254.")
  );
}

const log = (o: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

const server = createServer((req, res) => {
  // Plain-HTTP proxying is refused: providers are HTTPS only.
  log({ event: "refused_plain_http", url: req.url });
  res.writeHead(403).end("plain HTTP is not allowed\n");
});

server.on("connect", async (req, clientSocket, head) => {
  const [hostRaw, portRaw] = (req.url ?? "").split(":");
  const host = (hostRaw ?? "").toLowerCase();
  const port = Number(portRaw || 443);
  const deny = (reason: string) => {
    log({ event: "blocked", host, port, reason });
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  };
  if (port !== 443) return deny("port");
  if (allow && !allow.has(host)) return deny("not_on_allowlist");
  let address: string;
  try {
    address = isIP(host) ? host : (await lookup(host)).address;
  } catch {
    return deny("dns_failed");
  }
  if (isBlockedAddress(address)) return deny("private_address");
  // Connect to the address we just checked, so a second DNS answer can't swap it (rebinding).
  const upstream = connect(port, address, () => {
    log({ event: "allowed", host, port, address });
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(Number(opt.port), "127.0.0.1", () =>
  log({
    event: "listening",
    port: Number(opt.port),
    mode: allow ? "enforce" : "report",
    allow: allow ? [...allow] : null,
  }),
);
