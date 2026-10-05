/**
 * Outbound request SSRF guard.
 *
 * Without it, a connector's base URL is user-controlled and the server would
 * fetch whatever it points at (cloud metadata endpoints, internal services).
 *
 * Defaults: block loopback, private, link-local, CGNAT, reserved and multicast
 * addresses. The check runs on the DNS-resolved addresses, not only on the
 * hostname string, so a public-looking name that resolves to a private IP is
 * caught too. Callers add their own `allow` and `deny` patterns on top.
 *
 * Evaluation order (first match wins):
 *   1. scheme other than http/https -> blocked, no override
 *   2. a `deny` pattern matches     -> blocked
 *   3. an `allow` pattern matches   -> allowed
 *   4. resolves to a restricted address -> blocked
 *   5. otherwise                    -> allowed
 *
 * Pattern syntax:
 *   - exact hostname:       "api.example.com" or "api.example.com:8443"
 *   - wildcard subdomain:   "*.example.com"
 *   - exact IP:             "127.0.0.1" or "127.0.0.1:11434"
 *   - CIDR:                 "10.0.0.0/8" or "[fc00::]/7"
 *   - bracketed IPv6 + port "[::1]:11434"
 * A pattern without a port matches that host or IP on any port.
 *
 * The addresses are resolved once, before the fetch. This does not defend
 * against DNS rebinding between the check and the connection.
 */
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const DEFAULT_BLOCKED_V4 = [
  ['0.0.0.0', 8],       // "this network" / unspecified
  ['10.0.0.0', 8],      // private
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local — includes cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],   // private
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.168.0.0', 16],  // private
  ['198.18.0.0', 15],   // benchmarking
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved
];
const DEFAULT_BLOCKED_V6 = [
  ['::1', 128],   // loopback
  ['::', 128],    // unspecified
  ['fc00::', 7],  // unique local (ULA)
  ['fe80::', 10], // link-local
  ['ff00::', 8],  // multicast
  // No explicit IPv4-mapped (::ffff:x.x.x.x) rule needed: net.BlockList
  // already matches a mapped address checked as 'ipv6' against the
  // corresponding plain-IPv4 rule above checked as 'ipv4' — adding an
  // explicit ::ffff:0:0/96 rule here double-counts that and, empirically,
  // corrupts unrelated 'ipv4' checks against the same BlockList instance.
];

const defaultBlockList = new BlockList();
for (const [addr, prefix] of DEFAULT_BLOCKED_V4) defaultBlockList.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of DEFAULT_BLOCKED_V6) defaultBlockList.addSubnet(addr, prefix, 'ipv6');

function isDefaultRestricted(address, family) {
  return defaultBlockList.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Parse a rule pattern into { kind: 'host'|'ip'|'cidr', value, port|null }. */
export function parsePattern(pattern) {
  let value = pattern.trim();
  let port = null;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close !== -1) {
      const host = value.slice(1, close);
      const rest = value.slice(close + 1);
      const portMatch = rest.match(/^:(\d+)$/);
      value = host;
      if (portMatch) port = Number(portMatch[1]);
    }
  } else {
    const lastColon = value.lastIndexOf(':');
    if (lastColon > -1) {
      const maybePort = value.slice(lastColon + 1);
      const maybeHost = value.slice(0, lastColon);
      // Only treat trailing ":N" as a port if the remainder isn't itself a
      // bare (colon-bearing) IPv6 literal.
      if (/^\d+$/.test(maybePort) && !maybeHost.includes(':')) {
        value = maybeHost;
        port = Number(maybePort);
      }
    }
  }

  if (value.includes('/')) return { kind: 'cidr', value, port };
  if (isIP(value)) return { kind: 'ip', value, port };
  return { kind: 'host', value: value.toLowerCase(), port };
}

function hostMatches(pattern, hostname) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return pattern === hostname;
}

function ruleMatches(pattern, { hostname, addresses, port }) {
  const parsed = parsePattern(pattern);
  if (parsed.port != null && parsed.port !== port) return false;

  if (parsed.kind === 'host') return hostMatches(parsed.value, hostname);
  if (parsed.kind === 'ip') return addresses.some((a) => a.address === parsed.value);

  // CIDR
  try {
    const [net, prefixStr] = parsed.value.split('/');
    const prefix = Number(prefixStr);
    const family = isIP(net) === 6 ? 'ipv6' : 'ipv4';
    const bl = new BlockList();
    bl.addSubnet(net, prefix, family);
    return addresses.some((a) => bl.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'));
  } catch {
    return false;
  }
}

/**
 * @param {URL} url
 * @param {{ allow?: string[], deny?: string[], lookup?: typeof dnsLookup }} [options]
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
export async function checkUrlAllowed(url, { allow = [], deny = [], lookup = dnsLookup } = {}) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `Unsupported protocol: ${url.protocol}` };
  }

  // WHATWG URL keeps brackets around an IPv6 literal in .hostname ("[::1]").
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `Could not resolve host: ${hostname}` };
  }

  const match = { hostname, addresses, port };
  if (deny.some((pattern) => ruleMatches(pattern, match))) {
    return { allowed: false, reason: 'Blocked by network policy' };
  }
  if (allow.some((pattern) => ruleMatches(pattern, match))) {
    return { allowed: true };
  }
  if (addresses.some((a) => isDefaultRestricted(a.address, a.family))) {
    return { allowed: false, reason: 'Blocked: target resolves to a private/internal/reserved address' };
  }
  return { allowed: true };
}
