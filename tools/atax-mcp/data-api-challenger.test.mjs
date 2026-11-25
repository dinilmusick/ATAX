import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowedRpc,
  parseDataApiConfig,
  validateRpcParams,
  sanitizeErrorMessage,
  CANONICAL_RPC_ALLOWLIST,
  LedgerError,
} from './data-api-ledger.mjs';

const VALID_ENV = {
  ATAX_SUPABASE_CONNECTION_URL:
    'postgresql://user:password@db.vcaerawuwffziufvpbvw.supabase.co/postgres?sslmode=require',
};

test('non-allowlisted RPC names are rejected before transport', () => {
  const invalid = [
    'drop_database',
    'pg_catalog.pg_tables',
    'atax_context_snapshot; DROP TABLE goals;',
    '../../../etc/passwd',
    '__proto__',
    'constructor',
    '',
    ' atax_context_snapshot',
    'atax_context_snapshot ',
    'ATAX_CONTEXT_SNAPSHOT',
    'a'.repeat(2000),
    null,
    undefined,
    12345,
    true,
    {},
    [],
  ];
  for (const name of invalid) {
    assert.throws(
      () => assertAllowedRpc(name),
      err => err instanceof LedgerError && err.code === 'RPC_NOT_ALLOWED' && err.status === 400
    );
  }
});

test('canonical RPC allowlist is non-empty and contains core substrate operations', () => {
  assert.ok(CANONICAL_RPC_ALLOWLIST.has('agent_context_overview'));
  assert.ok(CANONICAL_RPC_ALLOWLIST.has('task_ledger_claim_next'));
  assert.ok(CANONICAL_RPC_ALLOWLIST.has('atax_mcp_runtime_config_v1'));
  assert.ok(CANONICAL_RPC_ALLOWLIST.has('atax_mcp_verify_instance_passkey_v1'));
});

test('malformed parameter keys and prototype-pollution keys are rejected', () => {
  const keys = [
    'UpperCase','camelCase','ALLCAPS','_leading_underscore','__double_leading',
    'space inside',' leading_space','trailing_space ','tab\tkey','newline\nkey',
    'dash-key','dot.key','slash/key','backslash\\key','dollar$key','hash#key',
    '0starts_with_number','',
  ];
  for (const key of keys) {
    assert.throws(
      () => validateRpcParams({[key]:'value'}),
      err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS'
    );
  }

  for (const key of ['__proto__','constructor','prototype']) {
    assert.throws(() => validateRpcParams(JSON.parse(`{"${key}":"malicious"}`)), LedgerError);
    assert.throws(() => validateRpcParams({safe_key:JSON.parse(`{"${key}":"malicious"}`)}), LedgerError);
    assert.throws(() => validateRpcParams({items:[JSON.parse(`{"${key}":"malicious"}`)]}), LedgerError);
  }
});

test('non-serializable, cyclic, and excessive-depth values fail closed', () => {
  for (const value of [NaN,Infinity,-Infinity,undefined,123n,()=>{},Symbol('x')]) {
    assert.throws(() => validateRpcParams({value}), err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS');
  }

  const cyclic={name:'root'};
  cyclic.self=cyclic;
  assert.throws(() => validateRpcParams({payload:cyclic}), /Cyclic reference rejected/);

  let deep={leaf:true};
  for (let i=0;i<20;i++) deep={next:deep};
  assert.throws(() => validateRpcParams({root:deep}), /recursion depth exceeded/i);

  const shared={leaf:'ok'};
  assert.doesNotThrow(() => validateRpcParams({a:{ref:shared},b:{ref:shared}}));
});

test('parameter count and byte-size caps are enforced', () => {
  const exactly40=Object.fromEntries(Array.from({length:40},(_,i)=>[`key_${i}`,i]));
  assert.doesNotThrow(() => validateRpcParams(exactly40));
  const exactly41={...exactly40,key_extra:'overflow'};
  assert.throws(() => validateRpcParams(exactly41), /parameter count exceeds limit/i);

  assert.throws(() => validateRpcParams({data:'x'.repeat(1_049_000)}), /payload too large/i);
  assert.throws(() => validateRpcParams({data:'🔥'.repeat(300_000)}), /payload too large/i);
});

test('PostgreSQL runtime configuration rejects legacy HTTP variables and unsafe URIs', () => {
  assert.throws(() => parseDataApiConfig({ATAX_SUPABASE_URL:'https://example.supabase.co'}), LedgerError);
  assert.throws(() => parseDataApiConfig({ATAX_SUPABASE_SECRET_KEY:'legacy-secret'}), LedgerError);

  const unsafe = [
    'https://db.vcaerawuwffziufvpbvw.supabase.co/postgres',
    'postgresql://u:p@evil.example.com/postgres?sslmode=require',
    'postgresql://u:p@db.vcaerawuwffziufvpbvw.supabase.co/postgres?sslmode=disable',
    'postgresql://u:p@db.vcaerawuwffziufvpbvw.supabase.co/postgres?token=123',
  ];
  for (const connectionString of unsafe) {
    assert.throws(() => parseDataApiConfig({ATAX_SUPABASE_CONNECTION_URL:connectionString}), LedgerError);
  }

  assert.deepEqual(parseDataApiConfig(VALID_ENV).hostLabel,'db.vcaerawuwffziufvpbvw.supabase.co');
});

test('error sanitization removes connection credentials, bearer tokens, URLs, and JWTs', () => {
  const jwt='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.supersecret.signature';
  const raw=[
    'postgresql://user:password@db.vcaerawuwffziufvpbvw.supabase.co/postgres',
    'Bearer super-secret-bearer',
    'https://internal.example.test/path',
    jwt,
  ].join(' ');
  const safe=sanitizeErrorMessage(raw);
  assert.equal(safe.includes('postgresql://'),false);
  assert.equal(safe.includes('Bearer super-secret-bearer'),false);
  assert.equal(safe.includes('https://internal.example.test'),false);
  assert.equal(safe.includes(jwt),false);
});

test('credential strings are not reflected by error sanitization', () => {
  const secret='Bearer this-is-a-provider-secret-value';
  assert.equal(sanitizeErrorMessage(`invalid credential ${secret}`).includes(secret),false);
});
