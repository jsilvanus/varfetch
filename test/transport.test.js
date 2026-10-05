import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { fireRequest } from '../src/fire.js';
import { pinnedFetch } from '../src/transport.js';

let server;
let port;
const hosts = [];

before(async () => {
  server = http.createServer((req, res) => {
    hosts.push(req.headers.host);
    if (req.url === '/gzip') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', 'gzip');
      res.end(zlib.gzipSync(JSON.stringify({ name: 'packed' })));
    } else if (req.url === '/bomb') {
      res.setHeader('content-type', 'text/plain');
      res.setHeader('content-encoding', 'gzip');
      res.end(zlib.gzipSync('x'.repeat(100_000)));
    } else if (req.url === '/empty') {
      res.statusCode = 204;
      res.end();
    } else if (req.url === '/echo') {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body: data, accept: req.headers['accept-encoding'] }));
      });
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => server.close());

const connector = (host) => ({ baseUrl: `http://${host}:${port}` });

describe('DNS pinning', () => {
  test('connects to the validated address, not to a fresh DNS answer', async () => {
    // "rebind.invalid" cannot be resolved by the operating system. The request only
    // succeeds if the connection uses the address the guard validated.
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    hosts.length = 0;
    const result = await fireRequest({
      connector: connector('rebind.invalid'),
      request: { path: '/x', mappings: [{ jsonPath: '$.ok', variable: 'ok' }] },
      network: { allow: [`rebind.invalid:${port}`], lookup },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.values.ok, 'true');
    assert.equal(hosts[0], `rebind.invalid:${port}`, 'Host header keeps the original name');
  });

  test('resolves only once per hop', async () => {
    let calls = 0;
    const lookup = async () => {
      calls++;
      // A rebinding resolver: the second answer would be the metadata address.
      return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '169.254.169.254', family: 4 }];
    };
    const result = await fireRequest({
      connector: connector('rebind.invalid'),
      request: { path: '/x' },
      network: { allow: [`rebind.invalid:${port}`], lookup },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls, 1);
  });

  test('refuses a name whose answers are only partly allowed', async () => {
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }];
    const result = await fireRequest({
      connector: connector('mixed.invalid'),
      request: { path: '/x' },
      network: { allow: ['127.0.0.1'], lookup },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /private\/internal\/reserved/);
  });

  test('pinnedFetch needs validated addresses', async () => {
    await assert.rejects(pinnedFetch(new URL(`http://x.invalid:${port}/`), {}, { addresses: [] }), /No validated address/);
  });
});

describe('pinnedFetch', () => {
  const pin = { addresses: [{ address: '127.0.0.1', family: 4 }] };

  test('sends method and body, asks for identity encoding', async () => {
    const response = await pinnedFetch(new URL(`http://localhost:${port}/echo`), { method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } }, pin);
    assert.deepEqual(await response.json(), { method: 'POST', body: 'hello', accept: 'identity' });
  });

  test('decodes a gzip body', async () => {
    const result = await fireRequest({
      connector: connector('127.0.0.1'),
      request: { path: '/gzip', mappings: [{ jsonPath: '$.name', variable: 'n' }] },
      network: { allow: ['127.0.0.1'] },
    });
    assert.equal(result.values.n, 'packed');
  });

  test('maxBytes counts decompressed bytes', async () => {
    const result = await fireRequest({
      connector: connector('127.0.0.1'),
      request: { path: '/bomb' },
      network: { allow: ['127.0.0.1'] },
      maxBytes: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /larger than 1000/);
  });

  test('handles a 204 without a body', async () => {
    const response = await pinnedFetch(new URL(`http://127.0.0.1:${port}/empty`), {}, pin);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });
});
