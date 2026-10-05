import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrlAllowed, parsePattern } from '../src/network-guard.js';

// Literal IPs only, so no real DNS resolution is needed.
const ok = (url, options) => checkUrlAllowed(new URL(url), options);

describe('default restricted ranges', () => {
  test('blocks loopback, metadata and RFC1918', async () => {
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '172.16.0.5', '172.31.255.254', '192.168.1.1', '100.64.0.1']) {
      const result = await ok(`http://${host}/`);
      assert.equal(result.allowed, false, `expected ${host} to be blocked`);
    }
  });

  test('blocks IPv6 loopback, unique-local and mapped loopback', async () => {
    for (const host of ['[::1]', '[fc00::1]', '[::ffff:127.0.0.1]']) {
      assert.equal((await ok(`http://${host}/`)).allowed, false, host);
    }
  });

  test('allows a public IP', async () => {
    assert.equal((await ok('http://93.184.216.34/')).allowed, true);
  });

  test('blocks other schemes', async () => {
    assert.equal((await ok('file:///etc/passwd')).allowed, false);
    assert.equal((await ok('ftp://93.184.216.34/')).allowed, false);
  });

  test('blocks a host that does not resolve', async () => {
    const lookup = async () => { throw new Error('ENOTFOUND'); };
    const result = await ok('http://nowhere.example/', { lookup });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Could not resolve/);
  });

  test('blocks a public-looking name that resolves to a private address', async () => {
    const lookup = async () => [{ address: '10.1.2.3', family: 4 }];
    assert.equal((await ok('http://looks-public.example/', { lookup })).allowed, false);
  });
});

describe('allow and deny patterns', () => {
  test('allow lets a private IP through, with or without port', async () => {
    assert.equal((await ok('http://127.0.0.1:11434/', { allow: ['127.0.0.1:11434'] })).allowed, true);
    assert.equal((await ok('http://127.0.0.1:9999/', { allow: ['127.0.0.1:11434'] })).allowed, false);
    assert.equal((await ok('http://127.0.0.1:9999/', { allow: ['127.0.0.1'] })).allowed, true);
  });

  test('allow by CIDR and by hostname', async () => {
    assert.equal((await ok('http://10.2.3.4/', { allow: ['10.0.0.0/8'] })).allowed, true);
    const lookup = async () => [{ address: '10.2.3.4', family: 4 }];
    assert.equal((await ok('http://anno.internal/', { allow: ['*.internal'], lookup })).allowed, true);
    assert.equal((await ok('http://anno.internal/', { allow: ['other.internal'], lookup })).allowed, false);
  });

  test('deny wins over allow and blocks public hosts', async () => {
    const options = { allow: ['10.0.0.0/8'], deny: ['10.9.9.9'] };
    assert.equal((await ok('http://10.9.9.9/', options)).allowed, false);
    assert.equal((await ok('http://93.184.216.34/', { deny: ['93.184.216.34'] })).allowed, false);
  });
});

describe('parsePattern', () => {
  test('parses hosts, ips, cidrs and ports', () => {
    assert.deepEqual(parsePattern('api.example.com:8443'), { kind: 'host', value: 'api.example.com', port: 8443 });
    assert.deepEqual(parsePattern('127.0.0.1'), { kind: 'ip', value: '127.0.0.1', port: null });
    assert.deepEqual(parsePattern('10.0.0.0/8'), { kind: 'cidr', value: '10.0.0.0/8', port: null });
    assert.deepEqual(parsePattern('[::1]:11434'), { kind: 'ip', value: '::1', port: 11434 });
  });
});
