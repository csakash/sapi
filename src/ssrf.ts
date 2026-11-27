/**
 * Address checks for outbound connections (ARI-42 INJ-4). Providers are public HTTPS APIs, so
 * anything private, loopback, link-local (cloud metadata lives at 169.254.169.254), shared,
 * multicast, reserved or documentation-only is refused after DNS resolution.
 */
import { isIP } from "node:net";

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function blockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address to 8 groups of 16 bits. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  // Trailing dotted IPv4 (e.g. ::ffff:10.0.0.1)
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  let extra: number[] = [];
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const n = v4ToInt(tail);
    extra = [n >>> 16, n & 0xffff];
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 && fill !== 0) return null;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest].map((g) => Number.parseInt(g || "0", 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  if (extra.length) {
    groups[6] = extra[0]!;
    groups[7] = extra[1]!;
  }
  return groups;
}

function blockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable: refuse
  const [a = 0, b = 0] = g;
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embeddedV4 = () => `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && g[7] === 1) return true; // ::1
  if (allZero(0, 5) && g[5] === 0xffff) return blockedV4(embeddedV4()); // IPv4-mapped
  if (allZero(0, 6)) return true; // IPv4-compatible (deprecated)
  if (a === 0x64 && b === 0xff9b && allZero(2, 6)) return blockedV4(embeddedV4()); // NAT64
  if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2002) return blockedV4(`${b >>> 8}.${b & 0xff}.${g[2]! >>> 8}.${g[2]! & 0xff}`); // 6to4
  if (a === 0x0100 && allZero(1, 4)) return true; // discard-only
  return false;
}

/** True when an outbound connection to this IP must be refused. Unparseable input is refused. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blockedV4(ip);
  if (kind === 6) return blockedV6(ip);
  return true;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Normalise a hostname for allowlist matching; null when it isn't a plain DNS name. */
export function normaliseHost(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isIP(h) || !HOST_RE.test(h)) return null;
  return h;
}
