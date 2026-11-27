import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationTools} from './verification-tools.mjs';

const owner = {id: 'owner', authMethod: 'shared'};
const find = name => verificationTools.find(t => t.name === name);
const invoke = (name, args, fetcher) => find(name).invoke(args, null, owner, {env: {}, fetcher});

test('atax_npm_package_inspect resolves scoped package exact version and dist.integrity', async () => {
  const seen = [];
  const fetcher = async (url, opts) => {
    seen.push({url, opts});
    if (url === 'https://registry.npmjs.org/@ultrst-armada/kloks/3.0.25') {
      return Response.json({
        name: '@ultrst-armada/kloks',
        version: '3.0.25',
        dist: {
          integrity: 'sha512-H48mh8nwSDsg29YjglM18JtKmpgXGbFSBkQjHlJxhN6XeVuYWHXSUcANMkbKJgPBRh06k4OBOUHVJN1SaH28mA==',
          shasum: 'abc123',
          tarball: 'https://registry.npmjs.org/@ultrst-armada/kloks/-/kloks-3.0.25.tgz',
        },
        dependencies: {zod: '^3.24.0'},
      });
    }
    return new Response('Not Found', {status: 404});
  };
  const res = await invoke('atax_npm_package_inspect', {package_name: '@ultrst-armada/kloks', version: '3.0.25'}, fetcher);
  assert.equal(res.package_name, '@ultrst-armada/kloks');
  assert.equal(res.version, '3.0.25');
  assert.equal(res.dist.integrity, 'sha512-H48mh8nwSDsg29YjglM18JtKmpgXGbFSBkQjHlJxhN6XeVuYWHXSUcANMkbKJgPBRh06k4OBOUHVJN1SaH28mA==');
  assert.deepEqual(res.dependencies, {zod: '^3.24.0'});
  await assert.rejects(invoke('atax_npm_package_inspect', {package_name: '../bad'}, fetcher), /Invalid npm package_name/);
  await assert.rejects(invoke('atax_npm_package_inspect', {package_name: 'lodash', version: 'bad/ver'}, fetcher), /Invalid npm package version/);
});

test('atax_npm_package_inspect resolves latest dist-tag from packument', async () => {
  const fetcher = async url => {
    assert.equal(url, 'https://registry.npmjs.org/@ultrst-armada/floks');
    return Response.json({
      name: '@ultrst-armada/floks',
      'dist-tags': {latest: '2.0.22'},
      versions: {
        '2.0.22': {
          name: '@ultrst-armada/floks',
          version: '2.0.22',
          dist: {integrity: 'sha512-test=='},
        },
      },
      time: {'2.0.22': '2026-11-27T18:39:00.000Z'},
    });
  };
  const res = await invoke('atax_npm_package_inspect', {package_name: '@ultrst-armada/floks'}, fetcher);
  assert.equal(res.version, '2.0.22');
  assert.equal(res.dist.integrity, 'sha512-test==');
  assert.equal(res.published_at, '2026-11-27T18:39:00.000Z');
});

test('atax_http_probe inspects public HTTPS endpoints and blocks private/loopback URLs', async () => {
  const fetcher = async (url, opts) => {
    assert.equal(opts.redirect, 'manual');
    assert.equal(opts.headers.authorization, undefined);
    return new Response(JSON.stringify({ok: true, service: 'luth'}), {
      status: 200,
      headers: {'content-type': 'application/json', 'cf-ray': '12345-IAD'},
    });
  };
  const res = await invoke('atax_http_probe', {
    url: 'https://luth.blueprint-ninjastudios.workers.dev/health',
    headers: {Authorization: 'Bearer secret', 'X-Probe': '1'},
  }, fetcher);
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.deepEqual(res.json, {ok: true, service: 'luth'});
  assert.equal(res.headers['cf-ray'], '12345-IAD');
  await assert.rejects(invoke('atax_http_probe', {url: 'https://127.0.0.1/health'}, fetcher), /Private or loopback/);
  await assert.rejects(invoke('atax_http_probe', {url: 'http://example.com/health'}, fetcher), /Only public HTTPS/);
});
