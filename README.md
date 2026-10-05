# varfetch

Fire a configured HTTP request, with `{{variable}}` values in its path, query, headers and body, and map the JSON response onto named variables. No dependencies, ESM, Node 18+.

It is the small, database-free core of a "connector" feature: the application stores connectors and requests however it likes (a database, a config file) and passes them to `fireRequest`.

```js
import { fireRequest } from 'varfetch';

const connector = {
  baseUrl: 'https://api.example.org',
  auth: { type: 'bearer', token: '...' },          // none | bearer | api_key | basic | custom
  headers: [{ key: 'Accept-Language', value: 'fi' }],
};

const request = {
  method: 'GET',
  path: '/api/v1/date/{{date}}',
  query: [{ key: 'cycles', value: 'false' }],
  mappings: [
    { jsonPath: '$.holyDay.name', variable: 'holyday' },
    { jsonPath: '$.holyDay.texts.gospel.reference', variable: 'gospel' },
  ],
};

const result = await fireRequest({ connector, request, variables: { date: '2026-10-11' } });
// { ok: true, status: 200, values: { holyday: '...', gospel: '...' }, body: {...} }
```

## What it does

- **Interpolation:** `{{name}}` in path, query values, header values, auth values and body. Missing variables become an empty string.
- **JSON path:** `$`, `$.a.b`, `$.items[0].name`, `$['key']`. Own properties only.
- **Mapping:** each mapping writes a string (or JSON text for objects and arrays) to a variable; `skipIfNull` (default true) leaves unresolved paths out.
- **SSRF guard:** every URL, redirects included, is resolved and checked. Loopback, private, link-local, CGNAT, reserved and multicast addresses are blocked unless you allow them: `network: { allow: ['10.1.0.0/16', 'anno.internal:3000'], deny: ['*.blocked.example'] }`. `deny` wins over `allow`. The check happens before the connection and does not defend against DNS rebinding.
- **Limits:** 10 s timeout and 5 MiB response by default (`timeoutMs`, `maxBytes`), at most 5 redirects, credentials and other connector headers are not forwarded to another origin.

Variable values are put into the path as given. A value containing `/`, `?` or `#` changes the URL, so run untrusted values through `encodeURIComponent`, or use them in a query parameter, which is encoded for you.

## API

`fireRequest({ connector, request, variables, network, fetch, timeoutMs, maxBytes })` returns `{ ok, status?, values, body?, error? }` and never throws.

Building blocks: `buildRequest(connector, request, variables)`, `buildAuthHeaders`, `mapResponse(mappings, body)`, `interpolate`, `interpolatePairs`, `extractVariableNames`, `evaluateJsonPath`, `checkUrlAllowed(url, { allow, deny })`, `parsePattern`. Types are in `src/index.d.ts`.

## License

EUPL-1.2.
