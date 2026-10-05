# Install and use

## Install

```sh
npm install varfetch        # or pnpm add / yarn add
```

- Node 18 or newer (CI runs 18, 20 and 22).
- ESM only: `import { fireRequest } from 'varfetch'`. From CommonJS use `const { fireRequest } = await import('varfetch')`.
- No runtime dependencies. Types are included.

## First request

```js
import { fireRequest } from 'varfetch';

const result = await fireRequest({
  connector: { baseUrl: 'https://api.example.org' },
  request: {
    path: '/api/v1/date/{{date}}',
    mappings: [{ jsonPath: '$.holyDay.name', variable: 'holyday' }],
  },
  variables: { date: '2026-10-11' },
});
// { ok: true, status: 200, values: { holyday: '…' }, body: { …whole JSON… } }
```

Two objects describe what to call, one describes the values:

- **connector**: where and as whom (`baseUrl`, `auth`, shared `headers`). Reused by many requests.
- **request**: what to call (`method`, `path`, `query`, `body`) and what to take from the answer (`mappings`).
- **variables**: a plain object whose values fill the `{{name}}` placeholders.

## Data shapes

### Connector

```ts
{
  baseUrl: string;                       // https://host[:port][/prefix]
  auth?: Auth;
  headers?: { key: string; value: string }[];   // sent with every request, values interpolated
}
```

| `auth.type` | Fields | Sends |
|---|---|---|
| `none` (or no `auth`) | | nothing |
| `bearer` | `token` | `Authorization: Bearer <token>` |
| `api_key` | `headerName`, `value` | `<headerName>: <value>` |
| `basic` | `username`, `password?` | `Authorization: Basic base64(user:pass)` |
| `custom` | `headers: { name: value }` | those headers |

Auth values may contain `{{name}}`, so a token can come from `variables`. Auth headers win over connector headers with the same name.

### Request

```ts
{
  method?: string;                       // default GET
  path?: string;                         // appended to baseUrl, {{name}} allowed
  query?: { key: string; value: string }[];     // values interpolated and URL-encoded
  bodyType?: 'none' | 'json' | 'text';   // body is sent only for non-GET/HEAD
  body?: string;                         // interpolated; Content-Type set from bodyType unless you set one
  responseType?: 'auto' | 'json' | 'text' | 'binary' | 'image';
  mappings?: { jsonPath: string; variable: string; skipIfNull?: boolean }[];
  timeoutMs?: number;                    // overridden by fireRequest's timeoutMs
}
```

`responseType` `auto` (default) parses JSON when the response content type contains `json`, otherwise the body is text. With `text`, `$` maps the whole text. `binary` and `image` return a `Buffer` as `body` and the `contentType`, and ignore `mappings`.

### Result

```ts
{ ok: boolean; status?: number; values: Record<string, string | null>; body?: unknown; contentType?: string; error?: string }
```

`values` holds one entry per mapping: strings as they are, objects and arrays as JSON text, unresolved paths left out (or `null` when `skipIfNull: false`). `error` is a short human-readable text (`HTTP 404`, `Timed out after 10000 ms`, `Blocked: target resolves to a private/internal/reserved address`, …). It never contains a stack trace or your secrets.

## Variables

- `{{name}}`: letters (including ä/ö/å), digits, `_` and `-`; whitespace inside the braces is fine (`{{ name }}`).
- Missing or `null` variables become an empty string. Use `extractVariableNames(text)` to list what a string needs, for example to show input fields.
- **Path values are inserted raw.** `{{d}}` = `../x?y` changes the URL. When the value is not under your control, set `encodePathVariables: true` or use a query parameter.

```js
await fireRequest({ connector, request, variables: { user: name }, encodePathVariables: true });
```

## JSON paths

| Path | Meaning |
|---|---|
| `$` | the whole body |
| `$.a.b` | nested keys |
| `$.items[0].name` | array index |
| `$['weird key']`, `$["k"]` | quoted key |

No wildcards, filters or `..`. Only own properties resolve, so `$.constructor` and `$.__proto__` give nothing.

## Options of `fireRequest`

| Option | Default | |
|---|---|---|
| `network` | `{}` | `{ allow: string[], deny: string[] }`, see below |
| `timeoutMs` | request's `timeoutMs`, else 10000 | covers DNS, connect, redirects and body |
| `maxBytes` | 5 MiB | response limit, after decompression |
| `encodePathVariables` | `false` | `encodeURIComponent` on values inserted into the path |
| `fetch` | pinned transport | custom `fetch`; disables DNS pinning (see [security](security.md)) |

Fixed: at most 5 redirects; connector headers are not forwarded to another origin.

## Network rules

```js
network: {
  allow: ['10.1.0.0/16', 'anno.internal:3000', '[fd00::]/8', '*.corp.example'],
  deny:  ['10.1.9.9', '*.blocked.example'],
}
```

- Without rules, only public addresses are reachable.
- `allow` opens specific private targets. Each resolved address must be public or covered by an allow rule; a host name rule covers all addresses of that host.
- `deny` wins over everything and is also useful to block public hosts.
- A pattern without a port matches any port. Host names are case-insensitive; `*.example.com` also matches `example.com`.

To see why a URL is refused:

```js
import { checkUrlAllowed } from 'varfetch';
await checkUrlAllowed(new URL('http://10.0.0.5:3000/'), { allow: [] });
// { allowed: false, reason: 'Blocked: target resolves to a private/internal/reserved address' }
```

## Recipes

**POST with a JSON body**

```js
request: {
  method: 'POST', path: '/v1/notes', bodyType: 'json',
  body: '{"title": "{{title}}"}',      // values are inserted as text: escape JSON yourself if they may contain quotes
  mappings: [{ jsonPath: '$.id', variable: 'noteId' }],
}
```

If a value can contain quotes or newlines, build the body with `JSON.stringify` in your code and pass it as a variable: `body: '{{payload}}'` with `variables: { payload: JSON.stringify({ title }) }`.

**Download an image**

```js
const r = await fireRequest({ connector, request: { path: '/logo.png', responseType: 'image' }, network });
if (r.ok) fs.writeFileSync('logo.png', r.body); // r.contentType is e.g. 'image/png'
```

**Preview before applying.** `buildRequest(connector, request, variables)` returns `{ url, method, headers, body }` without sending anything; show it to the user, or log it with the headers masked.

**Test your own code.** Pass `fetch` to avoid the network:

```js
const fakeFetch = async () => new Response(JSON.stringify({ a: 1 }), { headers: { 'content-type': 'application/json' } });
await fireRequest({ connector: { baseUrl: 'https://api.example.org' }, request, fetch: fakeFetch, network: { allow: [] } });
```

(The guard still resolves the host. For a fully offline test use a literal public IP in `baseUrl`, or a local server allowed through `network.allow`.)

## API reference

| Export | Signature |
|---|---|
| `fireRequest(args)` | `Promise<FireResult>`, never rejects |
| `buildRequest(connector, request, variables?, { encodePathVariables }?)` | `{ url: URL, method, headers, body? }`; throws on an invalid base URL |
| `buildAuthHeaders(auth, variables?)` | `Record<string, string>` |
| `mapResponse(mappings, body)` | `Record<string, string \| null>` |
| `interpolate(text, variables?, encode?)` | `string` |
| `interpolatePairs(pairs, variables?)` | `{ key, value }[]` |
| `extractVariableNames(text)` | `string[]` |
| `evaluateJsonPath(data, path)` | value or `undefined` |
| `checkUrlAllowed(url, { allow, deny, lookup?, signal? })` | `{ allowed, reason?, addresses? }` |
| `parsePattern(pattern)` | `{ kind: 'host' \| 'ip' \| 'cidr', value, port }` |
| `pinnedFetch(url, init, { addresses })` | `Promise<Response>` connecting only to `addresses` |

## Troubleshooting

| `error` | Cause and fix |
|---|---|
| `Blocked: target resolves to a private/internal/reserved address` | The target is on a private network. Add an `allow` rule if it is intended. |
| `Blocked by network policy` | A `deny` rule matched. |
| `Could not resolve host: …` | DNS failure, or the name does not exist. |
| `Invalid request: Invalid URL` | `baseUrl` or the interpolated path does not form a URL. |
| `Timed out after N ms` | Raise `timeoutMs`, or the remote is slow. |
| `Response larger than N bytes` | Raise `maxBytes` or fetch a smaller resource. |
| `Response is not valid JSON` | `responseType` is `json` (or auto and the server says JSON) but the body is not. |
| `HTTP 4xx/5xx` | The remote refused; `status` has the code. |
| `Too many redirects` | More than five hops or a loop. |
| `Credentials in the URL are not supported` | Remove `user:pass@` from `baseUrl`; use `auth`. |
| `values` is empty although `ok` is true | The JSON paths did not resolve. Inspect `result.body`. |
