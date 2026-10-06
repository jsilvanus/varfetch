# varfetch

## 0.3.0

### Security
- **DNS pinning.** `fireRequest` now connects only to the addresses the SSRF guard validated (new `pinnedFetch`, built on `node:http(s)` with a pinned `lookup`). A resolver that answers differently on the second lookup (DNS rebinding) can no longer redirect the connection to an internal address. Host header, SNI and certificate verification still use the original host name. A custom `fetch` option replaces the pinned transport and is only checked, not pinned.
- **Allow rules apply per address.** Before, one matching address was enough to allow a host, so a name resolving to `10.1.1.1` and `169.254.169.254` passed an `allow: ['10.0.0.0/8']` rule. Now every resolved address must be public or covered by an allow rule. Hostname patterns still cover all addresses of that host.
- Deny rules match any resolved address and ignore a trailing dot in the host name (`x.example.` no longer slips past `*.example`).
- More blocked ranges: documentation ranges, 6to4 relay, and the IPv6 forms that embed IPv4 (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32`), discard `100::/64`, documentation `2001:db8::/32`.
- URLs with embedded credentials (`http://user:pw@host`) are refused.
- The DNS lookup is bound to the request timeout; a hung resolver can no longer stall a request.
- New `encodePathVariables` option encodes variable values inserted into the path.

### Changed
- `checkUrlAllowed` also returns the validated `addresses` when allowed.
- The default transport no longer uses the global `fetch`; it sends `Accept-Encoding: identity` and decodes gzip, deflate and br itself (size limits count decompressed bytes). Environment proxies are not used (they were not by Node's fetch either).
- Redirect response bodies are cancelled instead of left open.

## 0.2.0
- `responseType: "binary"` / `"image"` returns raw bytes and the content type.

## 0.1.0
- First release, extracted from the LCYT connectors plugin.
