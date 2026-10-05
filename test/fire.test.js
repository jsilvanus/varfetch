import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fireRequest } from '../src/fire.js';

let server;
let base;
const seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    if (req.url.startsWith('/day/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'Sunday', gospel: { ref: 'Matt. 22:1-14' }, date: req.url.slice(5) }));
    } else if (req.url === '/text') {
      res.setHeader('content-type', 'text/plain');
      res.end('plain');
    } else if (req.url === '/bad-json') {
      res.setHeader('content-type', 'application/json');
      res.end('{nope');
    } else if (req.url === '/redirect-internal') {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest');
      res.end();
    } else if (req.url === '/redirect-self') {
      res.statusCode = 302;
      res.setHeader('location', '/day/2026-01-01');
      res.end();
    } else if (req.url === '/loop') {
      res.statusCode = 302;
      res.setHeader('location', '/loop');
      res.end();
    } else if (req.url === '/big') {
      res.setHeader('content-type', 'text/plain');
      res.end('x'.repeat(2000));
    } else if (req.url === '/png') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
    } else if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 500);
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const network = () => ({ allow: [`127.0.0.1:${server.address().port}`] });
const connector = () => ({ baseUrl: base, auth: { type: 'bearer', token: 'secret' } });

describe('fireRequest', () => {
  test('fires the request and maps the response', async () => {
    const result = await fireRequest({
      connector: connector(),
      request: { path: '/day/{{paiva}}', mappings: [{ jsonPath: '$.name', variable: 'nimi' }, { jsonPath: '$.gospel.ref', variable: 'evankeliumi' }, { jsonPath: '$.date', variable: 'pvm' }] },
      variables: { paiva: '2026-10-11' },
      network: network(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.values, { nimi: 'Sunday', evankeliumi: 'Matt. 22:1-14', pvm: '2026-10-11' });
    assert.equal(seen.at(-1).headers.authorization, 'Bearer secret');
  });

  test('is blocked by the guard unless the address is allowed', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/day/x' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /private\/internal\/reserved/);
  });

  test('reports HTTP errors', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/missing' }, network: network() });
    assert.deepEqual([result.ok, result.status, result.error], [false, 404, 'HTTP 404']);
  });

  test('maps a text response with path $', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/text', mappings: [{ jsonPath: '$', variable: 'all' }] }, network: network() });
    assert.deepEqual(result.values, { all: 'plain' });
  });

  test('reports invalid JSON', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/bad-json' }, network: network() });
    assert.equal(result.ok, false);
    assert.match(result.error, /not valid JSON/);
  });

  test('follows a redirect inside the allowed target', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/redirect-self', mappings: [{ jsonPath: '$.name', variable: 'n' }] }, network: network() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.values, { n: 'Sunday' });
  });

  test('blocks a redirect to an internal address', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/redirect-internal' }, network: network() });
    assert.equal(result.ok, false);
    assert.match(result.error, /private\/internal\/reserved/);
  });

  test('stops redirect loops', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/loop' }, network: network() });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Too many redirects');
  });

  test('enforces the size limit', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/big' }, network: network(), maxBytes: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /larger than 1000/);
  });

  test('times out', async () => {
    const result = await fireRequest({ connector: connector(), request: { path: '/slow' }, network: network(), timeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.match(result.error, /Timed out after 50 ms/);
  });

  test('drops credentials on a cross-origin redirect', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: 'http://93.184.216.34/next' } })
        : new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    const result = await fireRequest({
      connector: { baseUrl: 'http://203.0.113.9', auth: { type: 'bearer', token: 'secret' }, headers: [{ key: 'X-Own', value: '1' }] },
      request: { path: '/start', mappings: [{ jsonPath: '$', variable: 'v' }] },
      fetch: fakeFetch,
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].headers.Authorization, 'Bearer secret');
    assert.deepEqual(calls[1].headers, {});
  });

  test('reports an invalid base URL', async () => {
    const result = await fireRequest({ connector: { baseUrl: 'not a url' }, request: { path: '/' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid request/);
  });
});

describe('fireRequest binary responses', () => {
  test('returns the bytes and content type for responseType binary', async () => {
    const result = await fireRequest({ connector: { baseUrl: base }, request: { path: '/png', responseType: 'image', mappings: [{ jsonPath: '$', variable: 'v' }] }, network: network() });
    assert.equal(result.ok, true);
    assert.equal(result.contentType, 'image/png');
    assert.ok(Buffer.isBuffer(result.body));
    assert.deepEqual([...result.body], [0x89, 0x50, 0x4e, 0x47, 0, 255]);
    assert.deepEqual(result.values, {});
  });

  test('binary responses obey maxBytes and the redirect guard', async () => {
    const big = await fireRequest({ connector: { baseUrl: base }, request: { path: '/big', responseType: 'binary' }, network: network(), maxBytes: 100 });
    assert.equal(big.ok, false);
    assert.match(big.error, /larger than/);
    const redirect = await fireRequest({ connector: { baseUrl: base }, request: { path: '/redirect-internal', responseType: 'binary' }, network: network() });
    assert.equal(redirect.ok, false);
  });
});
