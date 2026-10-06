# varfetch

Fire a configured HTTP request with `{{variable}}` values in its path, query, headers and body, and map the JSON response onto named variables. Zero dependencies, ESM, Node 18+.

varfetch is the small, database-free core of a "connector" feature. Your application stores connectors and requests however it likes (a database, a config file, a UI) and hands them to `fireRequest`. varfetch does the part that is easy to get wrong: building the request, refusing to be turned into an SSRF proxy, and extracting values from the answer.

```js
import { fireRequest } from 'varfetch';

const result = await fireRequest({
  connector: {
    baseUrl: 'https://api.example.org',
    auth: { type: 'bearer', token: process.env.API_TOKEN },
    headers: [{ key: 'Accept-Language', value: 'fi' }],
  },
  request: {
    method: 'GET',
    path: '/api/v1/date/{{date}}',
    query: [{ key: 'cycles', value: 'false' }],
    mappings: [
      { jsonPath: '$.holyDay.name', variable: 'holyday' },
      { jsonPath: '$.holyDay.texts.gospel.reference', variable: 'gospel' },
    ],
  },
  variables: { date: '2026-10-11' },
});

if (result.ok) console.log(result.values); // { holyday: '...', gospel: '...' }
else console.error(result.error);
```

`fireRequest` never throws: failures come back as `{ ok: false, error }`.

## Features

| | |
|---|---|
| **Interpolation** | `{{name}}` in path, query values, header values, auth values and body. Names may contain letters (incl. ä/ö/å), digits, `_` and `-`. Missing variables render as an empty string. |
| **Auth** | `none`, `bearer`, `api_key` (any header), `basic`, `custom` headers. Values are interpolated too. |
| **JSON mapping** | `$`, `$.a.b`, `$.items[0].name`, `$['key']`. Own properties only (`$.constructor` resolves to nothing). Objects and arrays are stored as JSON text. |
| **Response types** | `auto` (JSON when the content type says so), `json`, `text`, `binary` / `image` (raw `Buffer` plus content type). |
| **SSRF guard** | Blocks loopback, private, link-local (cloud metadata), CGNAT, reserved, multicast and IPv6 forms that embed IPv4. Allow and deny rules by host, wildcard, IP or CIDR. Applied to every redirect hop. |
| **DNS pinning** | The connection goes only to the addresses the guard validated, so DNS rebinding between check and connect is impossible. See [docs/security.md](docs/security.md). |
| **Limits** | 10 s timeout, 5 MiB response (measured after decompression), at most 5 redirects. Credentials and connector headers are never sent to another origin after a redirect. |

## Install

```sh
npm install varfetch
```

Requires Node 18 or newer. There are no runtime dependencies. TypeScript types ship in the package.

## Reaching private networks

By default every private and internal address is refused. To let a server call an API on its own network, allow that target explicitly:

```js
await fireRequest({
  connector, request, variables,
  network: {
    allow: ['anno.internal:3000', '10.1.0.0/16'],
    deny: ['*.blocked.example'],   // deny always wins
  },
});
```

Keep these rules in server configuration (an environment variable, for example), not in anything a user of your application can edit. See the [integration guide](docs/integration-guide.md).

## Path variables

Variable values are put into the path as given. A value containing `/`, `?` or `#` changes the URL. If any value comes from a user, either pass `encodePathVariables: true` (each value goes through `encodeURIComponent`) or put it in a query parameter, which is always encoded.

## API summary

- `fireRequest({ connector, request, variables, network, timeoutMs, maxBytes, encodePathVariables, fetch })` → `{ ok, status?, values, body?, contentType?, error? }`
- Building blocks: `buildRequest`, `buildAuthHeaders`, `mapResponse`, `interpolate`, `interpolatePairs`, `extractVariableNames`, `evaluateJsonPath`, `checkUrlAllowed`, `parsePattern`, `pinnedFetch`.

Full reference: [docs/install-and-use.md](docs/install-and-use.md#api-reference). Types: [`src/index.d.ts`](src/index.d.ts).

## Documentation

- [Install and use guide](docs/install-and-use.md): data shapes, every option, recipes, troubleshooting
- [Integration guide](docs/integration-guide.md): wiring varfetch into an application, with the Saarnavideo and LCYT integrations as worked examples
- [Architecture](docs/architecture.md): modules, request lifecycle, design decisions
- [Security model](docs/security.md): threat model, SSRF guard, DNS pinning, what is not covered
- [Changelog](CHANGELOG.md)

## Development

```sh
npm test    # node --test, no build step
```

CI runs the tests on Node 18, 20 and 22.

### Releases

Versioning and publishing use [Changesets](https://github.com/changesets/changesets). For a user-facing change run `npm run changeset` and commit the file it creates. On merge to `main` the Release workflow opens a "Version Packages" PR; merging it publishes to npm through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no npm token stored). Do not edit `version` or run `npm publish` by hand. One-time setup: on npmjs.com, package `varfetch` → Settings → Trusted Publisher → GitHub Actions, repository `jsilvanus/varfetch`, workflow `release.yml`.

## License

EUPL-1.2.
