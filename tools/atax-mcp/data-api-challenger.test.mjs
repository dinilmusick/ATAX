/**
 * tools/atax-mcp/data-api-challenger.test.mjs
 * Empirical stress tests and adversarial verification for Milestone M1.
 * Tests non-allowlisted RPCs, malformed keys, serialization edge cases,
 * size/param caps, HTTP 204 empty responses, and error sanitization.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openLedger,
  createLedgerDb,
  assertAllowedRpc,
  parseDataApiConfig,
  validateRpcParams,
  sanitizeErrorMessage,
  mapPostgrestError,
  CANONICAL_RPC_ALLOWLIST,
  LedgerError,
} from './data-api-ledger.mjs';

const VALID_ENV = {
  ATAX_SUPABASE_URL: 'https://vcaerawuwffziufvpbvw.supabase.co',
  ATAX_SUPABASE_SECRET_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.abcdefghijklmnopqrstuvwxyz1234567890',
};

// ============================================================================
// 1. NON-ALLOWLISTED RPC INVOCATIONS
// ============================================================================
test('Challenger 1.1: Non-allowlisted RPC invocations are rejected pre-flight with RPC_NOT_ALLOWED', async () => {
  let fetchCallCount = 0;
  const mockFetcher = async () => {
    fetchCallCount++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const ledger = await openLedger(VALID_ENV, mockFetcher);

  const adversarialRpcNames = [
    'non_existent_function',
    'arbitrary_query',
    'pg_catalog.pg_tables',
    'information_schema.tables',
    'version',
    'current_user',
    'atax_context_snapshot; DROP TABLE goals;',
    '../../../etc/passwd',
    'agent%20context%20overview',
    'toString',
    'valueOf',
    'constructor',
    '__proto__',
    'prototype',
    'hasOwnProperty',
    'isPrototypeOf',
    '',
    ' atax_context_snapshot',
    'atax_context_snapshot ',
    'ATAX_CONTEXT_SNAPSHOT',
    'Agent_Context_Overview',
    'a'.repeat(2000),
    null,
    undefined,
    12345,
    true,
    {},
    [],
  ];

  for (const invalidName of adversarialRpcNames) {
    // Test direct assertion
    assert.throws(
      () => assertAllowedRpc(invalidName),
      err => {
        assert(err instanceof LedgerError, `Expected LedgerError for ${invalidName}`);
        assert.equal(err.code, 'RPC_NOT_ALLOWED', `Expected RPC_NOT_ALLOWED for ${invalidName}`);
        assert.equal(err.status, 400, `Expected HTTP status 400 for ${invalidName}`);
        return true;
      },
      `assertAllowedRpc did not reject non-allowlisted RPC: ${String(invalidName)}`
    );

    // Test through client rpc dispatch
    await assert.rejects(
      async () => ledger.rpc(invalidName, {}),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'RPC_NOT_ALLOWED');
        assert.equal(err.status, 400);
        return true;
      },
      `ledger.rpc did not reject non-allowlisted RPC: ${String(invalidName)}`
    );
  }

  // Verify empirical invariant: mockFetcher was never called for any rejected RPC
  assert.equal(fetchCallCount, 0, 'Fetcher was invoked despite pre-flight rejection!');
});

test('Challenger 1.2: All 36 canonical RPCs are permitted by allowlist', () => {
  assert.equal(CANONICAL_RPC_ALLOWLIST.size, 36, 'CANONICAL_RPC_ALLOWLIST must contain exactly 36 functions');
  for (const rpcName of CANONICAL_RPC_ALLOWLIST) {
    assert.doesNotThrow(() => assertAllowedRpc(rpcName), `Canonical RPC was incorrectly rejected: ${rpcName}`);
  }
});

// ============================================================================
// 2. MALFORMED PARAMETER KEYS & PROTOTYPE POLLUTION
// ============================================================================
test('Challenger 2.1: Malformed parameter keys fail validation with INVALID_ARGUMENTS', () => {
  const invalidKeys = [
    'UpperCase',
    'camelCase',
    'ALLCAPS',
    '_leading_underscore',
    '__double_leading',
    'space inside',
    ' leading_space',
    'trailing_space ',
    'tab\tkey',
    'newline\nkey',
    'dash-key',
    'dot.key',
    'slash/key',
    'backslash\\key',
    'dollar$key',
    'hash#key',
    'at@key',
    'percent%key',
    '0starts_with_number',
    '1key',
    '',
    'a'.repeat(102), // exceeds 101 character max regex
  ];

  for (const key of invalidKeys) {
    const params = { [key]: 'test_val' };
    assert.throws(
      () => validateRpcParams(params),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        assert.equal(err.status, 400);
        return true;
      },
      `validateRpcParams did not reject invalid key: "${key}"`
    );
  }
});

test('Challenger 2.2: Prototype pollution keys at root and nested levels are rejected', () => {
  const pollutionKeys = ['__proto__', 'constructor', 'prototype'];

  // Top-level pollution
  for (const key of pollutionKeys) {
    const rawObj = JSON.parse(`{"${key}": "malicious"}`);
    assert.throws(
      () => validateRpcParams(rawObj),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        return true;
      },
      `Top-level prototype pollution key was not rejected: ${key}`
    );
  }

  // Nested in object
  for (const key of pollutionKeys) {
    const nestedObj = { safe_key: JSON.parse(`{"${key}": "malicious"}`) };
    assert.throws(
      () => validateRpcParams(nestedObj),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        assert(err.message.includes('Prototype pollution') || err.message.includes('canonical parameter key'));
        return true;
      },
      `Nested prototype pollution key was not rejected: ${key}`
    );
  }

  // Nested in array of objects
  for (const key of pollutionKeys) {
    const arrayNestedObj = { list_param: [1, JSON.parse(`{"${key}": "malicious"}`)] };
    assert.throws(
      () => validateRpcParams(arrayNestedObj),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        return true;
      },
      `Array-nested prototype pollution key was not rejected: ${key}`
    );
  }
});

test('Challenger 2.3: Non-plain objects and class instances are rejected', () => {
  class CustomClass {
    constructor() {
      this.field = 'value';
    }
  }

  const nonPlainValues = [
    new CustomClass(),
    new Date(),
    new RegExp('test'),
    new Map(),
    new Set(),
    new Error('test'),
    new Uint8Array([1, 2, 3]),
  ];

  for (const nonPlain of nonPlainValues) {
    assert.throws(
      () => validateRpcParams({ valid_key: nonPlain }),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        assert(err.message.includes('Non-plain object') || err.message.includes('Non-serializable'));
        return true;
      },
      `Non-plain object was not rejected: ${nonPlain?.constructor?.name}`
    );
  }

  // Non-plain root params
  assert.throws(() => validateRpcParams(new CustomClass()), err => err.code === 'INVALID_ARGUMENTS');
  assert.throws(() => validateRpcParams([1, 2, 3]), err => err.code === 'INVALID_ARGUMENTS');
  assert.throws(() => validateRpcParams(null), err => err.code === 'INVALID_ARGUMENTS');
  assert.throws(() => validateRpcParams('string'), err => err.code === 'INVALID_ARGUMENTS');
  assert.throws(() => validateRpcParams(12345), err => err.code === 'INVALID_ARGUMENTS');

  // Object.create(null) with valid keys should succeed
  const nullProto = Object.create(null);
  nullProto.agent_id = 'agent-007';
  assert.doesNotThrow(() => validateRpcParams(nullProto));
});

// ============================================================================
// 3. NON-SERIALIZABLE ARGUMENTS & CYCLES
// ============================================================================
test('Challenger 3.1: Non-serializable arguments (NaN, Infinity, undefined, BigInt, Function, Symbol) are rejected', () => {
  const badArgCases = [
    { label: 'NaN top-level', params: { num_val: NaN } },
    { label: 'NaN in array', params: { arr_val: [1, 2, NaN] } },
    { label: 'NaN in nested object', params: { obj_val: { inner: NaN } } },
    { label: 'Infinity top-level', params: { num_val: Infinity } },
    { label: '-Infinity in array', params: { arr_val: [-Infinity] } },
    { label: 'undefined top-level', params: { undef_val: undefined } },
    { label: 'undefined in array', params: { arr_val: ['a', undefined, 'b'] } },
    { label: 'undefined in nested object', params: { obj_val: { u: undefined } } },
    { label: 'BigInt', params: { big_val: 12345678901234567890n } },
    { label: 'Function', params: { func_val: () => {} } },
    { label: 'Symbol', params: { sym_val: Symbol('evil') } },
  ];

  for (const { label, params } of badArgCases) {
    assert.throws(
      () => validateRpcParams(params),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        return true;
      },
      `Failed to reject non-serializable argument: ${label}`
    );
  }
});

test('Challenger 3.2: Cyclic references in objects and arrays are rejected', () => {
  // Self-referencing object
  const cyclicObj = { name: 'cyclic' };
  cyclicObj.self = cyclicObj;

  assert.throws(
    () => validateRpcParams({ payload: cyclicObj }),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_ARGUMENTS');
      assert.match(err.message, /Cyclic reference detected/);
      return true;
    },
    'Failed to reject direct self-referencing cyclic object'
  );

  // Self-referencing array
  const cyclicArr = [1, 2];
  cyclicArr.push(cyclicArr);

  assert.throws(
    () => validateRpcParams({ payload: cyclicArr }),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_ARGUMENTS');
      assert.match(err.message, /Cyclic reference detected/);
      return true;
    },
    'Failed to reject direct self-referencing cyclic array'
  );

  // Indirect cycle: A -> B -> C -> A
  const a = { name: 'a' };
  const b = { name: 'b' };
  const c = { name: 'c' };
  a.next = b;
  b.next = c;
  c.next = a;

  assert.throws(
    () => validateRpcParams({ graph: a }),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_ARGUMENTS');
      assert.match(err.message, /Cyclic reference detected/);
      return true;
    },
    'Failed to reject indirect multi-hop cyclic graph'
  );

  // Non-cyclic diamond / DAG should SUCCEED (not be falsely flagged as cycle)
  const sharedLeaf = { leaf: 'leaf_value', count: 42 };
  const diamondGraph = {
    branch_left: { ref: sharedLeaf },
    branch_right: { ref: sharedLeaf },
  };

  assert.doesNotThrow(
    () => validateRpcParams(diamondGraph),
    'Legitimate DAG / diamond references were falsely rejected as cyclic'
  );
});

test('Challenger 3.3: Excessive recursion depth limit is enforced', () => {
  // Build an object 20 levels deep (MAX_RECURSION_DEPTH = 16)
  let deepObj = { level: 20 };
  for (let i = 19; i >= 0; i--) {
    deepObj = { level: i, child: deepObj };
  }

  assert.throws(
    () => validateRpcParams({ root: deepObj }),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_ARGUMENTS');
      assert.match(err.message, /recursion depth limit exceeded/);
      return true;
    },
    'Deep recursion beyond limit was not rejected'
  );
});

// ============================================================================
// 4. OVERSIZED PAYLOADS (>1MB) AND PARAMETER COUNT CAPS (>40)
// ============================================================================
test('Challenger 4.1: Parameter count caps (MAX_PARAM_COUNT = 40) are enforced', () => {
  // Exactly 40 parameters: should PASS
  const exactly40 = {};
  for (let i = 0; i < 40; i++) {
    exactly40[`key_${i}`] = `value_${i}`;
  }
  assert.doesNotThrow(() => validateRpcParams(exactly40), '40 parameters should be permitted');

  // 41 parameters: should FAIL
  const exactly41 = { ...exactly40, key_extra: 'overflow' };
  assert.throws(
    () => validateRpcParams(exactly41),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_ARGUMENTS');
      assert.match(err.message, /Parameter count \(41\) exceeds maximum limit \(40\)/);
      return true;
    },
    '41 parameters should be rejected'
  );
});

test('Challenger 4.2: Payload size cap (>1MB) is strictly enforced with multi-byte awareness', () => {
  // Multi-byte Unicode test: emoji string where byte length > character length
  // 300,000 emojis (🔥 is 4 bytes each = 1,200,000 bytes > 1MB, but character length is only 600,000)
  const hugeEmojiString = '🔥'.repeat(300_000);
  assert.throws(
    () => validateRpcParams({ data: hugeEmojiString }),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_ARGUMENTS');
      assert.match(err.message, /Parameter payload size exceeds 1MB limit/);
      return true;
    },
    'Multi-byte unicode payload > 1MB was not rejected'
  );

  // ASCII payload exceeding 1MB (1,048,576 + 500 bytes)
  const hugeAsciiString = 'x'.repeat(1_049_000);
  assert.throws(
    () => validateRpcParams({ data: hugeAsciiString }),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'INVALID_ARGUMENTS');
      assert.match(err.message, /Parameter payload size exceeds 1MB limit/);
      return true;
    },
    'ASCII payload > 1MB was not rejected'
  );

  // Moderate valid payload (< 500KB) should PASS
  const validSizeString = 'a'.repeat(100_000);
  assert.doesNotThrow(() => validateRpcParams({ data: validSizeString }));
});

// ============================================================================
// 5. EMPTY RESPONSE HANDLING (HTTP 204 No Content & Empty 200)
// ============================================================================
test('Challenger 5.1: HTTP 204 No Content returns null without JSON parsing exception', async () => {
  let requestHeaders = null;
  const mockFetcher = async (url, options) => {
    requestHeaders = options.headers;
    return new Response(null, { status: 204, statusText: 'No Content' });
  };

  const ledger = await openLedger(VALID_ENV, mockFetcher);

  const resultRpc = await ledger.rpc('goal_ledger_finalize_by_key', { goal_key: 'test_goal' });
  assert.equal(resultRpc, null, 'HTTP 204 in rpc() must return null');

  const resultReq = await ledger.request('skills?limit=1');
  assert.equal(resultReq, null, 'HTTP 204 in request() must return null');

  assert.equal(requestHeaders['Accept'], 'application/json');
});

test('Challenger 5.2: HTTP 200 with empty body returns null without JSON parsing exception', async () => {
  const emptyBodies = ['', '   ', '\n\t  \r\n'];

  for (const emptyBody of emptyBodies) {
    const mockFetcher = async () => new Response(emptyBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
    const ledger = await openLedger(VALID_ENV, mockFetcher);

    const resRpc = await ledger.rpc('atax_context_snapshot');
    assert.equal(resRpc, null, `Empty body "${emptyBody}" in rpc() must return null`);

    const resReq = await ledger.request('skills');
    assert.equal(resReq, null, `Empty body "${emptyBody}" in request() must return null`);
  }
});

test('Challenger 5.3: HTTP 200 with JSON "null" returns null, valid objects return parsed JSON', async () => {
  const cases = [
    { raw: 'null', expected: null },
    { raw: '{"status":"ok","count":42}', expected: { status: 'ok', count: 42 } },
    { raw: '[1,2,3]', expected: [1, 2, 3] },
    { raw: 'true', expected: true },
    { raw: '12345', expected: 12345 },
    { raw: '"string_result"', expected: 'string_result' },
  ];

  for (const { raw, expected } of cases) {
    const mockFetcher = async () => new Response(raw, { status: 200, headers: { 'Content-Type': 'application/json' } });
    const ledger = await openLedger(VALID_ENV, mockFetcher);

    const res = await ledger.rpc('agent_context_overview');
    assert.deepEqual(res, expected, `Failed to correctly parse JSON: ${raw}`);
  }
});

test('Challenger 5.4: HTTP 200 with invalid/corrupt JSON throws INVALID_RESPONSE (502)', async () => {
  const corruptBodies = [
    '<html>502 Bad Gateway</html>',
    '{"incomplete_json": ',
    'Unexpected token < in JSON at position 0',
  ];

  for (const corrupt of corruptBodies) {
    const mockFetcher = async () => new Response(corrupt, { status: 200, headers: { 'Content-Type': 'application/json' } });
    const ledger = await openLedger(VALID_ENV, mockFetcher);

    await assert.rejects(
      async () => ledger.rpc('agent_context_overview'),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_RESPONSE');
        assert.equal(err.status, 502);
        return true;
      },
      `Corrupt JSON did not throw INVALID_RESPONSE: ${corrupt}`
    );

    await assert.rejects(
      async () => ledger.request('skills'),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_RESPONSE');
        assert.equal(err.status, 502);
        return true;
      }
    );
  }
});

// ============================================================================
// 6. ERROR SANITIZATION & ZERO SECRET LEAKAGE
// ============================================================================
test('Challenger 6.1: Secret keys, internal URLs, database URIs, JWTs, and tokens are scrubbed from errors', async () => {
  const secretKey = 'my-super-secret-service-role-key-9999';
  const internalUrl = 'https://vcaerawuwffziufvpbvw.supabase.co';
  const postgresUri = 'postgresql://postgres:p@ssword123@db.vcaerawuwffziufvpbvw.supabase.co:5432/postgres';
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozS8p8F';
  const ataxToken = 'atax_0123456789abcdef0123456789abcdef0123456789abcdef';
  const hash64 = 'a'.repeat(64);

  const leakPayload = {
    message: `Database error at ${internalUrl}/rest/v1/rpc/test with key ${secretKey} using ${postgresUri} auth Bearer ${secretKey} token ${jwt} atax ${ataxToken} hash ${hash64}`,
    code: '42883',
  };

  const response = new Response(JSON.stringify(leakPayload), { status: 400 });
  const mappedError = await mapPostgrestError(response, 'test_rpc', secretKey, internalUrl);

  assert(mappedError instanceof LedgerError);
  // Verify that none of the sensitive tokens exist anywhere in message or name
  assert(!mappedError.message.includes(secretKey), 'Leaked secretKey in mapped error message!');
  assert(!mappedError.message.includes(internalUrl), 'Leaked internalUrl in mapped error message!');
  assert(!mappedError.message.includes('p@ssword123'), 'Leaked postgres password in mapped error message!');
  assert(!mappedError.message.includes(jwt), 'Leaked JWT in mapped error message!');
  assert(!mappedError.message.includes(ataxToken), 'Leaked ataxToken in mapped error message!');
  assert(!mappedError.message.includes(hash64), 'Leaked 64-char hash in mapped error message!');

  // Test standalone sanitizeErrorMessage
  const sanitized = sanitizeErrorMessage(leakPayload.message);
  assert(!sanitized.includes('http'));
  assert(!sanitized.includes('postgresql'));
  assert(!sanitized.includes(jwt));
  assert(!sanitized.includes(ataxToken));
  assert(!sanitized.includes(hash64));
});

test('Challenger 6.2: Environment parser fails closed with zero secret reflection', () => {
  const secret = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.supersecretkeyvaluehere12345678';
  const invalidEnvs = [
    { env: null, label: 'null env' },
    { env: {}, label: 'empty env' },
    { env: { ATAX_SUPABASE_URL: '' }, label: 'empty URL' },
    { env: { ATAX_SUPABASE_URL: 'http://insecure.supabase.co', ATAX_SUPABASE_SECRET_KEY: secret }, label: 'http URL' },
    { env: { ATAX_SUPABASE_URL: 'https://evil-phishing.com', ATAX_SUPABASE_SECRET_KEY: secret }, label: 'non-supabase domain' },
    { env: { ATAX_SUPABASE_URL: 'https://user:password@project.supabase.co', ATAX_SUPABASE_SECRET_KEY: secret }, label: 'URL credentials' },
    { env: { ATAX_SUPABASE_URL: 'https://project.supabase.co?token=123', ATAX_SUPABASE_SECRET_KEY: secret }, label: 'query params' },
    { env: { ATAX_SUPABASE_URL: 'https://project.supabase.co/extra/path', ATAX_SUPABASE_SECRET_KEY: secret }, label: 'extra path' },
    { env: { ATAX_SUPABASE_URL: 'https://project.supabase.co', ATAX_SUPABASE_SECRET_KEY: 'short' }, label: 'short key' },
    { env: { ATAX_SUPABASE_URL: 'https://project.supabase.co', ATAX_SUPABASE_SECRET_KEY: 'bad key with spaces and %$^&' }, label: 'invalid format key' },
  ];

  for (const { env, label } of invalidEnvs) {
    assert.throws(
      () => parseDataApiConfig(env),
      err => {
        assert(err instanceof LedgerError, `Expected LedgerError for ${label}`);
        assert.equal(err.code, 'CONFIG_ERROR');
        assert.equal(err.status, 503);
        // Guarantee no secret reflection
        if (env?.ATAX_SUPABASE_SECRET_KEY) {
          assert(!err.message.includes(env.ATAX_SUPABASE_SECRET_KEY), `Leaked secret in error for ${label}`);
        }
        return true;
      },
      `Failed to fail-closed on ${label}`
    );
  }
});

test('Challenger 6.3: Canonical plpgsql exception domain codes map accurately', async () => {
  const plpgsqlCases = [
    { msg: 'claim not found or expired', expectedCode: 'LEASE_EXPIRED_OR_INVALID', expectedStatus: 400 },
    { msg: 'task socket is still owned', expectedCode: 'CLAIM_ACTIVE_NOT_FORFEITED', expectedStatus: 400 },
    { msg: 'unrecognized former claim', expectedCode: 'UNRECOGNIZED_PRIOR_CLAIM', expectedStatus: 400 },
    { msg: 'passing task loop iteration is required', expectedCode: 'LOOP_ITERATION_REQUIRED', expectedStatus: 400 },
    { msg: 'cannot verify its own submitted result', expectedCode: 'SELF_VERIFICATION_PROHIBITED', expectedStatus: 400 },
    { msg: 'task is not awaiting verification', expectedCode: 'TASK_NOT_AWAITING_VERIFICATION', expectedStatus: 400 },
    { msg: 'active System not found', expectedCode: 'SYSTEM_NOT_FOUND', expectedStatus: 404 },
    { msg: 'goal not found in system', expectedCode: 'GOAL_NOT_FOUND', expectedStatus: 404 },
    { msg: 'priority must be between 0 and 1', expectedCode: 'INVALID_PRIORITY', expectedStatus: 400 },
    { msg: 'agent identity is required', expectedCode: 'AGENT_IDENTITY_REQUIRED', expectedStatus: 400 },
  ];

  for (const { msg, expectedCode, expectedStatus } of plpgsqlCases) {
    const res = new Response(JSON.stringify({ message: msg, code: 'P0001' }), { status: 400 });
    const mapped = await mapPostgrestError(res, 'test_rpc');
    assert.equal(mapped.code, expectedCode, `Mismatch code for: ${msg}`);
    assert.equal(mapped.status, expectedStatus, `Mismatch status for: ${msg}`);
  }
});

// ============================================================================
// 7. REST PATH TRAVERSAL & INJECTION IN request()
// ============================================================================
test('Challenger 7.1: Path traversal and null bytes in request() are rejected', async () => {
  const ledger = await openLedger(VALID_ENV, async () => new Response(null, { status: 204 }));

  const invalidPaths = [
    '../etc/passwd',
    'skills/../../private',
    'skills\0evil',
    '',
    null,
    undefined,
    12345,
    'a'.repeat(2500),
  ];

  for (const badPath of invalidPaths) {
    await assert.rejects(
      async () => ledger.request(badPath),
      err => {
        assert(err instanceof LedgerError);
        assert.equal(err.code, 'INVALID_ARGUMENTS');
        assert.equal(err.status, 400);
        return true;
      },
      `Path traversal/invalid path not rejected: ${String(badPath)}`
    );
  }
});

// ============================================================================
// 8. HIGH CONCURRENCY AND NETWORK RESILIENCE STRESS
// ============================================================================
test('Challenger 8.1: 50 concurrent RPC invocations maintain isolation and correct dispatch', async () => {
  let activeInFlight = 0;
  let maxConcurrent = 0;
  let totalDispatches = 0;

  const mockFetcher = async (url, options) => {
    activeInFlight++;
    if (activeInFlight > maxConcurrent) maxConcurrent = activeInFlight;
    totalDispatches++;

    // Small random delay to simulate realistic network jitter
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 10)));
    const body = JSON.parse(options.body);

    activeInFlight--;
    return new Response(JSON.stringify({ echo_id: body.agent_id, echo_key: body.goal_key }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const ledger = await openLedger(VALID_ENV, mockFetcher);

  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      ledger.rpc('goal_ledger_get_by_key', {
        agent_id: `agent_${i}`,
        goal_key: `goal_${i}`,
      })
    );
  }

  const results = await Promise.all(promises);
  assert.equal(results.length, 50);
  assert.equal(totalDispatches, 50);
  assert(maxConcurrent > 1, 'Expected concurrent overlapping executions');

  for (let i = 0; i < 50; i++) {
    assert.equal(results[i].echo_id, `agent_${i}`);
    assert.equal(results[i].echo_key, `goal_${i}`);
  }
});

test('Challenger 8.2: Network failure and timeout errors fail closed with sanitized error types', async () => {
  // Network transport drop
  const networkFailFetcher = async () => {
    throw new TypeError('Failed to fetch');
  };
  const ledgerNet = await openLedger(VALID_ENV, networkFailFetcher);

  await assert.rejects(
    async () => ledgerNet.rpc('agent_context_overview'),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'NETWORK_ERROR');
      assert.equal(err.status, 503);
      assert.equal(err.message, 'Canonical ledger network transport error');
      return true;
    }
  );

  // Timeout error
  const timeoutFetcher = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    throw err;
  };
  const ledgerTimeout = await openLedger(VALID_ENV, timeoutFetcher);

  await assert.rejects(
    async () => ledgerTimeout.rpc('agent_context_overview'),
    err => {
      assert(err instanceof LedgerError);
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.status, 504);
      assert.equal(err.message, 'Canonical ledger request timed out');
      return true;
    }
  );
});
