import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createHandler as createRuntimeHandler } from './worker.mjs';

const issuer = 'https://issuer.example/oauth';
const resource = 'https://atax.example/mcp';
const keyPair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pub = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
pub.kid = 'gh-branch-pr-key';
pub.alg = 'EdDSA';

const b64 = (d) => Buffer.from(d).toString('base64url');
async function makeJwt(sub = 'owner-1') {
  const hdr = b64(JSON.stringify({ typ: 'at+jwt', alg: 'EdDSA', kid: pub.kid }));
  const pay = b64(JSON.stringify({ iss: issuer, aud: resource, sub, scope: 'openid', exp: Math.floor(Date.now() / 1000) + 300 }));
  const sig = await webcrypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, new TextEncoder().encode(hdr + '.' + pay));
  return hdr + '.' + pay + '.' + b64(sig);
}

const env = {
  MCP_AUTH_JWKS_URL: 'https://issuer.example/oauth/jwks',
  MCP_AUTH_AUTHORIZATION_SERVER: issuer,
  MCP_AUTH_ISSUER: issuer,
  MCP_AUTH_AUDIENCE: resource,
  MCP_ATAX_OWNER_JWT_SUBJECT: 'owner-1',
  MCP_AUTH_OWNER_SCOPES: 'atax:read atax:write atax:github:read atax:github:create',
  MCP_SHARED_TOKEN_SHA256: '',
  MCP_GITHUB_OWNER: 'dinilmusick',
  GH_KEY_DINILMUSICK: 'gh-token-test-1234567890',
};

test('ATAX MCP branch create/delete, PR list/merge, and file delete', async () => {
  const calls = [];
  const baseSha = 'a'.repeat(40);
  const fetcher = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url === 'https://issuer.example/oauth/jwks') return Response.json({ keys: [pub] });
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/ref/heads/main') {
      return Response.json({ ref: 'refs/heads/main', object: { sha: baseSha } });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/refs' && options.method === 'POST') {
      return Response.json({ ref: 'refs/heads/feat/test-branch', object: { sha: baseSha } }, { status: 201 });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko' && (!options.method || options.method === 'GET')) {
      return Response.json({ full_name: 'dinilmusick/Aiko', html_url: 'https://github.com/dinilmusick/Aiko', private: true, default_branch: 'main' });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/refs/heads/feat%2Ftest-branch' && options.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/pulls?state=open&per_page=30') {
      return Response.json([{ number: 99, title: 'Fix OAuth', state: 'open', draft: false, head: { ref: 'feat/test-branch', sha: baseSha }, base: { ref: 'main' }, html_url: 'https://github.com/dinilmusick/Aiko/pull/99' }]);
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/pulls/99/merge' && options.method === 'PUT') {
      return Response.json({ merged: true, sha: 'b'.repeat(40), message: 'Pull Request successfully merged' });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/contents/old.ts' && options.method === 'DELETE') {
      return Response.json({ commit: { sha: 'c'.repeat(40), html_url: 'https://github.com/dinilmusick/Aiko/commit/' + 'c'.repeat(40) } });
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const handler = createRuntimeHandler(fetcher, async (e) => ({ ...e, __ledgerDb: { rpc: async () => ({ ok: true }) } }));
  const callTool = async (name, args) => {
    const tok = await makeJwt('owner-1');
    const req = new Request(resource, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await handler(req, env)).json();
  };

  const created = await callTool('atax_github_branch_create', { repository: 'dinilmusick/Aiko', branch: 'feat/test-branch', base: 'main' });
  assert.equal(created.result.isError, undefined);
  assert.equal(created.result.structuredContent.result.branch, 'feat/test-branch');
  assert.equal(created.result.structuredContent.result.sha, baseSha);

  const listed = await callTool('atax_github_pull_request_list', { repository: 'dinilmusick/Aiko', state: 'open' });
  assert.equal(listed.result.structuredContent.result.pull_requests[0].number, 99);

  const merged = await callTool('atax_github_pull_request_merge', { repository: 'dinilmusick/Aiko', pull_number: 99, merge_method: 'squash' });
  assert.equal(merged.result.structuredContent.result.merged, true);

  const deletedFile = await callTool('atax_github_file_delete', { repository: 'dinilmusick/Aiko', path: 'old.ts', message: 'Remove old.ts', sha: baseSha, branch: 'feat/test-branch' });
  assert.equal(deletedFile.result.structuredContent.result.operation, 'file_delete');

  const refusedMain = await callTool('atax_github_branch_delete', { repository: 'dinilmusick/Aiko', branch: 'main' });
  assert.equal(refusedMain.result.isError, true);

  const deletedBranch = await callTool('atax_github_branch_delete', { repository: 'dinilmusick/Aiko', branch: 'feat/test-branch' });
  assert.equal(deletedBranch.result.structuredContent.result.deleted, true);
});

test('ATAX MCP PR merge falls back to branch merge on 403/405', async () => {
  const headSha = 'd'.repeat(40);
  const mergeSha = 'e'.repeat(40);
  const fetcher = async (url, options = {}) => {
    if (url === 'https://issuer.example/oauth/jwks') return Response.json({ keys: [pub] });
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/pulls/12/merge' && options.method === 'PUT') {
      return Response.json({ message: 'Resource not accessible by personal access token' }, { status: 403 });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/pulls/12' && (!options.method || options.method === 'GET')) {
      return Response.json({ number: 12, title: 'Finish app', state: 'open', head: { ref: 'feat/x', sha: headSha }, base: { ref: 'main' } });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/merges' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.base, 'main');
      assert.equal(body.head, headSha);
      return Response.json({ sha: mergeSha, commit: { message: body.commit_message } }, { status: 201 });
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const handler = createRuntimeHandler(fetcher, async (e) => ({ ...e, __ledgerDb: { rpc: async () => ({ ok: true }) } }));
  const tok = await makeJwt('owner-1');
  const req = new Request(resource, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'atax_github_pull_request_merge', arguments: { repository: 'dinilmusick/Aiko', pull_number: 12, sha: headSha } } }),
  });
  const res = await (await handler(req, env)).json();
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.structuredContent.result.merged, true);
  assert.equal(res.result.structuredContent.result.sha, mergeSha);
  assert.equal(res.result.structuredContent.result.fallback, 'branch_merge');
});

test('ATAX MCP branch merge resolves 409 conflicts with 2-parent Git Data commit', async () => {
  const baseSha = '1'.repeat(40);
  const headSha = '2'.repeat(40);
  const treeSha = '3'.repeat(40);
  const newTreeSha = '4'.repeat(40);
  const blobSha = '5'.repeat(40);
  const mergeSha = '6'.repeat(40);
  const fetcher = async (url, options = {}) => {
    if (url === 'https://issuer.example/oauth/jwks') return Response.json({ keys: [pub] });
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/merges' && options.method === 'POST') {
      return Response.json({ message: 'Merge conflict' }, { status: 409 });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/ref/heads/feat%2Fx') {
      return Response.json({ ref: 'refs/heads/feat/x', object: { sha: baseSha } });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/ref/heads/main') {
      return Response.json({ ref: 'refs/heads/main', object: { sha: headSha } });
    }
    if (url === `https://api.github.com/repos/dinilmusick/Aiko/git/commits/${baseSha}`) {
      return Response.json({ sha: baseSha, tree: { sha: treeSha } });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/blobs' && options.method === 'POST') {
      return Response.json({ sha: blobSha }, { status: 201 });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/trees' && options.method === 'POST') {
      return Response.json({ sha: newTreeSha }, { status: 201 });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/commits' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.parents, [baseSha, headSha]);
      return Response.json({ sha: mergeSha }, { status: 201 });
    }
    if (url === 'https://api.github.com/repos/dinilmusick/Aiko/git/refs/heads/feat%2Fx' && options.method === 'PATCH') {
      return Response.json({ ref: 'refs/heads/feat/x', object: { sha: mergeSha } });
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const handler = createRuntimeHandler(fetcher, async (e) => ({ ...e, __ledgerDb: { rpc: async () => ({ ok: true }) } }));
  const tok = await makeJwt('owner-1');
  const req = new Request(resource, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'atax_github_branch_merge', arguments: { repository: 'dinilmusick/Aiko', base: 'feat/x', head: 'main', resolved_files: { 'package.json': '{"name":"aiko"}\n' } } } }),
  });
  const res = await (await handler(req, env)).json();
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.structuredContent.result.merged, true);
  assert.equal(res.result.structuredContent.result.sha, mergeSha);
  assert.deepEqual(res.result.structuredContent.result.parents, [baseSha, headSha]);
});
