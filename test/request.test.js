import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, buildAuthHeaders, mapResponse } from '../src/request.js';

const connector = { baseUrl: 'https://api.example.com/', headers: [{ key: 'X-Lang', value: '{{lang}}' }] };

describe('buildRequest', () => {
  test('interpolates path, query and headers', () => {
    const built = buildRequest(connector, {
      method: 'get',
      path: 'v1/date/{{day}}',
      query: [{ key: 'cycles', value: 'false' }, { key: 'q', value: '{{text}}' }, { key: '', value: 'skipped' }],
    }, { day: '2026-10-11', lang: 'fi', text: 'a b&c' });
    assert.equal(built.method, 'GET');
    assert.equal(built.url.href, 'https://api.example.com/v1/date/2026-10-11?cycles=false&q=a+b%26c');
    assert.deepEqual(built.headers, { 'X-Lang': 'fi' });
    assert.equal(built.body, undefined);
  });

  test('sends a body with a default content type, but not on GET', () => {
    const post = buildRequest(connector, { method: 'POST', path: '/x', bodyType: 'json', body: '{"d":"{{day}}"}' }, { day: 'D' });
    assert.equal(post.body, '{"d":"D"}');
    assert.equal(post.headers['Content-Type'], 'application/json');
    const get = buildRequest(connector, { method: 'GET', path: '/x', bodyType: 'json', body: '{}' });
    assert.equal(get.body, undefined);
  });

  test('keeps a content type the connector already sets', () => {
    const c = { ...connector, headers: [{ key: 'content-type', value: 'application/vnd.x+json' }] };
    const post = buildRequest(c, { method: 'POST', path: '/x', bodyType: 'json', body: '{}' });
    assert.equal(post.headers['Content-Type'], undefined);
    assert.equal(post.headers['content-type'], 'application/vnd.x+json');
  });
});

describe('buildAuthHeaders', () => {
  test('bearer, api key, basic and custom', () => {
    assert.deepEqual(buildAuthHeaders({ type: 'bearer', token: 't-{{n}}' }, { n: '1' }), { Authorization: 'Bearer t-1' });
    assert.deepEqual(buildAuthHeaders({ type: 'api_key', headerName: 'X-Key', value: 'k' }), { 'X-Key': 'k' });
    assert.deepEqual(buildAuthHeaders({ type: 'basic', username: 'u', password: 'p' }), { Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` });
    assert.deepEqual(buildAuthHeaders({ type: 'custom', headers: { A: 'b' } }), { A: 'b' });
    assert.deepEqual(buildAuthHeaders({ type: 'none' }), {});
    assert.deepEqual(buildAuthHeaders(undefined), {});
  });

  test('auth headers override connector headers', () => {
    const c = { baseUrl: 'https://x.test', headers: [{ key: 'Authorization', value: 'old' }], auth: { type: 'bearer', token: 'new' } };
    assert.equal(buildRequest(c, { path: '/' }).headers.Authorization, 'Bearer new');
  });
});

describe('mapResponse', () => {
  const body = { day: { name: 'Pyhä', texts: { gospel: { reference: 'Matt. 22:1-14' } } }, list: [1, 2], none: null };

  test('maps paths to strings and JSON text', () => {
    assert.deepEqual(mapResponse([
      { jsonPath: '$.day.name', variable: 'nimi' },
      { jsonPath: '$.day.texts.gospel.reference', variable: 'evankeliumi' },
      { jsonPath: '$.list', variable: 'lista' },
    ], body), { nimi: 'Pyhä', evankeliumi: 'Matt. 22:1-14', lista: '[1,2]' });
  });

  test('skips unresolved paths unless skipIfNull is false', () => {
    assert.deepEqual(mapResponse([{ jsonPath: '$.missing', variable: 'a' }, { jsonPath: '$.none', variable: 'b' }], body), {});
    assert.deepEqual(mapResponse([{ jsonPath: '$.missing', variable: 'a', skipIfNull: false }], body), { a: null });
  });

  test('handles no mappings', () => {
    assert.deepEqual(mapResponse(undefined, body), {});
  });
});

describe('encodePathVariables', () => {
  const plain = { baseUrl: 'https://api.example.org' };
  test('off by default: a value can change the path', () => {
    const { url } = buildRequest(plain, { path: '/day/{{d}}' }, { d: '../admin?x=1' });
    assert.equal(url.pathname, '/admin');
  });
  test('on: the value stays one path segment', () => {
    const { url } = buildRequest(plain, { path: '/day/{{d}}' }, { d: '../admin?x=1' }, { encodePathVariables: true });
    assert.equal(url.pathname, '/day/..%2Fadmin%3Fx%3D1');
    assert.equal(url.search, '');
  });
});
