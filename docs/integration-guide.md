# Integration guide

How to wire varfetch into an application. The pattern is the same everywhere: store connectors and requests, convert a stored request to varfetch's plain shapes, fire it with server-owned network rules, and store the resulting values as variables.

```
 UI / API ──► stored connector + request ──► toVarfetch() ──► fireRequest() ──► values ──► variables
                 (your database)                                  ▲
                                                  network rules from server config
```

## 1. Decide where things live

| Concern | Put it | Why |
|---|---|---|
| Connector and request definitions | Your database or config, editable by authorised users | They are data |
| Secrets (tokens, passwords) | Same store, encrypted; return only `hasSecret` to clients | Never send them back to a browser |
| **Network `allow`/`deny` rules** | **Server configuration** (env, or admin-only settings) | A user who can edit connectors must not be able to widen what the server may reach |
| Variables | Wherever your app keeps project/session values | varfetch only produces the values |

## 2. Model the data

Anything that converts to these shapes works:

```ts
interface Connector { baseUrl: string; auth?: Auth; headers?: { key: string; value: string }[] }
interface RequestDef { method?; path?; query?; bodyType?; body?; responseType?; mappings?: { jsonPath; variable; skipIfNull? }[]; timeoutMs? }
```

Validate on the way in (a Zod schema, JSON Schema): `baseUrl` must be `http(s)`, variable names must be valid (`[\p{L}_][\p{L}\p{N}_-]*`), header names must be tokens. Validate again when converting a row: JSON columns can hold anything.

## 3. A minimal Express integration

```js
import express from 'express';
import { fireRequest } from 'varfetch';

const network = {
  allow: (process.env.CONNECTOR_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  deny:  (process.env.CONNECTOR_DENY  ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};

const app = express();
app.use(express.json());

app.post('/connectors/:id/requests/:rid/fire', async (req, res) => {
  const { connector, request } = await loadFromDatabase(req.params.id, req.params.rid); // your code
  const result = await fireRequest({
    connector,
    request,
    variables: req.body.variables ?? {},
    network,
    encodePathVariables: true,          // values come from the client
  });
  if (!result.ok) return res.status(502).json({ error: result.error, status: result.status });
  res.json({ values: result.values });
});
```

Notes:

- Answer upstream failures with **502** (and the remote `status` when present); keep your own 4xx for bad input.
- Do not return `result.body` to the client unless you want the whole remote answer exposed; `values` is the designed output.
- Never log `connector.auth`. If you log requests, use `buildRequest` and mask `Authorization` and any api-key header.

## 4. Turning values into variables

`values` is `Record<string, string | null>`. Typical flow ("fetch variables" button):

1. Fire the request with the current variables as input (the request path may use them, e.g. `{{date}}`).
2. Show the user old versus new values.
3. Save only what they accept.

Do not write `values` straight into state that triggers other work (renders, publications) without a confirmation step unless the connector is fully trusted. A remote server controls those strings.

## 5. Worked example: Saarnavideo

Saarnavideo uses varfetch for user-defined API variables, with the church-year service anno-api as the main use case. Nothing about that service is built in.

- **Storage.** Prisma models `ApiConnector` and `ApiRequest` (global, both schemas). The connector secret is stored but only `hasSecret` is returned.
- **Conversion.** `toVarfetch(connectorRow, requestRow)` (`src/domain/connectors.ts`) validates JSON columns with Zod (`asPairs`, `asAuth`, `mappingSchema`) and returns `{ connector, request }`.
- **Network rules.** `networkRulesFromEnv()` reads `CONNECTOR_ALLOW` and `CONNECTOR_DENY` (comma-separated patterns). The app has no login, so rules are environment-only. To use an anno-api on a private network, run Saarnavideo with, for example, `CONNECTOR_ALLOW=anno.internal:3000` or `CONNECTOR_ALLOW=10.1.0.0/16`.
- **Firing.** `runStoredRequest` (`src/app/api/_lib/connectors.ts`) loads the request, calls `fireRequest({ connector, request, variables, network })`, and answers 502 with `fireErrorMessage(result)` on failure.
- **Variables.** `POST /api/projects/[id]/fetch-variables` fires a request with the project's variables (service date default: next Sunday as `paiva`) and the Lähde step's `FetchVariables` shows old versus new values before `saveVariables` stores the accepted ones.
- **Preset.** "Lisää kirkkovuosipohja" adds a request preset for an anno-api style day endpoint (`/api/v1/date/{{paiva}}`) with mappings to ASCII variable names (`pyhapaiva`, `teema`, `evankeliumi`, `evankeliumiteksti`, `vari`, `jakso`, `aika`) to a connector whose address the user typed.

Hardening worth doing in a login-less app: `paiva` goes into the path, so set `encodePathVariables: true` in `runStoredRequest`, and add a login before exposing the app beyond a trusted network.

## 6. Worked example: LCYT

`lcyt-connectors` uses varfetch for the same job inside a multi-tenant server and layers its own policy on top:

- **Policy from the database.** Site-wide (admin) and per-organisation rules are loaded and merged into one `{ allow, deny }`: org deny and site deny become `deny`, org and site allow become `allow`. `fireRequest({ network })` then enforces them at every hop.
- **Layered error messages.** Before firing, LCYT calls `checkUrlAllowed` once per deny layer with a memoised `lookup`, so the error can say whether the organisation or the site policy blocked the request. The `lookup` option accepts a function returning one result or an array.
- **Binary responses.** `responseType: 'image'` returns the bytes and `contentType`; LCYT stores them as an asset instead of mapping text.
- **Events.** Values written to variables emit an event so the UI updates live.

## 7. Policy recipes

| Goal | Rules |
|---|---|
| Public APIs only | no rules |
| One internal service | `allow: ['anno.internal:3000']` |
| Internal subnet, but not the database host | `allow: ['10.1.0.0/16']`, `deny: ['10.1.0.5']` |
| Public APIs except one vendor | `deny: ['*.vendor.example']` |
| Only specific public hosts (allow-list mode) | varfetch has no "deny all" rule: enforce it yourself by rejecting connectors whose host is not on your list before calling `fireRequest` |
| Local development against `localhost` | `allow: ['127.0.0.1:3000']` (name `localhost` resolves to a loopback address, so `allow: ['localhost:3000']` works too) |

## 8. Operations checklist

- [ ] Network rules come from server config, not from user-editable data
- [ ] Secrets encrypted at rest, never returned or logged
- [ ] Upstream failures answered as 502; no stack traces to clients
- [ ] `encodePathVariables: true` whenever a variable value comes from a user
- [ ] Authorisation on who can create and edit connectors and fire requests
- [ ] Rate limiting on the fire endpoint
- [ ] Mapped values escaped when rendered
- [ ] No custom `fetch` in production unless you enforce the network policy elsewhere (it disables DNS pinning)
- [ ] Behind a corporate proxy: see [security.md](security.md#when-pinning-does-not-apply)

## 9. Testing an integration

Run a local `http` server, allow it by address, and fire real requests:

```js
const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"name":"Sunday"}'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const result = await fireRequest({
  connector: { baseUrl: `http://127.0.0.1:${port}` },
  request: { path: '/', mappings: [{ jsonPath: '$.name', variable: 'n' }] },
  network: { allow: [`127.0.0.1:${port}`] },
});
```

To assert that your app refuses private targets, fire at `http://127.0.0.1:<port>` with no `allow` and expect `ok: false`.
