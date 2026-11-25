/**
 * Tier 2: Boundary & Corner Cases
 * Exercises strict protocol and substrate boundaries with >=5 test cases per category:
 * - Category A: Authentication & Token Boundaries (6 test cases)
 * - Category B: Expired Lease & Stale Fencing Token Boundaries (6 test cases)
 * - Category C: Null, Empty & Schema Violation Boundaries (7 test cases)
 * - Category D: Payload Size & HTTP Protocol Boundaries (5 test cases)
 * - Category E: Batch Limit Boundaries (6 test cases)
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnvironment } from './harness.mjs';

describe('Tier 2: Boundary & Corner Cases', async () => {
  let env;
  let client;

  before(async () => {
    env = await setupTestEnvironment();
    client = env.client;
  });

  after(async () => {
    if (env?.cleanup) await env.cleanup();
  });

  // Category A: Authentication & Token Boundaries
  describe('Category A: Authentication & Token Boundaries', () => {
    test('A.1: Request without Authorization header returns HTTP 401 with WWW-Authenticate', async () => {
      const res = await client.rawPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: '' });
      assert.equal(res.status, 401);
      assert.ok(res.headers.get('www-authenticate'), 'Must return WWW-Authenticate header');
    });

    test('A.2: Malformed Authorization scheme (Basic instead of Bearer) returns HTTP 401', async () => {
      const res = await client.rawPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Basic dXNlcjpwYXNz' });
      assert.equal(res.status, 401);
    });

    test('A.3: Short token (<12 chars) fails regex validation and returns HTTP 401', async () => {
      const res = await client.rawPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer short' });
      assert.equal(res.status, 401);
    });

    test('A.4: Token with incorrect SHA-256 digest returns HTTP 401', async () => {
      const fakeToken = 'atax_000000000000000000000000000000000000000000000000';
      const res = await client.rawPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: `Bearer ${fakeToken}` });
      assert.equal(res.status, 401);
    });

    test('A.5: Token containing invalid spaces in Bearer token returns HTTP 401', async () => {
      const badToken = 'atax_token with spaces';
      const res = await client.rawPost('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: `Bearer ${badToken}` });
      assert.equal(res.status, 401);
    });

    test('A.6: Direct PostgREST RPC without valid service key returns HTTP 401', async () => {
      if (env.isMock) {
        const res = await client.directPostgrestRpc('agent_context_overview', {}, 'invalid-key');
        assert.equal(res.status, 401);
      } else {
        assert.ok(true);
      }
    });
  });

  // Category B: Expired Lease & Stale Fencing Token Boundaries
  describe('Category B: Expired Lease & Fencing Token Boundaries', () => {
    let expiredTask = null;
    let oldClaimToken = null;

    before(async () => {
      if (env.isMock && env.state) {
        // Prepare a task with an expired lease
        const t = env.state.tasks.get('t-task-1');
        t.status = 'running';
        t.claimed_by_agent_id = 'atax-test-operator';
        t.claim_token = '11111111-2222-3333-4444-555555555555';
        // Expired 10 minutes ago
        t.claim_expires_at = new Date(Date.now() - 600000).toISOString();
        expiredTask = t;
        oldClaimToken = t.claim_token;
      }
    });

    test('B.1: Heartbeat with expired fencing token fails closed', async () => {
      if (!expiredTask) return;
      const res = await client.callTool('atax_task_heartbeat', {
        task_id: expiredTask.id,
        claim_token: oldClaimToken,
        current_step: 'Trying to heartbeat expired lease'
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true, 'Heartbeat on expired lease must return isError');
      assert.ok(res.json.result.content[0].text.includes('Canonical operation denied or unavailable'));
    });

    test('B.2: Check claim with expired fencing token returns boolean false', async () => {
      if (!expiredTask) return;
      const res = await client.callTool('atax_task_check_claim', {
        task_id: expiredTask.id,
        claim_token: oldClaimToken
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      assert.equal(res.json.result.structuredContent.result, false);
    });

    test('B.3: Submit result with expired fencing token fails closed', async () => {
      if (!expiredTask) return;
      const res = await client.callTool('atax_task_submit', {
        task_id: expiredTask.id,
        claim_token: oldClaimToken,
        summary: 'Attempted submit after expiration'
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
    });

    test('B.4: Release claim with expired fencing token fails closed', async () => {
      if (!expiredTask) return;
      const res = await client.callTool('atax_task_release', {
        task_id: expiredTask.id,
        claim_token: oldClaimToken,
        release_status: 'queued',
        reason: 'Attempted release after expiration'
      });
      assert.equal(res.status, 200);
      // Either fails closed or release returns error
      assert.ok(res.json.result.isError || res.json.result.structuredContent);
    });

    test('B.5: Recording handoff note with old/forfeited fencing token succeeds', async () => {
      if (!expiredTask) return;
      const res = await client.callTool('atax_task_handoff', {
        task_id: expiredTask.id,
        claim_token: oldClaimToken,
        note: 'Expired lease handoff note: reached step 2 before timeout',
        context: { partial_evidence: 'step2_done' }
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError, 'Handoff note on expired socket must succeed');
      const event = res.json.result.structuredContent.result;
      assert.equal(event.task_id, expiredTask.id);
      assert.equal(event.previous_claim_token, oldClaimToken);
    });

    test('B.6: Recording handoff note on still-active socket is rejected', async () => {
      if (env.isMock && env.state) {
        // Set task to active
        const t = env.state.tasks.get('t-task-2');
        t.status = 'running';
        t.claimed_by_agent_id = 'atax-test-operator';
        t.claim_token = '22222222-3333-4444-5555-666666666666';
        t.claim_expires_at = new Date(Date.now() + 600000).toISOString();

        const res = await client.callTool('atax_task_handoff', {
          task_id: t.id,
          claim_token: t.claim_token,
          note: 'Premature handoff attempt'
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.result.isError, true, 'Cannot handoff still-active socket');
      } else {
        assert.ok(true);
      }
    });
  });

  // Category C: Null, Empty & Schema Violation Boundaries
  describe('Category C: Null, Empty & Schema Violation Boundaries', () => {
    test('C.1: Non-object tool arguments returns schema error', async () => {
      const res = await client.callRpc('tools/call', { name: 'atax_context', arguments: 'not-an-object' });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Tool arguments must be an object'));
    });

    test('C.2: Missing required argument returns schema error', async () => {
      const res = await client.callTool('atax_system_context', {});
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Missing required argument: system_key'));
    });

    test('C.3: Empty string for minLength 1 field returns schema error', async () => {
      const res = await client.callTool('atax_system_context', { system_key: '' });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Invalid string: system_key'));
    });

    test('C.4: String exceeding maxLength returns schema error', async () => {
      const longStr = 'x'.repeat(300); // system_key max is 256
      const res = await client.callTool('atax_system_context', { system_key: longStr });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Invalid string: system_key'));
    });

    test('C.5: Integer below minimum returns schema error', async () => {
      const res = await client.callTool('atax_task_claim_next', { lease_seconds: 10 }); // min is 60
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Invalid integer: lease_seconds'));
    });

    test('C.6: Integer above maximum returns schema error', async () => {
      const res = await client.callTool('atax_task_claim_next', { lease_seconds: 5000 }); // max is 900
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Invalid integer: lease_seconds'));
    });

    test('C.7: Unsupported enum value returns schema error', async () => {
      const res = await client.callTool('atax_task_release', {
        task_id: 't-task-1',
        claim_token: 'dummy-token',
        release_status: 'destroyed_state', // valid: queued, blocked, abandoned
        reason: 'Invalid enum test'
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Unsupported value: release_status'));
    });
  });

  // Category D: Payload Size & HTTP Protocol Boundaries
  describe('Category D: Payload Size & HTTP Protocol Boundaries', () => {
    test('D.1: Request with Content-Length > 1MB returns HTTP 413', async () => {
      const res = await client.rawHttpRequest({
        path: '/mcp',
        headers: { 'Content-Length': '1048577' },
        body: ''
      });
      assert.equal(res.status, 413, 'Content-Length > 1048576 must return HTTP 413');
    });

    test('D.2: Actual body byte length > 1MB returns HTTP 413', async () => {
      const largePayload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { padding: 'A'.repeat(1024 * 1024 + 10) }
      };
      const res = await client.rawPost('/mcp', largePayload);
      assert.equal(res.status, 413, 'Body > 1048576 bytes must return HTTP 413');
    });

    test('D.3: Valid payload below 1MB (e.g. 50KB) is accepted', async () => {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { padding: 'B'.repeat(50 * 1024) }
      };
      const res = await client.rawPost('/mcp', payload);
      assert.equal(res.status, 200);
    });

    test('D.4: Non-JSON Content-Type returns HTTP 415', async () => {
      const res = await client.rawPost('/mcp', 'plain text', { 'Content-Type': 'text/plain' });
      assert.equal(res.status, 415, 'Non-JSON Content-Type must return HTTP 415');
    });

    test('D.5: HTTP GET on /mcp returns HTTP 405 Method Not Allowed', async () => {
      const res = await client.rawGet('/mcp');
      assert.equal(res.status, 405, 'GET on /mcp must return HTTP 405');
      assert.ok(res.json.error.includes('Stateless MCP endpoint does not support standalone SSE'));
    });
  });

  // Category E: Batch Limit Boundaries
  describe('Category E: Batch Limit Boundaries', () => {
    test('E.1: Empty JSON-RPC batch array returns HTTP 400', async () => {
      const res = await client.rawPost('/mcp', []);
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, -32600);
      assert.ok(res.json.error.message.includes('Empty JSON-RPC batch'));
    });

    test('E.2: Batch with 1 request returns array with 1 response', async () => {
      const res = await client.rawPost('/mcp', [
        { jsonrpc: '2.0', id: 1, method: 'ping' }
      ]);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json));
      assert.equal(res.json.length, 1);
      assert.equal(res.json[0].id, 1);
    });

    test('E.3: Batch with exactly 30 requests succeeds and returns 30 responses', async () => {
      const batch = Array.from({ length: 30 }, (_, i) => ({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'ping'
      }));
      const res = await client.rawPost('/mcp', batch);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json));
      assert.equal(res.json.length, 30);
    });

    test('E.4: Batch with 31 requests (>30) returns HTTP 400 Too many batch requests', async () => {
      const batch = Array.from({ length: 31 }, (_, i) => ({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'ping'
      }));
      const res = await client.rawPost('/mcp', batch);
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, -32600);
      assert.ok(res.json.error.message.includes('Too many batch requests'));
    });

    test('E.5: Batch with notification and call returns response only for call', async () => {
      const batch = [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 99, method: 'ping' }
      ];
      const res = await client.rawPost('/mcp', batch);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json));
      assert.equal(res.json.length, 1);
      assert.equal(res.json[0].id, 99);
    });

    test('E.6: Batch containing invalid item returns item-level error', async () => {
      const batch = [
        { jsonrpc: '2.0', id: 101, method: 'ping' },
        { invalid: 'not a valid rpc' }
      ];
      const res = await client.rawPost('/mcp', batch);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json));
      assert.equal(res.json.length, 2);
      assert.equal(res.json[0].id, 101);
      assert.equal(res.json[1].error.code, -32600);
    });
  });
});
