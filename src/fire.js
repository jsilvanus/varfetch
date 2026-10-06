import { buildRequest, mapResponse } from './request.js';
import { checkUrlAllowed } from './network-guard.js';
import { pinnedFetch } from './transport.js';

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Send a request and map the response onto variables.
 *
 * Every URL is checked with the SSRF guard, redirects included (they are
 * followed here, up to 5, instead of by fetch). Unless a custom `fetch` is
 * given, the connection goes only to the addresses the guard validated
 * (`pinnedFetch`), so DNS rebinding between check and connect is not possible.
 * A custom `fetch` resolves the host itself and is therefore checked, not pinned.
 *
 * @param {object} args
 * @param {import('./index.js').Connector} args.connector
 * @param {import('./index.js').RequestDef} args.request
 * @param {Record<string, unknown>} [args.variables] values for {{name}}
 * @param {{ allow?: string[], deny?: string[] }} [args.network] extra guard patterns, see network-guard.js
 * @param {typeof fetch} [args.fetch] replaces the pinned transport (tests, proxies); DNS pinning does not apply to it
 * @param {boolean} [args.encodePathVariables] run variable values in the path through encodeURIComponent
 * @param {number} [args.timeoutMs] default 10000
 * @param {number} [args.maxBytes] response size limit, default 5 MiB
 * @returns {Promise<import('./index.js').FireResult>}
 */
export async function fireRequest({ connector, request, variables = {}, network = {}, fetch: fetchImpl, timeoutMs, maxBytes = DEFAULT_MAX_BYTES, encodePathVariables = false }) {
  let built;
  try {
    built = buildRequest(connector, request, variables, { encodePathVariables });
  } catch (err) {
    return { ok: false, values: {}, error: `Invalid request: ${err.message}` };
  }

  const timeout = timeoutMs ?? request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeout);

  try {
    let url = built.url;
    let method = built.method;
    let body = built.body;
    let headers = built.headers;
    let response;

    for (let hop = 0; ; hop++) {
      const guard = await checkUrlAllowed(url, { ...network, signal });
      if (!guard.allowed) return { ok: false, values: {}, error: guard.reason };

      response = fetchImpl
        ? await fetchImpl(url, { method, headers, body, redirect: 'manual', signal })
        : await pinnedFetch(url, { method, headers, body, signal }, { addresses: guard.addresses });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) break;
      await discardBody(response);
      if (hop >= MAX_REDIRECTS) return { ok: false, values: {}, status: response.status, error: 'Too many redirects' };

      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        // Credentials and every other connector header stay with the original origin.
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => /^(content-type|accept)$/i.test(name)));
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }

    const bytes = await readLimited(response, maxBytes);
    if (!response.ok) return { ok: false, status: response.status, values: {}, error: `HTTP ${response.status}` };

    const contentType = response.headers.get('content-type') || '';
    if (request.responseType === 'binary' || request.responseType === 'image') {
      return { ok: true, status: response.status, values: {}, body: bytes, contentType };
    }
    const text = bytes.toString('utf8');
    const wantsJson = request.responseType === 'json' || ((request.responseType ?? 'auto') === 'auto' && /json/i.test(contentType));
    let parsed = text;
    if (wantsJson) {
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        return { ok: false, status: response.status, values: {}, error: 'Response is not valid JSON' };
      }
    }
    return { ok: true, status: response.status, values: mapResponse(request.mappings, parsed), body: parsed };
  } catch (err) {
    const message = err?.name === 'TimeoutError' || (err?.name === 'AbortError' && signal.aborted) ? `Timed out after ${timeout} ms` : err?.message ?? String(err);
    return { ok: false, values: {}, error: message };
  }
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw new Error(`Response larger than ${maxBytes} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Release a redirect response's connection. Older Node versions throw on cancelling an already closed stream. */
async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body is already finished: nothing to release.
  }
}
