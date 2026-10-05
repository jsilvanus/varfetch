# Security model

varfetch exists so that an application can let someone configure an outbound HTTP request without handing that person a way to attack the server's own network. This page states what it defends against, how, and what it does not cover.

## Threat model

The **operator** runs the application and decides which networks it may reach. The **configurer** is whoever edits connectors and requests (an admin, an organisation owner, or, in an app without login, anyone who can open the page). The **remote server** is whatever the URL points at, and it may be hostile or compromised.

| Threat | Defence |
|---|---|
| Configurer points a connector at an internal service or the cloud metadata endpoint (`169.254.169.254`) | Default-deny of private, loopback, link-local and reserved addresses |
| A public-looking name that resolves to a private address | The check runs on the resolved addresses, not the name |
| DNS rebinding: the name answers with a public address for the check and a private one for the connection | **DNS pinning**: the connection uses the validated addresses only |
| Remote server redirects to an internal address | Redirects are followed by varfetch and every hop is checked and pinned |
| Remote server redirects to another origin to harvest credentials | Connector headers (including auth) are dropped on a cross-origin redirect |
| Huge or endless response | 5 MiB limit on decompressed bytes, 10 s timeout (both configurable) |
| Compression bomb | The limit counts bytes after decoding |
| Variable value alters the request path (`../`, `?`, `#`) | `encodePathVariables`, or put the value in a query parameter |
| Prototype access through the JSON path (`$.__proto__`) | Own properties only |
| Non-HTTP schemes (`file:`, `ftp:`) | Rejected |
| `http://user:pw@host` URLs | Rejected, use the `auth` setting |
| Hung DNS resolver | The lookup is bound to the request timeout |

## The SSRF guard

`checkUrlAllowed(url, { allow, deny })` decides per URL. Order of evaluation:

1. Scheme other than `http`/`https` → blocked.
2. Credentials in the URL → blocked.
3. The host is resolved (`dns.lookup`, all addresses).
4. A `deny` pattern matches **any** resolved address → blocked.
5. For **each** resolved address: it must be covered by an `allow` pattern or not be in a restricted range; otherwise the whole URL is blocked.
6. Otherwise allowed, and the validated `addresses` are returned.

Step 5 is per address on purpose. A host that resolves to one allowed and one restricted address is refused, because the connection could use either one. A *hostname* allow pattern (`anno.internal`) covers all addresses of that host, because you named the host as trusted.

Blocked by default:

- IPv4: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`
- IPv6: `::1`, `::`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `100::/64`, `2001::/32` (Teredo), `2001:db8::/32`, `2002::/16` (6to4), `64:ff9b::/96` (NAT64)
- IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is checked as the IPv4 address

Pattern syntax: exact host (`api.example.com`), wildcard (`*.example.com`, also matches `example.com`), IP (`10.1.2.3`), CIDR (`10.0.0.0/8`, `[fc00::]/7`), each with an optional port (`10.1.2.3:3000`, `[::1]:11434`). No port means any port. Host names are compared in lower case without a trailing dot.

## DNS pinning

A plain "resolve, check, then `fetch`" has a gap: `fetch` resolves the name again. An attacker who controls the DNS zone returns a public address with TTL 0 for the check and `127.0.0.1` for the connection.

varfetch closes the gap in `pinnedFetch` (`src/transport.js`). It calls `node:http` or `node:https` with a `lookup` function that returns the addresses `checkUrlAllowed` validated, so the operating system's resolver is never consulted for the connection. Everything else stays as if the name had been used: the URL, the `Host` header, the TLS server name (SNI) and certificate verification (the certificate must be valid for the host name, not for the IP).

Details:

- One DNS lookup per hop. If the resolver returns several addresses, Node's normal connection fallback applies, but only among validated addresses.
- No connection pooling (`agent: false`), so a reused socket cannot carry an old validation to a new request.
- The same pinning applies to every redirect hop.
- IP literals in the URL need no lookup and are checked directly.

### When pinning does not apply

If you pass your own `fetch` to `fireRequest`, that function resolves the host itself. The guard still checks the URL (and every redirect), but the rebinding window is back. Use a custom `fetch` for tests, or when a corporate proxy is required (the proxy then does the resolving, so enforce the policy there). Do not use it to "add logging" in production without keeping this in mind.

## What varfetch does not protect

- **The remote server's content.** Response values are strings from a server you chose to call. If you render them in HTML, escape them; if you put them into another request, treat them as untrusted.
- **Secrets at rest.** Auth tokens in a connector object are plain strings. Store them encrypted, never return them to a browser, and scrub them from error messages. (Saarnavideo stores the secret but only returns `hasSecret`.)
- **Who may configure connectors.** If anyone can create a connector, anyone can make your server call the allowed targets. Decide your own authorisation. In particular, keep `allow` rules in server configuration, so the people who configure connectors cannot widen what the server may reach.
- **Request volume.** There is no rate limiting. A connector can be used to send many requests to an allowed target.
- **TOCTOU on allowed internal targets.** An allowed internal host is trusted by definition; pinning prevents the address from changing, not the service behind it from misbehaving.
- **Proxies.** `HTTP_PROXY` and friends are ignored by the default transport. In a proxy-only network, use a custom `fetch` and enforce policy at the proxy.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security tab), or email the maintainer listed in `package.json`.
