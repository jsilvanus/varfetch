# Architecture

varfetch is five small modules and a transport. It has no state, no I/O except the HTTP call itself, and no dependencies. All persistence, UI and scheduling belong to the host application.

```
                      fireRequest(args)                      src/fire.js
                            │
        ┌───────────────────┼───────────────────────┐
        ▼                   ▼                       ▼
  buildRequest         redirect loop           mapResponse
  src/request.js    (≤ 5 hops, per hop:)       src/request.js
   │  interpolate        │                         │
   │  src/interpolate.js │                         └─ evaluateJsonPath
   │                     ├─ checkUrlAllowed             src/json-path.js
   │                     │   src/network-guard.js
   │                     │   resolve → rules → validated addresses
   │                     │
   │                     └─ pinnedFetch(url, …, { addresses })
   │                         src/transport.js  (node:http / node:https)
   ▼
 { url, method, headers, body }
```

## Modules

| Module | Responsibility | Pure? |
|---|---|---|
| `interpolate.js` | `{{name}}` substitution, listing the names a string uses | yes |
| `json-path.js` | Minimal JSONPath subset (`$`, `.key`, `[n]`, `['key']`), own properties only | yes |
| `request.js` | `buildRequest` (URL, headers, auth, body from definitions + variables), `buildAuthHeaders`, `mapResponse` | yes |
| `network-guard.js` | Pattern parsing, default restricted ranges, DNS resolution, allow/deny decision, returns validated addresses | DNS only |
| `transport.js` | `pinnedFetch`: HTTP(S) request pinned to given addresses, returns a standard `Response` | network |
| `fire.js` | Orchestration: build, guard, send, follow redirects, enforce limits, parse, map; never throws | network |

`index.js` re-exports everything; `index.d.ts` holds the hand-written types. Both are the public API.

## Request lifecycle

1. **Build.** `buildRequest` interpolates the path, query values, connector headers and auth values, and the body. A bad base URL throws here; `fireRequest` turns it into `{ ok: false, error: 'Invalid request: …' }`.
2. **Start the clock.** One `AbortSignal.timeout` covers the whole call: DNS, connect, all redirect hops and reading the body.
3. **Guard (per hop).** `checkUrlAllowed` resolves the host and applies the rules (see [security.md](security.md)). A refusal ends the call with the reason as `error`.
4. **Send (per hop).** `pinnedFetch` connects to the validated addresses only. A custom `fetch` replaces it.
5. **Redirects.** `fetch`'s own redirect handling is never used. For a 3xx with `Location`, varfetch resolves the URL, drops all connector headers except `Content-Type`/`Accept` when the origin changes, turns 303 (and 301/302 after POST) into a bodyless GET, cancels the old body and loops back to step 3. More than 5 hops is an error.
6. **Read.** The body is read with a hard byte limit (decompressed bytes). A non-2xx status is `{ ok: false, status, error: 'HTTP 404' }`.
7. **Parse.** `binary`/`image` returns the `Buffer` and content type. Otherwise JSON is parsed when requested, or when `auto` and the content type contains `json`. A parse failure is an error.
8. **Map.** `mapResponse` evaluates each `jsonPath` and writes strings (objects as JSON text) into `values`.

## Design decisions

- **Definitions are plain data.** A connector is `{ baseUrl, auth, headers }` and a request is `{ method, path, query, body, mappings }`. varfetch has no storage layer so it fits a database row, a YAML file, or an object literal. The host converts its rows to these shapes (Saarnavideo: `toVarfetch`).
- **Never throws.** `fireRequest` always resolves to a result object, so callers can map failures straight onto an HTTP 502 or a UI message without try/catch.
- **The guard sits where the URL is final.** Checking at the point of connection (and per redirect hop) means the guard cannot be bypassed by a request definition, a variable value or a redirect.
- **Pinning through `lookup`, not through rewriting the URL.** Replacing the host with an IP would break TLS certificate checks and virtual hosting. A pinned `lookup` keeps the URL, Host and SNI intact and changes only where the socket goes.
- **Own transport instead of `fetch`.** Node's `fetch` (undici) offers no dependency-free hook for a per-request resolver. `node:http(s)` does, and the result is wrapped in a standard `Response` so the rest of the code (and any custom `fetch`) shares one shape.
- **Per-address allow rules.** An allow rule is a statement about addresses; evaluating it per address is the only reading that is safe when a name has several.
- **Small JSONPath.** Only what connector mappings need. No wildcards, filters or recursion: they cost parsing complexity and make mappings unpredictable.
- **Rules come from the host.** `allow`/`deny` are arguments, not environment reads, so each host decides where policy lives (env, database, per organisation). LCYT merges organisation and site rules from its database; Saarnavideo reads `CONNECTOR_ALLOW`/`CONNECTOR_DENY`.

## Testing

`node --test test/*.test.js`. Network tests start a local `http` server on `127.0.0.1` and allow it explicitly; DNS behaviour is tested with an injected `lookup`, so no real DNS is needed. The DNS pinning tests use an unresolvable name (`rebind.invalid`) and succeed only if the connection uses the validated address.
