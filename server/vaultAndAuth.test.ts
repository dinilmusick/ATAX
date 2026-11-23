import test from 'node:test';
import assert from 'node:assert/strict';
import { OperatorAuthStore, isSameOriginRequest } from './operatorAuth.ts';
import {
  createVaultService,
  inspectSupabaseConnection,
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

test('inspectSupabaseConnection reads only ATAX_SUPABASE_CONNECTION_URL and masks credentials', () => {
  assert.equal(inspectSupabaseConnection({}).configured, false);

  const insecure = inspectSupabaseConnection({
    ATAX_SUPABASE_CONNECTION_URL: 'postgresql://postgres:secret@db.abc.supabase.co:5432/postgres?sslmode=disable',
  });
  assert.equal(insecure.configured, false);
  assert.ok(insecure.error?.includes('TLS'));

  const valid = inspectSupabaseConnection({
    ATAX_SUPABASE_CONNECTION_URL: 'postgresql://postgres:supersecret@db.abc.supabase.co:5432/postgres?sslmode=require',
  });
  assert.equal(valid.configured, true);
  assert.equal(valid.hostLabel, 'db.abc.supabase.co');
  assert.equal(valid.hostLabel?.includes('supersecret'), false);
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

test('createVaultService calls canonical Supabase Vault RPCs without leaking secrets', async () => {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const fakeRunner = {
    async unsafe(query: string, params: unknown[] = []) {
      calls.push({ query, params });
      if (query.includes('atax_mcp_runtime_config_v1')) {
        return [
          {
            cfg: {
              settings: { MCP_OWNER_SUBJECT: 'atax-operator' },
              accounts: [
                {
                  provider: 'github',
                  alias: 'PERSONAL',
                  token: 'ghp_super_secret_token_value',
                },
              ],
            },
          },
        ];
      }
      if (query.includes('atax_mcp_upsert_provider_v1')) {
        return [{ id: '11111111-1111-4111-8111-111111111111' }];
      }
      if (query.includes('atax_mcp_provider_summary_v1')) {
        return [
          {
            result: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                provider: 'github',
                alias: 'PERSONAL',
                accountId: 'dinilmusick',
                enabled: true,
                createdAt: '2026-11-23T00:00:00Z',
                updatedAt: '2026-11-23T00:00:00Z',
              },
            ],
          },
        ];
      }
      return [];
    },
  };

  const fakeFetch = (async () =>
    new Response(JSON.stringify({ login: 'dinilmusick' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  const vault = createVaultService(
    {
      ATAX_SUPABASE_CONNECTION_URL:
        'postgresql://postgres:secret@db.abc.supabase.co:5432/postgres?sslmode=require',
    },
    () => fakeRunner,
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
  assert.ok(calls.some((c) => c.query.includes('atax_mcp_upsert_provider_v1')));

  const list = await vault.listAccounts('atax-operator');
  assert.equal(list.length, 1);
  assert.equal('token' in (list[0] as unknown as Record<string, unknown>), false);

  const probe = await vault.testAccountConnection('atax-operator', 'github', 'PERSONAL');
  assert.equal(probe.ok, true);
  assert.equal(probe.summary, 'Verified GitHub account @dinilmusick');
  assert.equal(JSON.stringify(probe).includes('ghp_super_secret_token_value'), false);
});
