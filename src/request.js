import { interpolate, interpolatePairs } from './interpolate.js';
import { evaluateJsonPath } from './json-path.js';

/**
 * Headers a connector's auth settings add.
 * `auth` is `{ type: 'none' }`, `{ type: 'bearer', token }`, `{ type: 'api_key', headerName, value }`,
 * `{ type: 'basic', username, password }` or `{ type: 'custom', headers: { name: value } }`.
 * Values are interpolated, so `{{token}}` works.
 */
export function buildAuthHeaders(auth, variables) {
  if (!auth) return {};
  switch (auth.type) {
    case 'bearer':
      return auth.token ? { Authorization: `Bearer ${interpolate(auth.token, variables)}` } : {};
    case 'api_key':
      return auth.headerName ? { [auth.headerName]: interpolate(auth.value ?? '', variables) } : {};
    case 'basic': {
      if (!auth.username) return {};
      const raw = `${interpolate(auth.username, variables)}:${interpolate(auth.password ?? '', variables)}`;
      return { Authorization: `Basic ${Buffer.from(raw).toString('base64')}` };
    }
    case 'custom':
      return auth.headers && typeof auth.headers === 'object'
        ? Object.fromEntries(Object.entries(auth.headers).map(([name, value]) => [name, interpolate(String(value), variables)]))
        : {};
    default:
      return {};
  }
}

/**
 * Build the URL, method, headers and body of a request without sending it.
 * Path, query, headers and body are interpolated with `variables`.
 *
 * Variable values are put into the path as given, so a value containing `/`,
 * `?` or `#` changes the URL. Pass untrusted values through `encodeURIComponent`
 * yourself, or write `{{name}}` into a query parameter, which is encoded for you.
 *
 * @param {import('./index.js').Connector} connector
 * @param {import('./index.js').RequestDef} request
 * @param {Record<string, unknown>} [variables]
 */
export function buildRequest(connector, request, variables = {}) {
  const base = connector.baseUrl.replace(/\/+$/, '');
  const path = interpolate(request.path || '', variables);
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  for (const { key, value } of interpolatePairs(request.query, variables)) {
    if (key) url.searchParams.append(key, value ?? '');
  }

  const headers = {
    ...Object.fromEntries(interpolatePairs(connector.headers, variables).filter((p) => p.key).map(({ key, value }) => [key, value])),
    ...buildAuthHeaders(connector.auth, variables),
  };

  const method = (request.method || 'GET').toUpperCase();
  let body;
  if (request.bodyType && request.bodyType !== 'none' && request.body && method !== 'GET' && method !== 'HEAD') {
    body = interpolate(request.body, variables);
    const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type');
    if (!hasContentType) headers['Content-Type'] = request.bodyType === 'json' ? 'application/json' : 'text/plain';
  }

  return { url, method, headers, body };
}

/**
 * Map a response body onto variables with the request's mappings.
 * A non-string value is stored as JSON text. With `skipIfNull` (default true) an
 * unresolved path leaves the variable out; otherwise it is `null`.
 *
 * @param {import('./index.js').Mapping[]} mappings
 * @param {unknown} body parsed JSON, or the response text
 * @returns {Record<string, string | null>}
 */
export function mapResponse(mappings, body) {
  const values = {};
  for (const mapping of mappings ?? []) {
    const extracted = evaluateJsonPath(body, mapping.jsonPath);
    const missing = extracted === undefined || extracted === null;
    if (missing && mapping.skipIfNull !== false) continue;
    values[mapping.variable] = missing ? null : typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
  }
  return values;
}
