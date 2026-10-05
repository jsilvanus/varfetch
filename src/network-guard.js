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
 * Allow rules are applied per resolved address: an `allow` CIDR or IP only
 * exempts the addresses it matches, so a name that resolves to one allowed and
 * one restricted address is blocked. A hostname pattern exempts every address
 * of that host.
 *
 * `checkUrlAllowed` returns the addresses it validated (`addresses`). To close
 * the DNS rebinding gap (a second lookup at connect time returning a different
 * address) the caller must connect to exactly those addresses: `fireRequest`
 * does this through `pinnedFetch` (src/transport.js).
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
  ['192.0.2.0', 24],    // documentation
  ['192.88.99.0', 24],  // 6to4 relay anycast
  ['192.168.0.0', 16],  // private
  ['198.18.0.0', 15],   // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24],  // documentation
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved
];
const DEFAULT_BLOCKED_V6 = [
  ['::1', 128],   // loopback
  ['::', 128],    // unspecified
  ['fc00::', 7],  // unique local (ULA)
  ['fe80::', 10], // link-local
  ['ff00::', 8],  // multicast
  ['100::', 64],  // discard-only
  ['2001::', 32], // Teredo (embeds an IPv4 address)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['64:ff9b::', 96], // NAT64 (embeds an IPv4 address)
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

/** Does `pattern` cover this one resolved address of the host? */
function ruleMatchesAddress(pattern, { hostname, port }, address) {
  const parsed = parsePattern(pattern);
  if (parsed.port != null && parsed.port !== port) return false;

  if (parsed.kind === 'host') return hostMatches(parsed.value, hostname);
  if (parsed.kind === 'ip') return sameAddress(address.address, parsed.value);

  // CIDR
  try {
    const [net, prefixStr] = parsed.value.split('/');
    const prefix = Number(prefixStr);
    const family = isIP(net) === 6 ? 'ipv6' : 'ipv4';
    const bl = new BlockList();
    bl.addSubnet(net, prefix, family);
    return bl.check(address.address, address.family === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

function sameAddress(a, b) {
  if (a === b) return true;
  // Compare through BlockList so "::1" and "0:0:0:0:0:0:0:1" are the same address.
  try {
    const bl = new BlockList();
    bl.addAddress(b, isIP(b) === 6 ? 'ipv6' : 'ipv4');
    return bl.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

/**
 * @param {URL} url
 * @param {{ allow?: string[], deny?: string[], lookup?: typeof dnsLookup, signal?: AbortSignal }} [options]
 * @returns {Promise<{ allowed: boolean, reason?: string, addresses?: Array<{ address: string, family: number }> }>}
 *   `addresses` (when allowed) are the validated addresses to connect to.
 */
export async function checkUrlAllowed(url, { allow = [], deny = [], lookup = dnsLookup, signal } = {}) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `Unsupported protocol: ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: 'Credentials in the URL are not supported' };
  }

  // WHATWG URL keeps brackets around an IPv6 literal in .hostname ("[::1]").
  // A trailing dot ("localhost.") names the same host, so it is dropped for matching.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);

  let addresses;
  try {
    addresses = await raceAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    addresses = [];
  }
  if (!Array.isArray(addresses)) addresses = [addresses];
  if (addresses.length === 0) {
    return { allowed: false, reason: `Could not resolve host: ${hostname}` };
  }

  const match = { hostname, port };
  if (deny.some((pattern) => addresses.some((a) => ruleMatchesAddress(pattern, match, a)))) {
    return { allowed: false, reason: 'Blocked by network policy' };
  }
  // Every address must be allowed by a rule or be public: pinning connects to any of them.
  for (const a of addresses) {
    if (allow.some((pattern) => ruleMatchesAddress(pattern, match, a))) continue;
    if (isDefaultRestricted(a.address, a.family)) {
      return { allowed: false, reason: 'Blocked: target resolves to a private/internal/reserved address' };
    }
  }
  return { allowed: true, addresses };
}

/** Reject as soon as `signal` aborts, so a hung DNS lookup cannot outlive the request timeout. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
