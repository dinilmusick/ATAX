import test from 'node:test';
import assert from 'node:assert/strict';
import { OperatorAuthStore, isSameOriginRequest } from './operatorAuth.ts';
import {
  VaultError,
  createVaultService,
  inspectSupabaseConnection,
  sanitizeVaultMessage,
  validateProviderInput,
} from './supabaseVault.ts';

test('OperatorAuthStore supports one-time claim, scrypt login, bearer verification, and revocation', () => {
  const store = new OperatorAuthStore();
  assert.equal(store.isClaimed(), false);

  const shortFail = store.claim('atax-owner', 'short');
  assert.equal(shortFail.ok, false);

  const claimed = store.claim('atax-owner', 'correct-horse-battery-staple');
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  assert.equal(store.isClaimed(), true);

  // Duplicate claim is rejected
  const dup = store.claim('other-user', 'another-long-passphrase-123');
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.status, 409);

  // Wrong passphrase fails
  const wrongLogin = store.login('wrong-passphrase-attempt');
  assert.equal(wrongLogin.ok, false);

  // Correct passphrase succeeds
  const okLogin = store.login('correct-horse-battery-staple');
  assert.equal(okLogin.ok, true);
  if (!okLogin.ok) return;

  const verified = store.verifyBearer(`Bearer ${okLogin.token}`);
  assert.ok(verified);
  assert.equal(verified.sub, 'atax-owner');

  // Tampered token fails
  assert.equal(store.verifyBearer(`Bearer ${okLogin.token}tamper`), null);

  // Revocation invalidates token immediately
  store.revokeBearer(`Bearer ${okLogin.token}`);
  assert.equal(store.verifyBearer(`Bearer ${okLogin.token}`), null);
});

test('isSameOriginRequest enforces matching origin and host', () => {
  assert.equal(
    isSameOriginRequest({ origin: 'https://atax.example.com', host: 'atax.example.com' }),
    true
  );
  assert.equal(
    isSameOriginRequest({ origin: 'https://evil.example.com', host: 'atax.example.com' }),
    false
  );
  assert.equal(isSameOriginRequest({ host: 'localhost:3000' }), true);
});

test('inspectSupabaseConnection validates ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY without leaking secrets', () => {
  assert.equal(inspectSupabaseConnection({}).configured, false);
  assert.equal(inspectSupabaseConnection({}).error, null);

  const partial = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://abc.supabase.co',
  });
  assert.equal(partial.configured, false);
  assert.ok(partial.error?.includes('ATAX_SUPABASE_SECRET_KEY'));

  const insecureScheme = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'http://abc.supabase.co',
    ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_0123456789abcdef',
  });
  assert.equal(insecureScheme.configured, false);
  assert.ok(insecureScheme.error?.includes('https://'));

  const badHost = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://evil.example.com',
    ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_0123456789abcdef',
  });
  assert.equal(badHost.configured, false);
  assert.ok(badHost.error?.includes('.supabase.co'));

  const embeddedCreds = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://user:pass@abc.supabase.co',
    ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_0123456789abcdef',
  });
  assert.equal(embeddedCreds.configured, false);
  assert.ok(embeddedCreds.error?.includes('credentials'));

  const badQuery = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://abc.supabase.co?foo=bar',
    ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_0123456789abcdef',
  });
  assert.equal(badQuery.configured, false);

  const badPath = inspectSupabaseConnection({
    ATAX_SUPABASE_URL: 'https://abc.supabase.co/rest/v1',
    ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_0123456789abcdef',
  });
  assert.equal(badPath.configured, false);

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

test('validateProviderInput accepts github, cloudflare, and vercel and enforces strict formats', () => {
  const gh = validateProviderInput({
    ownerSubject: 'atax-operator',
    provider: 'github',
    alias: 'personal',
    credential: 'ghp_1234567890abcdef123456',
    actorSubject: 'atax-operator',
    accountId: 'dinilmusick',
  });
  assert.equal(gh.provider, 'github');
  assert.equal(gh.alias, 'PERSONAL');

  const vc = validateProviderInput({
    ownerSubject: 'atax-operator',
    provider: 'vercel',
    alias: 'TEAM_PROD',
    credential: 'vercel_secret_token_123456',
    actorSubject: 'atax-operator',
  });
  assert.equal(vc.provider, 'vercel');

  assert.throws(() =>
    validateProviderInput({
      ownerSubject: 'atax-operator',
      provider: 'aws',
      alias: 'PROD',
      credential: '12345678901234567',
      actorSubject: 'atax-operator',
    })
  );

  assert.throws(() =>
    validateProviderInput({
      ownerSubject: 'atax-operator',
      provider: 'cloudflare',
      alias: '1BAD',
      credential: '12345678901234567',
      actorSubject: 'atax-operator',
    })
  );
});

test('createVaultService calls canonical Supabase PostgREST RPCs without leaking secrets', async () => {
  const secretKey = 'sb_secret_test_key_0123456789abcdef';
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  let ownerSubjectInSettings = 'old-owner';
  let enabledState = true;

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers || {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method || 'GET', headers, body });

    if (url.endsWith('/rest/v1/rpc/atax_mcp_runtime_config_v1')) {
      return Response.json({
        settings: { MCP_OWNER_SUBJECT: ownerSubjectInSettings, OTHER_SETTING: 'keep' },
        accounts: [
          {
            provider: 'github',
            alias: 'PERSONAL',
            token: 'ghp_super_secret_token_value',
          },
        ],
      });
    }
    if (url.endsWith('/rest/v1/rpc/atax_mcp_set_settings_v1')) {
      assert.equal(typeof body.settings_in, 'object');
      assert.equal(Array.isArray(body.settings_in), false);
      ownerSubjectInSettings = body.settings_in.MCP_OWNER_SUBJECT;
      return new Response(null, { status: 204 });
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
    ownerSubject: 'atax-operator',
    provider: 'github',
    alias: 'PERSONAL',
    credential: 'ghp_super_secret_token_value',
    actorSubject: 'atax-operator',
    accountId: 'dinilmusick',
  });
  assert.equal(saved.alias, 'PERSONAL');
  assert.equal(saved.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(ownerSubjectInSettings, 'atax-operator');

  const upsertCall = calls.find((c) => c.url.endsWith('/rest/v1/rpc/atax_mcp_upsert_provider_v1'));
  assert.ok(upsertCall);
  assert.equal(upsertCall.headers.apikey, secretKey);
  assert.equal(upsertCall.headers.Authorization, `Bearer ${secretKey}`);

  const list = await vault.listAccounts('atax-operator');
  assert.equal(list.length, 1);
  assert.equal('token' in (list[0] as unknown as Record<string, unknown>), false);

  await vault.setAccountEnabled('atax-operator', 'github', 'PERSONAL', false, 'atax-operator');
  assert.equal(enabledState, false);

  await vault.deleteAccount('atax-operator', 'github', 'PERSONAL', 'atax-operator');
  await assert.rejects(
    () => vault.deleteAccount('atax-operator', 'github', 'MISSING', 'atax-operator'),
    (err: unknown) => err instanceof VaultError && err.statusCode === 400 && err.message === 'Provider account not found'
  );

  const probe = await vault.testAccountConnection('atax-operator', 'github', 'PERSONAL');
  assert.equal(probe.ok, true);
  assert.equal(probe.summary, 'Verified GitHub account @dinilmusick');
  assert.equal(JSON.stringify(probe).includes('ghp_super_secret_token_value'), false);
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
    () => vault.listAccounts('atax-operator'),
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
    secretKey,
    baseUrl
  );
  assert.equal(scrubbed.includes(secretKey), false);
  assert.equal(scrubbed.includes(baseUrl), false);
  assert.equal(scrubbed.includes('abc.def.ghi'), false);
});
