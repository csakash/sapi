/**
 * ARI-42 INJ-4: the egress proxy allows only allowlisted hostnames on 443, refuses IP literals
 * and any hostname that resolves to a private, loopback, link-local (metadata) or reserved
 * address, and tunnels to the exact address it checked.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { EgressProxy } from "../../src/egress-proxy.ts";
import { claudeManifest } from "../../src/providers/claude-sub/manifest.ts";
import { isBlockedAddress } from "../../src/ssrf.ts";

const dns: Record<string, string[]> = {
  "api.anthropic.com": ["160.79.104.10"],
  "claude.ai": ["160.79.104.11"],
  "platform.claude.com": ["169.254.169.254"], // a poisoned answer
  "claude.com": ["160.79.104.12", "10.0.0.5"], // one bad address among good ones
};
const resolve = async (h: string) => {
  const a = dns[h];
  if (!a) throw new Error("NXDOMAIN");
  return a;
};

describe("decisions", () => {
  const proxy = new EgressProxy({ allow: claudeManifest.egressHosts, resolve });

  test("an allowlisted host with a public address is allowed", async () => {
    expect(await proxy.decide("api.anthropic.com:443")).toEqual({
      allow: true,
      host: "api.anthropic.com",
      port: 443,
      address: "160.79.104.10",
    });
  });

  test.each([
    ["example.com:443", "not_on_allowlist"],
    ["evil.api.anthropic.com:443", "not_on_allowlist"],
    ["api.anthropic.com.evil.example:443", "not_on_allowlist"],
    ["169.254.169.254:443", "ip_literal_or_bad_host"],
    ["127.0.0.1:443", "ip_literal_or_bad_host"],
    ["[::1]:443", "bad_request"],
    ["api.anthropic.com:80", "port"],
    ["api.anthropic.com:22", "port"],
    ["platform.claude.com:443", "private_address"],
    ["claude.com:443", "private_address"],
    ["no-port", "bad_request"],
  ])("%s is refused (%s)", async (target, reason) => {
    const d = await proxy.decide(target);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(reason as never);
  });

  test("hostnames match case-insensitively and with a trailing dot", async () => {
    expect((await proxy.decide("API.Anthropic.COM.:443")).allow).toBe(true);
  });

  test("allowlist entries must be plain hostnames", () => {
    expect(() => new EgressProxy({ allow: ["*.anthropic.com"] })).toThrow();
    expect(() => new EgressProxy({ allow: ["10.0.0.1"] })).toThrow();
  });
});

describe("addresses", () => {
  test.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2001:db8::1",
    "2002:0a00:0001::1",
    "fd00:ec2::254",
    "not-an-ip",
  ])("%s is blocked", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  test.each(["160.79.104.10", "8.8.8.8", "172.32.0.1", "2607:6bc0::10", "::ffff:8.8.8.8"])("%s is allowed", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("tunnelling", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });

  async function connectThrough(proxyPort: number, target: string): Promise<{ status: number; socket: Socket }> {
    return new Promise((res, rej) => {
      const s = connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      s.once("data", (d) => res({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(d.toString())?.[1]), socket: s }));
      s.once("error", rej);
    });
  }

  test("an allowed CONNECT is tunnelled to the checked address; a refused one gets 403 and an event", async () => {
    const echo = createServer((c) => c.pipe(c));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    servers.push(echo);
    const echoPort = (echo.address() as { port: number }).port;
    const dialled: string[] = [];
    const events: string[] = [];
    const proxy = new EgressProxy({
      allow: claudeManifest.egressHosts,
      resolve,
      onEvent: (e) => events.push(`${e.kind}:${e.host}:${e.reason ?? ""}`),
      connectTo: (_port, address) => {
        dialled.push(address);
        return connect(echoPort, "127.0.0.1");
      },
    });
    const port = await proxy.listenTcp();
    servers.push({ close: () => void proxy.close() });

    const ok = await connectThrough(port, "api.anthropic.com:443");
    expect(ok.status).toBe(200);
    const reply = new Promise<string>((r) => ok.socket.once("data", (d) => r(d.toString())));
    ok.socket.write("ping");
    expect(await reply).toBe("ping");
    ok.socket.destroy();
    expect(dialled).toEqual(["160.79.104.10"]);

    const bad = await connectThrough(port, "example.com:443");
    expect(bad.status).toBe(403);
    bad.socket.destroy();
    const meta = await connectThrough(port, "platform.claude.com:443");
    expect(meta.status).toBe(403);
    meta.socket.destroy();
    expect(events).toContain("egress_blocked:example.com:not_on_allowlist");
    expect(events).toContain("egress_blocked:platform.claude.com:private_address");
    expect(dialled).toHaveLength(1);
  });

  test("anything but CONNECT is refused", async () => {
    const proxy = new EgressProxy({ allow: claudeManifest.egressHosts, resolve });
    const port = await proxy.listenTcp();
    servers.push({ close: () => void proxy.close() });
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: "GET" }).catch(() => null);
    expect(r === null || r.status === 405).toBe(true);
  });
});
