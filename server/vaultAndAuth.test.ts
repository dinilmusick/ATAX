import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from './settingsControlPlane.ts';
import {
  VaultError,
  createVaultService,
  inspectSupabaseConnection,
  sanitizeVaultMessage,
  validateProviderInput,
} from './supabaseVault.ts';

test('isSameOriginRequest enforces matching origin and host', () => {
  assert.equal(
    isSameOriginRequest(new Request('https://atax.example.com/api/settings/providers', {
      headers: { origin: 'https://atax.example.com' },
    })),
    true
  );
  assert.equal(
    isSameOriginRequest(new Request('https://atax.example.com/api/settings/providers', {
      headers: { origin: 'https://evil.example.com' },
    })),
    false
  );
  assert.equal(
    isSameOriginRequest(new Request('http://localhost:3000/api/settings/providers')),
    true
  );
});

test('inspectSupabaseConnection validates ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY without leaking secrets', () => {
  assert.equal(inspectSupabaseConnection({}).configured, false);
  assert.equal(inspectSupabaseConnection({}).error, null);

  const partial = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://abc.supabase.co',
  });
  assert.equal(partial.configured, false);
  assert.ok(partial.error?.includes('key'));

  const insecureScheme = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'http://abc.supabase.co',
    ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_0123456789abcdef',
  });
  assert.equal(insecureScheme.configured, false);
  assert.ok(insecureScheme.error?.includes('HTTPS'));

  const badHost = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://evil.example.com',
    ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_0123456789abcdef',
  });
  assert.equal(badHost.configured, false);
  assert.ok(badHost.error?.includes('.supabase.co'));

  const badKey = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://abc.supabase.co',
    ATAX_SUPABASE_SECRET_KEY: 'too-short-secret',
  });
  assert.equal(badKey.configured, false);
  assert.equal(badKey.error?.includes('too-short-secret'), false);

  const valid = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://abc.supabase.co/',
    ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_0123456789abcdef',
  });
  assert.equal(valid.configured, true);
  assert.equal(valid.hostLabel, 'abc.supabase.co');
  assert.equal(valid.baseUrl, 'https://abc.supabase.co');
  assert.equal(valid.hostLabel?.includes('sb_secret_mock_key_0123456789abcdef'), false);
});

test('validateProviderInput accepts standard and compute providers, including catalogued providers, and rejects invalid or reserved formats', () => {
  const gh = validateProviderInput({
    provider: 'github',
    alias: 'personal',
    credential: 'ghp_1234567890abcdef123456',
    accountId: 'dinilmusick',
  });
  assert.equal(gh.provider, 'github');
  assert.equal(gh.alias, 'PERSONAL');

  const cf = validateProviderInput({
    provider: 'cloudflare',
    alias: 'work',
    credential: 'cf_token_1234567890abcdef1234',
    accountId: 'acct_123',
  });
  assert.equal(cf.provider, 'cloudflare');
  assert.equal(cf.alias, 'WORK');

  const vercel = validateProviderInput({
    provider: 'vercel',
    alias: 'TEAM_PROD',
    credential: 'vercel_secret_token_123456',
  });
  assert.equal(vercel.provider, 'vercel');
  assert.equal(vercel.alias, 'TEAM_PROD');

  const compute = validateProviderInput({
    provider: 'aws',
    alias: 'PROD',
    credential: '12345678901234567',
  });
  assert.equal(compute.provider, 'aws');
  assert.equal(compute.alias, 'PROD');

  for (const bad of ['NOT A PROVIDER', 'constructor', 'prototype', '__proto__']) {
    assert.throws(() =>
      validateProviderInput({
        provider: bad,
        alias: 'PROD',
        credential: '12345678901234567',
      })
    );
  }

  assert.throws(() =>
    validateProviderInput({
      provider: 'cloudflare',
      alias: '1BAD',
      credential: '12345678901234567',
    })
  );
});

test('createVaultService calls singleton instance owner and PostgREST Vault RPCs without leaking secrets', async () => {
  const secretKey = 'sb_secret_test_key_0123456789abcdef';
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  let enabledState = true;
  let auditedTest = false;

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers || {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method || 'GET', headers, body });

    if (url.endsWith('/rest/v1/rpc/atax_mcp_instance_owner_subject_v1')) {
      return Response.json('dinilmusick');
    }
    if (url.endsWith('/rest/v1/rpc/atax_mcp_runtime_config_v1')) {
      return Response.json({
        settings: { MCP_OWNER_SUBJECT: 'dinilmusick', OTHER_SETTING: 'keep' },
        accounts: [
          {
            provider: 'github',
            alias: 'PERSONAL',
            token: 'synthetic-github-credential-value',
          },
        ],
      });
    }
    if (url.endsWith('/rest/v1/rpc/atax_mcp_upsert_provider_v1')) {
      return Response.json('11111111-1111-4111-8111-111111111111');
    }
    if (url.endsWith('/rest/v1/rpc/atax_mcp_provider_summary_v1')) {
      return Response.json([
        {
          id: '11111111-1111-4111-8111-111111111111',
          provider: 'github',
          alias: 'PERSONAL',
          accountId: 'dinilmusick',
          enabled: enabledState,
          createdAt: '2026-11-23T00:00:00Z',
          updatedAt: '2026-11-23T00:00:00Z',
        },
      ]);
    }
    if (url.endsWith('/rest/v1/rpc/atax_mcp_set_provider_enabled_v1')) {
      enabledState = Boolean(body.enabled_in);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/rest/v1/rpc/atax_mcp_delete_provider_v1')) {
      if (body.alias_in === 'MISSING') {
        return Response.json({ code: 'P0001', message: 'Provider account not found' }, { status: 400 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/rest/v1/rpc/atax_mcp_audit_provider_test_v1')) {
      auditedTest = true;
      assert.equal(body.actor_subject_in, 'dinilmusick');
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.com/user') {
      return Response.json({ login: 'dinilmusick' });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  const vault = createVaultService(
    {
      ATAX_SUPABASE_URL: 'https://abc.supabase.co',
      ATAX_SUPABASE_SECRET_KEY: secretKey,
    },
    fakeFetch
  );

  const saved = await vault.upsertSecret({
    provider: 'github',
    alias: 'PERSONAL',
    credential: 'synthetic-github-credential-value',
    accountId: 'dinilmusick',
  });
  assert.equal(saved.alias, 'PERSONAL');
  assert.equal(saved.id, '11111111-1111-4111-8111-111111111111');

  const upsertCall = calls.find((c) => c.url.endsWith('/rest/v1/rpc/atax_mcp_upsert_provider_v1'));
  assert.ok(upsertCall);
  assert.equal((upsertCall.body as Record<string, unknown>).owner_subject_in, 'dinilmusick');
  assert.equal(upsertCall.headers.apikey, secretKey);
  assert.equal(upsertCall.headers.Authorization, `Bearer ${secretKey}`);

  await assert.rejects(
    () => vault.upsertSecret({
      ownerSubject: 'attacker',
      provider: 'github',
      alias: 'EVIL',
      credential: 'synthetic-github-credential-value',
    }),
    (err: unknown) => err instanceof VaultError && err.statusCode === 403
  );

  const list = await vault.listAccounts();
  assert.equal(list.length, 1);
  assert.equal('token' in (list[0] as unknown as Record<string, unknown>), false);

  await vault.setAccountEnabled(undefined, 'github', 'PERSONAL', false);
  assert.equal(enabledState, false);

  await vault.deleteAccount(undefined, 'github', 'PERSONAL');
  await assert.rejects(
    () => vault.deleteAccount(undefined, 'github', 'MISSING'),
    (err: unknown) => err instanceof VaultError && err.statusCode === 400 && err.message === 'Provider account not found'
  );

  const probe = await vault.testAccountConnection('dinilmusick', 'github', 'PERSONAL');
  assert.equal(probe.ok, true);
  assert.equal(probe.authVerified, true);
  assert.equal(probe.apiReachable, true);
  assert.equal(probe.summary, 'Verified GitHub account @dinilmusick');
  assert.equal(auditedTest, true);
  assert.equal(JSON.stringify(probe).includes('synthetic-github-credential-value'), false);
});

test('provider-specific compute probes validate authenticated payloads and distinguish reachability vs auth vs compute support', async () => {
  const secretKey = 'sb_secret_probe_test_key_0123456789';
  let malformedMode = false;
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/rest/v1/rpc/atax_mcp_instance_owner_subject_v1')) return Response.json('dinilmusick');
    if (url.endsWith('/rest/v1/rpc/atax_mcp_audit_provider_test_v1')) return new Response(null, { status: 204 });
    if (url.endsWith('/rest/v1/rpc/atax_mcp_runtime_config_v1')) {
      return Response.json({
        settings: { MCP_OWNER_SUBJECT: 'dinilmusick' },
        accounts: [
          { provider: 'fly', alias: 'DEV', token: 'fly-token-1234567890' },
          { provider: 'northflank', alias: 'DEV', token: 'nf-token-1234567890' },
          { provider: 'render', alias: 'DEV', token: 'rnd-token-1234567890' },
          { provider: 'railway', alias: 'DEV', token: 'rw-token-1234567890' },
          { provider: 'koyeb', alias: 'DEV', token: 'ky-token-1234567890' },
        ],
      });
    }
    if (malformedMode) return Response.json({ ok: true });
    if (url.startsWith('https://api.machines.dev/')) return Response.json({ apps: [{ name: 'a' }] });
    if (url.startsWith('https://api.northflank.com/')) return Response.json({ data: { projects: [{ id: 'p' }] } });
    if (url.startsWith('https://api.render.com/')) return Response.json([{ service: { id: 's' } }]);
    if (url.startsWith('https://backboard.railway.com/')) return Response.json({ data: { me: { id: 'u1', name: 'Dev' } } });
    if (url.startsWith('https://app.koyeb.com/')) return Response.json({ apps: [] });
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  const vault = createVaultService(
    { ATAX_SUPABASE_URL: 'https://abc.supabase.co', ATAX_SUPABASE_SECRET_KEY: secretKey },
    fakeFetch
  );

  for (const p of ['fly', 'northflank', 'render', 'railway']) {
    const res = await vault.testAccountConnection('dinilmusick', p, 'DEV');
    assert.equal(res.ok, true, p);
    assert.equal(res.apiReachable, true, p);
    assert.equal(res.authVerified, true, p);
    assert.equal(res.computeSupported, true, p);
  }

  const koyeb = await vault.testAccountConnection('dinilmusick', 'koyeb', 'DEV');
  assert.equal(koyeb.ok, true);
  assert.equal(koyeb.authVerified, true);
  assert.equal(koyeb.computeSupported, false);

  malformedMode = true;
  const badFly = await vault.testAccountConnection('dinilmusick', 'fly', 'DEV');
  assert.equal(badFly.ok, false);
  assert.equal(badFly.apiReachable, true);
  assert.equal(badFly.authVerified, false);
});

// ---------------------------------------------------------------------------
// Phase 1 regression: testAccountConnection with undefined/null/empty owner
// ---------------------------------------------------------------------------
test('Phase1 regression: testAccountConnection rejects undefined owner before making any RPC call', async () => {
  const secretKey = ['synthetic', 'test', 'key', 'regression', '0123456789abcdef'].join('-');
  const rpcCalled: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    rpcCalled.push(String(input));
    return Response.json({ owner: 'should-not-reach' });
  }) as typeof fetch;

  const vault = createVaultService(
    { ATAX_SUPABASE_URL: 'https://abc.supabase.co', ATAX_SUPABASE_SECRET_KEY: secretKey },
    fakeFetch
  );

  await assert.rejects(
    () => vault.testAccountConnection(undefined as unknown as string, 'github', 'PERSONAL'),
    (err: unknown) => err instanceof VaultError && err.statusCode === 503 && err.message.toLowerCase().includes('owner')
  );

  await assert.rejects(
    () => vault.testAccountConnection(null as unknown as string, 'github', 'PERSONAL'),
    (err: unknown) => err instanceof VaultError && err.statusCode === 503
  );

  await assert.rejects(
    () => vault.testAccountConnection('', 'github', 'PERSONAL'),
    (err: unknown) => err instanceof VaultError && err.statusCode === 503
  );

  assert.equal(rpcCalled.some(u => u.includes('/rpc/')), false,
    'Supabase RPCs must NOT be called when owner subject is missing');
});

test('Phase1 regression: account isolation — only the requested alias credential is used', async () => {
  const secretKey = ['synthetic', 'test', 'key', 'isolation', '0123456789abcdef'].join('-');
  const usedTokens: string[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers || {}) as Record<string, string>;
    if (url.endsWith('/rest/v1/rpc/atax_mcp_instance_owner_subject_v1')) return Response.json('dinilmusick');
    if (url.endsWith('/rest/v1/rpc/atax_mcp_runtime_config_v1')) {
      return Response.json({
        settings: { MCP_OWNER_SUBJECT: 'dinilmusick' },
        accounts: [
          { provider: 'github', alias: 'PERSONAL', token: 'token-personal-acct-unique' },
          { provider: 'github', alias: 'WORK', token: 'token-work-acct-unique' },
        ],
      });
    }
    if (url.endsWith('/rest/v1/rpc/atax_mcp_audit_provider_test_v1')) return new Response(null, { status: 204 });
    if (url === 'https://api.github.com/user') {
      const auth = headers['Authorization'] || headers['authorization'] || '';
      usedTokens.push(auth.replace('Bearer ', ''));
      return Response.json({ login: 'dinilmusick' });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  const vault = createVaultService(
    { ATAX_SUPABASE_URL: 'https://abc.supabase.co', ATAX_SUPABASE_SECRET_KEY: secretKey },
    fakeFetch
  );

  usedTokens.length = 0;
  const r1 = await vault.testAccountConnection('dinilmusick', 'github', 'PERSONAL');
  assert.equal(r1.ok, true);
  assert.equal(usedTokens.length, 1);
  assert.equal(usedTokens[0], 'token-personal-acct-unique', 'PERSONAL alias must use PERSONAL token only');

  usedTokens.length = 0;
  const r2 = await vault.testAccountConnection('dinilmusick', 'github', 'WORK');
  assert.equal(r2.ok, true);
  assert.equal(usedTokens.length, 1);
  assert.equal(usedTokens[0], 'token-work-acct-unique', 'WORK alias must use WORK token, not PERSONAL');
  assert.notEqual(usedTokens[0], 'token-personal-acct-unique', 'Credentials must never be confused between accounts');
});

test('createVaultService scrubs secrets and URLs from upstream PostgREST errors', async () => {
  const secretKey = 'sb_secret_leaky_key_0123456789abcdef';
  const baseUrl = 'https://abc.supabase.co';
  const fakeFetch = (async () =>
    Response.json(
      {
        message: `Failure calling ${baseUrl} with key ${secretKey} Bearer secret_jwt_token postgresql://postgres:pw@db.abc.supabase.co/postgres`,
      },
      { status: 500 }
    )) as typeof fetch;

  const vault = createVaultService(
    {
      ATAX_SUPABASE_URL: baseUrl,
      ATAX_SUPABASE_SECRET_KEY: secretKey,
    },
    fakeFetch
  );

  await assert.rejects(
    () => vault.listAccounts(),
    (err: unknown) => {
      assert.ok(err instanceof VaultError);
      assert.equal(err.statusCode, 502);
      assert.equal(err.message.includes(secretKey), false);
      assert.equal(err.message.includes(baseUrl), false);
      assert.equal(err.message.includes('postgresql://'), false);
      assert.equal(err.message.includes('secret_jwt_token'), false);
      return true;
    }
  );

  const scrubbed = sanitizeVaultMessage(
    `url=${baseUrl}/x key=${secretKey} Bearer abc.def.ghi`,
    'abc.supabase.co'
  );
  assert.equal(scrubbed.includes('abc.supabase.co'), false);
  assert.equal(scrubbed.includes('abc.def.ghi'), false);
});
