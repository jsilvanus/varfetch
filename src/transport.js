/**
 * HTTP transport that connects only to addresses the SSRF guard has validated.
 *
 * `fetch` resolves the host name itself, so a check done before the call can be
 * defeated by DNS rebinding: the name answers with a public address for the
 * check and a private one for the connection. `pinnedFetch` closes that gap by
 * giving node:http(s) a `lookup` that returns the already validated addresses.
 * The URL, the `Host` header, the TLS server name (SNI) and certificate
 * verification still use the original host name, so nothing else changes.
 *
 * It returns a standard `Response`. Proxies from the environment are not used
 * (neither does Node's built-in fetch).
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * @param {URL} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }} init
 * @param {{ addresses: Array<{ address: string, family: number }> }} pin validated addresses to connect to
 * @returns {Promise<Response>}
 */
export function pinnedFetch(url, { method = 'GET', headers = {}, body, signal } = {}, { addresses }) {
  if (!addresses?.length) return Promise.reject(new Error('No validated address to connect to'));
  const lib = url.protocol === 'https:' ? https : http;

  const lookup = (_hostname, options, callback) => {
    if (typeof options === 'function') callback = options;
    const wanted = typeof options === 'object' && options?.family ? Number(options.family) : 0;
    const usable = addresses.filter((a) => !wanted || a.family === wanted);
    if (usable.length === 0) {
      callback(Object.assign(new Error('No validated address for the requested IP family'), { code: 'ENOTFOUND' }));
    } else if (typeof options === 'object' && options?.all) {
      callback(null, usable.map(({ address, family }) => ({ address, family })));
    } else {
      callback(null, usable[0].address, usable[0].family);
    }
  };

  const requestHeaders = { 'accept-encoding': 'identity', ...lowerCaseKeys(headers) };
  if (body !== undefined) requestHeaders['content-length'] = String(Buffer.byteLength(body));

  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
        lookup,
        agent: false, // no pooling: a reused socket may be pinned to another validation
        signal,
      },
      (res) => {
        try {
          resolve(toResponse(res));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function lowerCaseKeys(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function toResponse(res) {
  const responseHeaders = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    try {
      responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    } catch {
      // A header the Headers class refuses is not needed by callers.
    }
  }

  let stream = res;
  const encoding = (res.headers['content-encoding'] || '').toLowerCase().trim();
  if (encoding && encoding !== 'identity') {
    const decoder = decoderFor(encoding);
    if (!decoder) throw new Error(`Unsupported content-encoding: ${encoding}`);
    stream = res.pipe(decoder);
    res.on('error', (err) => decoder.destroy(err));
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length'); // the compressed length no longer applies
  }

  const status = res.statusCode;
  if (NULL_BODY_STATUS.has(status)) {
    stream.resume();
    return new Response(null, { status, headers: responseHeaders });
  }
  return new Response(Readable.toWeb(stream), { status, headers: responseHeaders });
}

function decoderFor(encoding) {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}
