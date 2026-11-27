/**
 * tools/atax-mcp/data-api-ledger.test.mjs
 * Comprehensive unit test suite for the pure HTTPS PostgREST Data API ledger adapter.
 * Verifies configuration parsing, canonical RPC allowlist enforcement, parameter checking,
 * client initialization, mock fetcher dispatch, response handling, error mapping,
 * timeout/network handling, credential scrubbing, and specialized helper methods.
 *
 * Zero external npm dependencies — built exclusively with node:test and node:assert/strict.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDataApiConfig,
  parseSupabaseConfig,
  assertAllowedRpc,
  validateRpcParams,
  createLedgerDb,
  openLedger,
  openControlPlaneLedger,
  mapPostgrestError,
  sanitizeErrorMessage,
  CANONICAL_RPC_ALLOWLIST,
  INSTANCE_CONTROL_PLANE_RPCS,
  ALLOWED_RPCS,
  PARAM_KEY_REGEX,
  LedgerError,
} from './data-api-ledger.mjs';

const VALID_ENV = {
  ATAX_SUPABASE_URL: 'https://vcaerawuwffziufvpbvw.supabase.co',
  ATAX_SUPABASE_SECRET_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.abcdefghijklmnopqrstuvwxyz1234567890',
};

const CANARY_SECRET = 'SUPER_SECRET_CANARY_KEY_1234567890_DO_NOT_LEAK';
const MOCK_BASE_URL = 'https://vcaerawuwffziufvpbvw.supabase.co';
const MOCK_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.mocksecretkeylongerthan20chars';

// ============================================================================
// 1. CONFIGURATION PARSING (parseDataApiConfig / parseSupabaseConfig)
// ============================================================================

test('Config 1.1: Accepts valid HTTPS Supabase URLs (.supabase.co and .supabase.com)', () => {
  const cfg1 = parseDataApiConfig({
    ATAX_SUPABASE_URL: 'https://demo.supabase.co',
    ATAX_SUPABASE_SECRET_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnopqrstuvwxyz123456',
  });
  assert.equal(cfg1.url, 'https://demo.supabase.co');
  assert.equal(cfg1.baseUrl, 'https://demo.supabase.co');
  assert.equal(cfg1.key, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnopqrstuvwxyz123456');
  assert.equal(cfg1.apiKey, cfg1.key);

  const cfg2 = parseDataApiConfig({
    SUPABASE_URL: 'https://enterprise.supabase.com',
    SUPABASE_SERVICE_ROLE_KEY: 'service_role_secret_key_1234567890_abcdef',
  });
  assert.equal(cfg2.url, 'https://enterprise.supabase.com');
  assert.equal(cfg2.key, 'service_role_secret_key_1234567890_abcdef');

  // Verify parseSupabaseConfig alias identity
  assert.equal(parseSupabaseConfig, parseDataApiConfig);
});

test('Config 1.2: Supports SUPABASE_SECRET_KEY fallback', () => {
  const cfg = parseDataApiConfig({
    SUPABASE_URL: 'https://fallback.supabase.co',
    SUPABASE_SECRET_KEY: 'secret_key_fallback_1234567890_abcdef123',
  });
  assert.equal(cfg.url, 'https://fallback.supabase.co');
  assert.equal(cfg.key, 'secret_key_fallback_1234567890_abcdef123');
});

test('Config 1.3: Normalizes URLs with trailing slashes and trims whitespace', () => {
  const cfg = parseDataApiConfig({
    ATAX_SUPABASE_URL: '  https://trailing-slash.supabase.co/  ',
    ATAX_SUPABASE_SECRET_KEY: 'a'.repeat(32),
  });
  assert.equal(cfg.url, 'https://trailing-slash.supabase.co');
  assert.equal(cfg.baseUrl, 'https://trailing-slash.supabase.co');
});

test('Config 1.4: Rejects missing, empty, or non-object environment containers', () => {
  for (const env of [null, undefined, '', 12345, true, 'string']) {
    assert.throws(
      () => parseDataApiConfig(env),
      err => err instanceof LedgerError && err.code === 'CONFIG_ERROR' && err.status === 503
    );
  }
});

test('Config 1.5: Rejects non-HTTPS schemes (http:, postgresql:, ws:, ftp:)', () => {
  const badSchemes = [
    'http://demo.supabase.co',
    'postgresql://postgres:pass@db.demo.supabase.co:5432/postgres',
    'ws://demo.supabase.co',
    'ftp://demo.supabase.co',
  ];
  for (const url of badSchemes) {
    assert.throws(
      () => parseDataApiConfig({ ATAX_SUPABASE_URL: url, ATAX_SUPABASE_SECRET_KEY: 'a'.repeat(32) }),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'CONFIG_ERROR');
        assert.equal(err.status, 503);
        assert.match(err.message, /requires a canonical HTTPS Supabase URL/);
        return true;
      }
    );
  }
});

test('Config 1.6: Rejects untrusted hostnames, suffix tricks, and malformed subdomains', () => {
  const untrustedUrls = [
    'https://evil.example.com',
    'https://attacker.org',
    'https://supabase.co.attacker.com',
    'https://evil-supabase.co',
    'https://..supabase.co',
    'https://.supabase.co',
    'https://not-supabase.com',
  ];
  for (const url of untrustedUrls) {
    assert.throws(
      () => parseDataApiConfig({ ATAX_SUPABASE_URL: url, ATAX_SUPABASE_SECRET_KEY: 'a'.repeat(32) }),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'CONFIG_ERROR');
        assert.match(err.message, /requires a canonical Supabase hostname/);
        return true;
      }
    );
  }
});

test('Config 1.7: Rejects embedded user credentials in URL', () => {
  const credUrls = [
    'https://user:password@demo.supabase.co',
    'https://admin@demo.supabase.co',
  ];
  for (const url of credUrls) {
    assert.throws(
      () => parseDataApiConfig({ ATAX_SUPABASE_URL: url, ATAX_SUPABASE_SECRET_KEY: 'a'.repeat(32) }),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'CONFIG_ERROR');
        assert.match(err.message, /must not contain user credentials/);
        return true;
      }
    );
  }
});

test('Config 1.8: Rejects query parameters and hashes in URL', () => {
  const urls = [
    'https://demo.supabase.co?token=secret',
    'https://demo.supabase.co#heading',
    'https://demo.supabase.co/?key=val#hash',
  ];
  for (const url of urls) {
    assert.throws(
      () => parseDataApiConfig({ ATAX_SUPABASE_URL: url, ATAX_SUPABASE_SECRET_KEY: 'a'.repeat(32) }),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'CONFIG_ERROR');
        assert.match(err.message, /must not contain query parameters or hash/);
        return true;
      }
    );
  }
});

test('Config 1.9: Rejects subpaths and non-root pathnames', () => {
  const subpathUrls = [
    'https://demo.supabase.co/rest/v1',
    'https://demo.supabase.co/api',
    'https://demo.supabase.co/rpc/test',
  ];
  for (const url of subpathUrls) {
    assert.throws(
      () => parseDataApiConfig({ ATAX_SUPABASE_URL: url, ATAX_SUPABASE_SECRET_KEY: 'a'.repeat(32) }),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'CONFIG_ERROR');
        assert.match(err.message, /Invalid Supabase Data API URL pathname/);
        return true;
      }
    );
  }
});

test('Config 1.10: Rejects missing, short (<20 chars), long (>8192 chars), or unsafe secret keys', () => {
  const invalidKeys = [
    { key: undefined, msg: /Data API key unavailable/ },
    { key: '', msg: /Data API key unavailable/ },
    { key: 'a'.repeat(19), msg: /Data API key unavailable/ },
    { key: 'a'.repeat(8193), msg: /Data API key unavailable/ },
    { key: 'has space inside here 12345678', msg: /Invalid Supabase Data API key format/ },
    { key: 'newline\nkey123456789012345', msg: /Invalid Supabase Data API key format/ },
    { key: 'key$with$symbols!@#%^&*()', msg: /Invalid Supabase Data API key format/ },
  ];
  for (const { key, msg } of invalidKeys) {
    assert.throws(
      () => parseDataApiConfig({ ATAX_SUPABASE_URL: 'https://demo.supabase.co', ATAX_SUPABASE_SECRET_KEY: key }),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'CONFIG_ERROR');
        assert.match(err.message, msg);
        return true;
      }
    );
  }
});

test('Config 1.11: Zero secret leakage in thrown config error messages', () => {
  const invalidUrls = [
    'http://demo.supabase.co',
    'https://evil.com',
    'https://user:pass@demo.supabase.co',
    'https://demo.supabase.co?bad=1',
    'https://demo.supabase.co/subpath',
  ];
  for (const url of invalidUrls) {
    try {
      parseDataApiConfig({ ATAX_SUPABASE_URL: url, ATAX_SUPABASE_SECRET_KEY: CANARY_SECRET });
      assert.fail(`Expected parseDataApiConfig to throw for ${url}`);
    } catch (err) {
      assert(err instanceof LedgerError);
      assert(!err.message.includes(CANARY_SECRET), `Secret leaked in error message for url: ${url}`);
    }
  }
});

// ============================================================================
// 2. ALLOWLIST ENFORCEMENT (assertAllowedRpc & CANONICAL_RPC_ALLOWLIST)
// ============================================================================

test('Allowlist 2.1: Allowlist contains exactly 40 canonical functions and is frozen', () => {
  assert.equal(CANONICAL_RPC_ALLOWLIST.size, 40);
  assert.ok(Object.isFrozen(CANONICAL_RPC_ALLOWLIST));
  assert.equal(ALLOWED_RPCS, CANONICAL_RPC_ALLOWLIST);
});

test('Allowlist 2.2: All 40 canonical ATAX functions are allowed without exception', () => {
  const expected40 = [
    'agent_context_overview', 'atax_context_snapshot', 'system_improvement_context',
    'goal_ledger_overview', 'goal_ledger_get_by_key', 'goal_ledger_resume_by_key',
    'goal_ledger_blocker_overview', 'goal_ledger_set_priority', 'goal_ledger_add_dependency',
    'goal_ledger_finalize_by_key', 'atax_goal_create_system_bounded',
    'vision_ledger_create', 'vision_ledger_add_target', 'vision_ledger_attach_tldraw',
    'atax_goal_create_system_omni',
    'task_ledger_claim_next', 'atax_goal_claim_safe', 'task_ledger_check_claim',
    'task_ledger_record_handoff', 'task_ledger_heartbeat_claim', 'task_ledger_record_loop_iteration',
    'task_ledger_submit_result', 'task_ledger_release_claim', 'task_ledger_add_dependency',
    'task_ledger_finalize_loop_script',
    'record_checkpoint_predicate_result', 'atax_worker_suitability_v1', 'atax_worker_intelligence_profile_upsert_v1', 'atax_mcp_task_claim_next_v1', 'atax_mcp_goal_claim_task_v1',
    'task_ledger_pending_verification', 'task_ledger_claim_verification',
    'task_ledger_claim_verification_for_task', 'task_ledger_verify_result_claimed',
    'atax_socket_execute_v1',
    'atax_mcp_skills_search_v1', 'atax_mcp_skill_get_v1', 'atax_mcp_skills_catalog_v1',
    'atax_mcp_runtime_config_v1', 'atax_mcp_socket_config_v1',
  ];

  for (const name of expected40) {
    assert.ok(CANONICAL_RPC_ALLOWLIST.has(name), `Missing canonical function: ${name}`);
    assert.doesNotThrow(() => assertAllowedRpc(name), `Unexpected rejection of canonical function: ${name}`);
  }
});

test('Allowlist 2.4: openLedger blocks instance-auth/vault RPCs while openControlPlaneLedger permits them', async () => {
  const calls = [];
  const mockFetcher = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ passkeyConfigured: false }), { status: 200 });
  };
  const mcpDb = await openLedger(VALID_ENV, mockFetcher);
  for (const fn of INSTANCE_CONTROL_PLANE_RPCS) {
    await assert.rejects(
      () => mcpDb.rpc(fn, {}),
      err => err instanceof LedgerError && err.code === 'RPC_NOT_ALLOWED' && err.status === 400
    );
  }
  assert.equal(calls.length, 0);

  const cpDb = await openControlPlaneLedger(VALID_ENV, mockFetcher);
  const res = await cpDb.rpc('atax_mcp_instance_auth_status_v1', {});
  assert.deepEqual(res, { passkeyConfigured: false });
  assert.equal(calls.length, 1);
});

test('Allowlist 2.3: Arbitrary, unlisted, and malicious functions are rejected with RPC_NOT_ALLOWED (400)', () => {
  const unallowed = [
    'arbitrary_fn',
    'pg_catalog.pg_tables',
    'information_schema.tables',
    'atax_context_snapshot; DROP TABLE goals;',
    'agent_context_overview--',
    'toString',
    'valueOf',
    'constructor',
    '__proto__',
    'prototype',
    'hasOwnProperty',
    'ATAX_CONTEXT_SNAPSHOT',
    'Agent_Context_Overview',
    ' atax_context_snapshot',
    'atax_context_snapshot ',
    '',
    'a'.repeat(200),
    null,
    undefined,
    12345,
    true,
    {},
    [],
  ];

  for (const fn of unallowed) {
    assert.throws(
      () => assertAllowedRpc(fn),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'RPC_NOT_ALLOWED');
        assert.equal(err.status, 400);
        return true;
      },
      `assertAllowedRpc failed to reject unallowed RPC: ${String(fn)}`
    );
  }
});

// ============================================================================
// 3. PARAMETER CHECKING (validateRpcParams & PARAM_KEY_REGEX)
// ============================================================================

test('Params 3.1: Accepts valid lowercase alphanumeric keys and returns serialized JSON', () => {
  const valid = {
    agent_id: 'agent-1',
    task_id_in: 'task-100',
    a: 1,
    col2_val: true,
    ['x' + 'y'.repeat(100)]: 'max-length-key',
  };
  const serialized = validateRpcParams(valid);
  assert.equal(typeof serialized, 'string');
  assert.deepEqual(JSON.parse(serialized), valid);
  assert.ok(PARAM_KEY_REGEX.test('agent_id_in'));
  assert.ok(PARAM_KEY_REGEX.test('a'));
  assert.ok(PARAM_KEY_REGEX.test('param1'));
});

test('Params 3.2: Rejects malformed parameter keys with INVALID_ARGUMENTS (400)', () => {
  const invalidKeys = [
    'UpperCase',
    'camelCase',
    'ALLCAPS',
    '_leading_underscore',
    '0starts_with_digit',
    'hyphen-key',
    'dot.key',
    'space key',
    'key$val',
    'key#hash',
    '',
    'a'.repeat(102), // exceeds 101 char max
  ];

  for (const key of invalidKeys) {
    assert.throws(
      () => validateRpcParams({ [key]: 'value' }),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        assert.equal(err.status, 400);
        return true;
      },
      `validateRpcParams failed to reject malformed key: ${key}`
    );
  }
});

test('Params 3.3: Rejects prototype pollution keys at root and nested levels', () => {
  const forbidden = ['__proto__', 'constructor', 'prototype'];

  for (const key of forbidden) {
    // Root level
    assert.throws(
      () => validateRpcParams(JSON.parse(`{"${key}": "exploit"}`)),
      err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS'
    );
    // Nested object
    assert.throws(
      () => validateRpcParams({ safe_key: JSON.parse(`{"${key}": "exploit"}`) }),
      err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS'
    );
    // Nested array
    assert.throws(
      () => validateRpcParams({ arr_key: [1, JSON.parse(`{"${key}": "exploit"}`)] }),
      err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS'
    );
  }
});

test('Params 3.4: Rejects non-serializable and non-finite arguments', () => {
  const badValues = [
    { label: 'NaN top-level', params: { num: NaN } },
    { label: 'NaN in array', params: { list: [1, NaN] } },
    { label: 'Infinity top-level', params: { num: Infinity } },
    { label: '-Infinity in nested', params: { obj: { num: -Infinity } } },
    { label: 'undefined top-level', params: { val: undefined } },
    { label: 'undefined in array', params: { list: ['a', undefined] } },
    { label: 'BigInt', params: { big: 9007199254740991000n } },
    { label: 'Function', params: { fn: () => {} } },
    { label: 'Symbol', params: { sym: Symbol('bad') } },
  ];

  for (const { label, params } of badValues) {
    assert.throws(
      () => validateRpcParams(params),
      err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS',
      `Failed to reject non-serializable: ${label}`
    );
  }
});

test('Params 3.5: Rejects cyclic references in objects and arrays', () => {
  const cyclicObj = { name: 'cycle' };
  cyclicObj.self = cyclicObj;
  assert.throws(
    () => validateRpcParams({ payload: cyclicObj }),
    err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS' && /Cyclic reference detected/.test(err.message)
  );

  const cyclicArr = [1, 2];
  cyclicArr.push(cyclicArr);
  assert.throws(
    () => validateRpcParams({ payload: cyclicArr }),
    err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS' && /Cyclic reference detected/.test(err.message)
  );
});

test('Params 3.6: Permits valid DAG / diamond shared references without false cyclic rejection', () => {
  const shared = { shared_item: 'clean', count: 10 };
  const dag = {
    branch_one: { ref: shared },
    branch_two: { ref: shared },
  };
  assert.doesNotThrow(() => validateRpcParams(dag));
});

test('Params 3.7: Enforces recursion depth limit (> 16)', () => {
  let deepObj = { level: 0 };
  let cur = deepObj;
  for (let i = 1; i <= 20; i++) {
    cur.next = { level: i };
    cur = cur.next;
  }
  assert.throws(
    () => validateRpcParams({ tree: deepObj }),
    err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS' && /recursion depth limit exceeded/.test(err.message)
  );
});

test('Params 3.8: Enforces parameter count cap (<= 40)', () => {
  const valid40 = {};
  for (let i = 0; i < 40; i++) valid40[`key_${i}`] = i;
  assert.doesNotThrow(() => validateRpcParams(valid40));

  const invalid41 = { ...valid40, extra_key: 41 };
  assert.throws(
    () => validateRpcParams(invalid41),
    err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS' && /exceeds maximum limit \(40\)/.test(err.message)
  );
});

test('Params 3.9: Enforces payload size limit (<= 1MB) with UTF-8 byte awareness', () => {
  // UTF-8 Multi-byte string: 300,000 emojis (4 bytes each = 1.2MB)
  assert.throws(
    () => validateRpcParams({ emoji: '🔥'.repeat(300_000) }),
    err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS' && /payload size exceeds 1MB limit/.test(err.message)
  );

  // Large ASCII string > 1MB
  assert.throws(
    () => validateRpcParams({ data: 'x'.repeat(1_050_000) }),
    err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS' && /payload size exceeds 1MB limit/.test(err.message)
  );

  // Valid size under 1MB
  assert.doesNotThrow(() => validateRpcParams({ data: 'x'.repeat(100_000) }));
});

test('Params 3.10: Rejects non-plain objects, arrays, and primitive root arguments', () => {
  class CustomClass { constructor() { this.val = 1; } }

  for (const nonPlain of [new CustomClass(), new Date(), new RegExp('x'), new Map(), new Set(), new Uint8Array()]) {
    assert.throws(
      () => validateRpcParams({ item: nonPlain }),
      err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS'
    );
  }

  for (const badRoot of [null, undefined, [1, 2], 'string', 123, true]) {
    assert.throws(
      () => validateRpcParams(badRoot),
      err => err instanceof LedgerError && err.code === 'INVALID_ARGUMENTS'
    );
  }

  // Object.create(null) with valid properties is accepted
  const nullProto = Object.create(null);
  nullProto.valid_key = 'value';
  assert.doesNotThrow(() => validateRpcParams(nullProto));
});

// ============================================================================
// 4. CLIENT INITIALIZATION (createLedgerDb & openLedger)
// ============================================================================

test('Init 4.1: createLedgerDb initializes with valid baseUrl and apiKey', () => {
  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY });
  assert.equal(typeof db.rpc, 'function');
  assert.equal(typeof db.skills, 'function');
  assert.equal(typeof db.skill, 'function');
  assert.equal(typeof db.request, 'function');
});

test('Init 4.2: createLedgerDb supports url and key property aliases', () => {
  const db = createLedgerDb({ url: MOCK_BASE_URL, key: MOCK_API_KEY });
  assert.equal(typeof db.rpc, 'function');
  assert.equal(typeof db.request, 'function');
});

test('Init 4.3: createLedgerDb fails closed on missing or invalid configuration', () => {
  const invalidConfigs = [
    {},
    { baseUrl: MOCK_BASE_URL },
    { apiKey: MOCK_API_KEY },
    { baseUrl: 12345, apiKey: MOCK_API_KEY },
    { baseUrl: MOCK_BASE_URL, apiKey: null },
    { baseUrl: '', apiKey: MOCK_API_KEY },
  ];

  for (const cfg of invalidConfigs) {
    assert.throws(
      () => createLedgerDb(cfg),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'CONFIG_ERROR');
        assert.equal(err.status, 503);
        assert.equal(err.message, 'Invalid ledger configuration');
        return true;
      }
    );
  }
});

test('Init 4.4: openLedger initializes client asynchronously from valid environment', async () => {
  const db = await openLedger(VALID_ENV);
  assert.equal(typeof db.rpc, 'function');
  assert.equal(typeof db.skills, 'function');
  assert.equal(typeof db.skill, 'function');
  assert.equal(typeof db.request, 'function');
});

// ============================================================================
// 5. MOCK FETCHER VERIFICATION IN rpc()
// ============================================================================

test('Transport 5.1: rpc dispatches to exact PostgREST endpoint with POST method', async () => {
  let capturedUrl = null;
  let capturedMethod = null;

  const mockFetcher = async (url, options) => {
    capturedUrl = url;
    capturedMethod = options.method;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
  await db.rpc('goal_ledger_overview', { agent_id: 'agent-1' });

  assert.equal(capturedUrl, `${MOCK_BASE_URL}/rest/v1/rpc/goal_ledger_overview`);
  assert.equal(capturedMethod, 'POST');
});

test('Transport 5.2: rpc includes all mandatory authentication and content headers', async () => {
  let capturedHeaders = null;

  const mockFetcher = async (url, options) => {
    capturedHeaders = options.headers;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
  await db.rpc('atax_context_snapshot');

  assert.deepEqual(capturedHeaders, {
    apikey: MOCK_API_KEY,
    Authorization: `Bearer ${MOCK_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
});

test('Transport 5.3: rpc transmits validated, stringified JSON body and timeout signal', async () => {
  let capturedBody = null;
  let capturedSignal = null;

  const mockFetcher = async (url, options) => {
    capturedBody = options.body;
    capturedSignal = options.signal;
    return new Response(JSON.stringify({ result: 42 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
  const params = { goal_key: 'infra_setup', priority: 1 };
  await db.rpc('goal_ledger_get_by_key', params);

  assert.equal(capturedBody, JSON.stringify(params));
  assert(capturedSignal instanceof AbortSignal, 'Expected AbortSignal on fetch options');
});

// ============================================================================
// 6. RESPONSE HANDLING IN rpc()
// ============================================================================

test('Response 6.1: HTTP 200 with JSON body returns parsed JSON structures', async () => {
  const testPayloads = [
    { ok: true, data: [1, 2, 3] },
    [{ task_id: 't-1', status: 'CLAIMED' }],
    'simple_string',
    999,
    false,
    null,
  ];

  for (const payload of testPayloads) {
    const mockFetcher = async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
    const res = await db.rpc('agent_context_overview');
    assert.deepEqual(res, payload);
  }
});

test('Response 6.2: HTTP 204 No Content returns null cleanly without calling .json()', async () => {
  let jsonCalled = false;
  const mockFetcher = async () => ({
    status: 204,
    ok: true,
    json: async () => { jsonCalled = true; throw new Error('json() should not be called'); },
    text: async () => { throw new Error('text() should not be called'); },
  });

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
  const result = await db.rpc('task_ledger_release_claim', { task_id: 'task-1' });

  assert.equal(result, null);
  assert.equal(jsonCalled, false);
});

test('Response 6.3: HTTP 200 with empty body or whitespace returns null', async () => {
  const emptyBodies = ['', '   ', '\r\n\t  '];

  for (const empty of emptyBodies) {
    const mockFetcher = async () => new Response(empty, { status: 200, headers: { 'Content-Type': 'application/json' } });
    const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
    const result = await db.rpc('atax_context_snapshot');
    assert.equal(result, null);
  }
});

test('Response 6.4: HTTP 200 with invalid JSON throws INVALID_RESPONSE (502)', async () => {
  const mockFetcher = async () => new Response('<html>502 Bad Gateway</html>', { status: 200 });
  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);

  await assert.rejects(
    () => db.rpc('agent_context_overview'),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_RESPONSE');
      assert.equal(err.status, 502);
      assert.equal(err.rpcName, 'agent_context_overview');
      assert.equal(err.message, 'Invalid JSON response from canonical ledger');
      return true;
    }
  );
});

// ============================================================================
// 7. POSTGREST ERROR MAPPING (mapPostgrestError)
// ============================================================================

test('Errors 7.1: PostgreSQL plpgsql exceptions (P0001) map to exact domain codes', async () => {
  const plpgsqlMappings = [
    { pattern: 'claim not found or expired', code: 'LEASE_EXPIRED_OR_INVALID', status: 400 },
    { pattern: 'claim was not owned', code: 'LEASE_EXPIRED_OR_INVALID', status: 400 },
    { pattern: 'task socket is still owned', code: 'CLAIM_ACTIVE_NOT_FORFEITED', status: 400 },
    { pattern: 'unrecognized prior claim', code: 'UNRECOGNIZED_PRIOR_CLAIM', status: 400 },
    { pattern: 'passing task loop iteration is required', code: 'LOOP_ITERATION_REQUIRED', status: 400 },
    { pattern: 'cannot verify its own submitted result', code: 'SELF_VERIFICATION_PROHIBITED', status: 400 },
    { pattern: 'task is not awaiting verification', code: 'TASK_NOT_AWAITING_VERIFICATION', status: 400 },
    { pattern: 'active System not found in ledger', code: 'SYSTEM_NOT_FOUND', status: 404 },
    { pattern: 'goal not found in system', code: 'GOAL_NOT_FOUND', status: 404 },
    { pattern: 'priority must be between 0 and 1', code: 'INVALID_PRIORITY', status: 400 },
    { pattern: 'agent identity is required for claim', code: 'AGENT_IDENTITY_REQUIRED', status: 400 },
  ];

  for (const { pattern, code, status } of plpgsqlMappings) {
    const res = new Response(JSON.stringify({ code: 'P0001', message: pattern }), { status: 400 });
    const mapped = await mapPostgrestError(res, 'test_rpc');
    assert.equal(mapped.code, code, `Failed mapping for pattern "${pattern}"`);
    assert.equal(mapped.status, status);
  }
});

test('Errors 7.2: Unmapped safe plpgsql exception maps to LEDGER_RULE_VIOLATION (400)', async () => {
  const res = new Response(JSON.stringify({ code: 'P0001', message: 'Custom rule check failed' }), { status: 400 });
  const mapped = await mapPostgrestError(res, 'test_rpc');
  assert.equal(mapped.code, 'LEDGER_RULE_VIOLATION');
  assert.equal(mapped.status, 400);
  assert.equal(mapped.message, 'Custom rule check failed');
});

test('Errors 7.3: plpgsql exception with sensitive info safely falls back to generic constraint violation', async () => {
  const secretKey = 'my-synthetic-secret-key-12345';
  const internalUrl = 'https://internal.supabase.co';
  const leakBody = {
    message: `Error with key ${secretKey} at ${internalUrl}/rest/v1/rpc`,
    code: 'P0001',
  };
  const res = new Response(JSON.stringify(leakBody), { status: 400 });
  const mapped = await mapPostgrestError(res, 'test_rpc', secretKey, internalUrl);
  assert.equal(mapped.code, 'LEDGER_RULE_VIOLATION');
  assert.equal(mapped.status, 400);
  assert.equal(mapped.message, 'Canonical operation rejected by ledger constraint');
});

test('Errors 7.4: PostgreSQL relational integrity error codes map accurately', async () => {
  const integrityMappings = [
    { pgCode: '23505', expectedCode: 'UNIQUE_VIOLATION', expectedStatus: 409 },
    { pgCode: '23503', expectedCode: 'FOREIGN_KEY_VIOLATION', expectedStatus: 400 },
    { pgCode: '23514', expectedCode: 'CHECK_VIOLATION', expectedStatus: 400 },
  ];

  for (const { pgCode, expectedCode, expectedStatus } of integrityMappings) {
    const res = new Response(JSON.stringify({ code: pgCode, message: 'Constraint error' }), { status: 400 });
    const mapped = await mapPostgrestError(res, 'test_rpc');
    assert.equal(mapped.code, expectedCode);
    assert.equal(mapped.status, expectedStatus);
  }
});

test('Errors 7.5: Schema cache miss and missing overload map to RPC_NOT_FOUND (404)', async () => {
  const missCases = [
    { res: new Response(JSON.stringify({ message: 'Function not found' }), { status: 404 }) },
    { res: new Response(JSON.stringify({ code: 'PGRST202', message: 'Function overload mismatch' }), { status: 404 }) },
    { res: new Response(JSON.stringify({ code: '42883', message: 'function does not exist' }), { status: 400 }) },
  ];

  for (const { res } of missCases) {
    const mapped = await mapPostgrestError(res, 'test_rpc');
    assert.equal(mapped.code, 'RPC_NOT_FOUND');
    assert.equal(mapped.status, 404);
  }
});

test('Errors 7.6: Upstream authorization errors (401/403) map to UNAUTHORIZED', async () => {
  for (const status of [401, 403]) {
    const res = new Response(JSON.stringify({ message: 'Auth failure' }), { status });
    const mapped = await mapPostgrestError(res, 'test_rpc');
    assert.equal(mapped.code, 'UNAUTHORIZED');
    assert.equal(mapped.status, status);
    assert.equal(mapped.message, 'Canonical ledger authorization failed');
  }
});

test('Errors 7.7: Upstream 5xx server failures map to UPSTREAM_UNAVAILABLE', async () => {
  for (const status of [500, 502, 503, 504]) {
    const res = new Response(JSON.stringify({ message: 'Internal Server Error' }), { status });
    const mapped = await mapPostgrestError(res, 'test_rpc');
    assert.equal(mapped.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(mapped.status, status);
    assert.equal(mapped.message, `Canonical ledger service temporarily unavailable (HTTP ${status})`);
  }
});

test('Errors 7.8: Handles unparseable response body streams cleanly without unhandled rejections', async () => {
  // Simulates response where json() fails and stream is locked/consumed
  const brokenRes = {
    status: 500,
    async json() { throw new Error('Bad JSON'); },
    async text() { throw new Error('Body has already been read'); },
  };
  const mapped = await mapPostgrestError(brokenRes, 'test_rpc');
  assert.equal(mapped.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(mapped.status, 500);
});

test('Errors 7.9: HTTP 400 without P0001 code maps safe string vs generic fallback', async () => {
  const safeRes = new Response(JSON.stringify({ message: 'Invalid field syntax' }), { status: 400 });
  const mappedSafe = await mapPostgrestError(safeRes, 'test_rpc');
  assert.equal(mappedSafe.code, 'LEDGER_RULE_VIOLATION');
  assert.equal(mappedSafe.status, 400);
  assert.equal(mappedSafe.message, 'Invalid field syntax');

  const unsafeRes = new Response(JSON.stringify({ message: '<bad>!@#$$%^&*(){}</bad>' }), { status: 400 });
  const mappedUnsafe = await mapPostgrestError(unsafeRes, 'test_rpc');
  assert.equal(mappedUnsafe.code, 'LEDGER_ERROR');
  assert.equal(mappedUnsafe.status, 400);
  assert.equal(mappedUnsafe.message, 'Canonical operation denied or unavailable');
});

// ============================================================================
// 8. TIMEOUT AND NETWORK TRANSPORT ERRORS
// ============================================================================

test('TransportErrors 8.1: AbortSignal timeout in rpc() maps to TIMEOUT (504)', async () => {
  const timeoutFetcher = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    throw err;
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, timeoutFetcher);
  await assert.rejects(
    () => db.rpc('agent_context_overview'),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.status, 504);
      assert.equal(err.rpcName, 'agent_context_overview');
      assert.equal(err.message, 'Canonical ledger request timed out');
      return true;
    }
  );
});

test('TransportErrors 8.2: Network transport drop in rpc() maps to NETWORK_ERROR (503)', async () => {
  const netFetcher = async () => {
    throw new TypeError('Failed to fetch');
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, netFetcher);
  await assert.rejects(
    () => db.rpc('agent_context_overview'),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'NETWORK_ERROR');
      assert.equal(err.status, 503);
      assert.equal(err.rpcName, 'agent_context_overview');
      assert.equal(err.message, 'Canonical ledger network transport error');
      return true;
    }
  );
});

// ============================================================================
// 9. CREDENTIAL SCRUBBING & ZERO SECRET LEAKAGE
// ============================================================================

test('Sanitization 9.1: sanitizeErrorMessage redacts URLs, URIs, JWTs, Bearer tokens, and hashes', () => {
  const raw = 'Failed at https://db.supabase.co/rest/v1 with postgresql://user:pwd@db.supabase.co:5432/postgres using Bearer abc.def.ghi and JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.xyz and token atax_0123456789abcdef0123456789abcdef0123456789abcdef and hash ' + 'f'.repeat(64);
  const sanitized = sanitizeErrorMessage(raw);
  assert.ok(!sanitized.includes('https://'));
  assert.ok(!sanitized.includes('postgresql://'));
  assert.ok(!sanitized.includes('pwd'));
  assert.ok(!sanitized.includes('eyJhbGci'));
  assert.ok(!sanitized.includes('atax_0123456789abcdef'));
  assert.ok(sanitized.includes('[REDACTED_URL]'));
  assert.ok(sanitized.includes('[REDACTED_URI]'));
  assert.ok(sanitized.includes('[REDACTED_JWT]'));
  assert.ok(sanitized.includes('[REDACTED_TOKEN]'));
  assert.ok(sanitized.includes('[REDACTED_HASH]'));
});

test('Sanitization 9.2: API keys, JWTs, PostgreSQL URIs, URLs and hashes are scrubbed in errors', async () => {
  const secretKey = 'my-synthetic-secret-key-12345';
  const internalUrl = 'https://internal.supabase.co';
  const leakBody = {
    message: `Error with key ${secretKey} at ${internalUrl}/rest/v1/rpc using postgresql://u:p@db:5432 Bearer token123 atax_0123456789abcdef0123456789abcdef0123456789abcdef`,
    code: 'P0001',
  };

  const res = new Response(JSON.stringify(leakBody), { status: 400 });
  const mapped = await mapPostgrestError(res, 'test_rpc', secretKey, internalUrl);

  assert(!mapped.message.includes(secretKey), 'Leaked secret key');
  assert(!mapped.message.includes(internalUrl), 'Leaked internal URL');
  assert(!mapped.message.includes('postgresql://'), 'Leaked database URI');
  assert(!mapped.message.includes('token123'), 'Leaked bearer token');
});

// ============================================================================
// 10. SPECIALIZED HELPER METHODS (skills, skill, request)
// ============================================================================

test('Helpers 10.1: skills(term) invokes atax_mcp_skills_search_v1 with term_in', async () => {
  let capturedRpc = null;
  let capturedParams = null;

  const mockFetcher = async (url, options) => {
    capturedRpc = url.split('/').pop();
    capturedParams = JSON.parse(options.body);
    return new Response(JSON.stringify([{ slug: 'testing' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
  const result = await db.skills('unit testing');

  assert.equal(capturedRpc, 'atax_mcp_skills_search_v1');
  assert.equal(capturedParams.term_in, 'unit testing');
  assert.deepEqual(result, [{ slug: 'testing' }]);
});

test('Helpers 10.2: skills(term) normalizes null/undefined and truncates to 120 chars', async () => {
  let capturedParams = null;
  const mockFetcher = async (url, options) => {
    capturedParams = JSON.parse(options.body);
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);

  await db.skills(null);
  assert.equal(capturedParams.term_in, '');

  await db.skills(undefined);
  assert.equal(capturedParams.term_in, '');

  await db.skills('x'.repeat(200));
  assert.equal(capturedParams.term_in, 'x'.repeat(120));
});

test('Helpers 10.3: skill(slug) invokes atax_mcp_skill_get_v1 with slug_in', async () => {
  let capturedRpc = null;
  let capturedParams = null;

  const mockFetcher = async (url, options) => {
    capturedRpc = url.split('/').pop();
    capturedParams = JSON.parse(options.body);
    return new Response(JSON.stringify({ slug: 'architecture', content: 'docs' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
  const result = await db.skill('architecture');

  assert.equal(capturedRpc, 'atax_mcp_skill_get_v1');
  assert.equal(capturedParams.slug_in, 'architecture');
  assert.equal(result.slug, 'architecture');
});

test('Helpers 10.4: skill(slug) normalizes null/undefined and truncates to 120 chars', async () => {
  let capturedParams = null;
  const mockFetcher = async (url, options) => {
    capturedParams = JSON.parse(options.body);
    return new Response(JSON.stringify(null), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);

  await db.skill(null);
  assert.equal(capturedParams.slug_in, '');

  await db.skill('s'.repeat(200));
  assert.equal(capturedParams.slug_in, 's'.repeat(120));
});

test('Helpers 10.5: request() validates path and strips leading slashes', async () => {
  let capturedUrl = null;
  const mockFetcher = async url => {
    capturedUrl = url;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);
  await db.request('/skills?select=*');
  assert.equal(capturedUrl, `${MOCK_BASE_URL}/rest/v1/skills?select=*`);

  await db.request('///skills/catalog');
  assert.equal(capturedUrl, `${MOCK_BASE_URL}/rest/v1/skills/catalog`);
});

test('Helpers 10.6: request() rejects path traversal, null bytes, and empty paths', async () => {
  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, async () => new Response('{}'));

  const badPaths = ['', 'skills/../../private', 'skills\0evil', null, undefined, 12345, 'a'.repeat(2049)];
  for (const badPath of badPaths) {
    await assert.rejects(
      () => db.request(badPath),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        assert.equal(err.status, 400);
        return true;
      }
    );
  }
});

test('Helpers 10.7: request() manages Content-Type based on body presence and merges custom headers', async () => {
  let capturedHeadersNoBody = null;
  let capturedHeadersWithBody = null;

  const mockFetcher = async (url, options) => {
    if (options.body) capturedHeadersWithBody = options.headers;
    else capturedHeadersNoBody = options.headers;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const db = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, mockFetcher);

  await db.request('skills');
  assert.equal(capturedHeadersNoBody['Content-Type'], undefined);
  assert.equal(capturedHeadersNoBody['Accept'], 'application/json');

  await db.request('skills', {
    method: 'POST',
    body: JSON.stringify({ name: 'skill-1' }),
    headers: { 'Prefer': 'return=representation' },
  });
  assert.equal(capturedHeadersWithBody['Content-Type'], 'application/json');
  assert.equal(capturedHeadersWithBody['prefer'], 'return=representation');
});

test('Helpers 10.8: request() handles 204 No Content, empty body, and parsing errors', async () => {
  const db204 = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, async () => new Response(null, { status: 204 }));
  assert.equal(await db204.request('skills'), null);

  const dbEmpty = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, async () => new Response('   ', { status: 200 }));
  assert.equal(await dbEmpty.request('skills'), null);

  const dbBadJson = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, async () => new Response('<not-json>', { status: 200 }));
  await assert.rejects(
    () => dbBadJson.request('skills'),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_RESPONSE');
      assert.equal(err.status, 502);
      assert.equal(err.message, 'Canonical response parsing failed');
      return true;
    }
  );
});

test('Helpers 10.9: request() handles timeouts and network failures with sanitized errors', async () => {
  const dbTimeout = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, async () => {
    const err = new Error('abort');
    err.name = 'TimeoutError';
    throw err;
  });
  await assert.rejects(
    () => dbTimeout.request('skills'),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.status, 504);
      assert.equal(err.rpcName, null);
      assert.equal(err.message, 'Canonical ledger request timed out');
      return true;
    }
  );

  const dbNet = createLedgerDb({ baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY }, async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(
    () => dbNet.request('skills'),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'NETWORK_ERROR');
      assert.equal(err.status, 503);
      assert.equal(err.rpcName, null);
      assert.equal(err.message, 'Canonical transport request failed');
      return true;
    }
  );
});
