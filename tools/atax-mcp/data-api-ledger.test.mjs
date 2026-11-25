import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDataApiConfig,
  parseSupabaseConfig,
  assertAllowedRpc,
  validateRpcParams,
  sanitizeErrorMessage,
  CANONICAL_RPC_ALLOWLIST,
  LedgerError,
} from './data-api-ledger.mjs';

test('only ATAX_SUPABASE_CONNECTION_URL is accepted', () => {
  const cfg = parseDataApiConfig({
    ATAX_SUPABASE_CONNECTION_URL:
      'postgresql://user:password@db.vcaerawuwffziufvpbvw.supabase.co/postgres?sslmode=require',
  });
  assert.equal(cfg.hostLabel,'db.vcaerawuwffziufvpbvw.supabase.co');
  assert.equal(parseSupabaseConfig,parseDataApiConfig);

  assert.throws(
    () => parseDataApiConfig({
      ATAX_SUPABASE_URL:'https://vcaerawuwffziufvpbvw.supabase.co',
      ATAX_SUPABASE_SECRET_KEY:'legacy-secret-value',
    }),
    (err) => err instanceof LedgerError && err.code==='CONFIG_ERROR'
  );
});

test('connection URI fails closed for non-PostgreSQL, untrusted host, or insecure query options', () => {
  const bad = [
    'https://vcaerawuwffziufvpbvw.supabase.co',
    'postgresql://u:p@evil.example.com/postgres?sslmode=require',
    'postgresql://u:p@db.vcaerawuwffziufvpbvw.supabase.co/postgres?sslmode=disable',
    'postgresql://u:p@db.vcaerawuwffziufvpbvw.supabase.co/postgres?application_name=bad',
  ];
  for (const value of bad) {
    assert.throws(() => parseDataApiConfig({ATAX_SUPABASE_CONNECTION_URL:value}), LedgerError);
  }
});

test('RPC dispatch is allowlisted and arguments are bounded', () => {
  assert.ok(CANONICAL_RPC_ALLOWLIST.has('atax_goal_claim_safe'));
  assert.throws(() => assertAllowedRpc('drop_database'));
  assert.equal(validateRpcParams({goal_key_in:'abc',priority_in:0.5}),JSON.stringify({goal_key_in:'abc',priority_in:0.5}));
  assert.throws(() => validateRpcParams(JSON.parse('{"__proto__":{"bad":true}}')));
  assert.throws(() => validateRpcParams(Object.fromEntries(Array.from({length:41},(_,i)=>['x'+i,i]))));
});

test('error sanitizer removes connection URIs and bearer credentials', () => {
  const raw='failed postgresql://user:pass@db.vcaerawuwffziufvpbvw.supabase.co/postgres Bearer abc.def.ghi https://db.supabase.co';
  const safe=sanitizeErrorMessage(raw);
  assert.equal(safe.includes('postgresql://'),false);
  assert.equal(safe.includes('Bearer abc.def.ghi'),false);
  assert.equal(safe.includes('https://db.supabase.co'),false);
});
