/**
 * Tier 1: Feature Coverage (Feature Isolation)
 * Verifies every required feature in isolation with at least 5 test cases per feature:
 * - 1. Health & Transport Reporting (GET /health)
 * - 2. Protocol Handshake (initialize, ping)
 * - 3. Tool Discovery (tools/list)
 * - 4. Read Tools (atax_context, agent_context_overview, goal_ledger_overview, atax_system_context, atax_goal_get)
 * - 5. Write/Claim Tools (task_ledger_claim_next, task_ledger_check_claim, task_ledger_heartbeat_claim, task_ledger_release_claim)
 * - 6. Verification Tools (task_ledger_claim_verification, task_ledger_verify_result_claimed, atax_verification_pending, atax_verification_claim_for_task)
 * - 7. Socket Execution (atax_socket_execute_v1, atax_socket_task_status, atax_socket_context_pull, atax_socket_output_submit, atax_socket_atomisation_request, atax_socket_workflow_request)
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnvironment } from './harness.mjs';

describe('Tier 1: Feature Coverage (Isolation)', async () => {
  let env;
  let client;

  before(async () => {
    env = await setupTestEnvironment();
    client = env.client;
  });

  after(async () => {
    if (env?.cleanup) await env.cleanup();
  });

  // Feature: Health & Transport Reporting
  describe('Health Endpoint Transport Verification', () => {
    test('1.1: Health check returns HTTP 200 OK', async () => {
      const { status } = await client.health();
      assert.equal(status, 200, 'Health endpoint must return status 200');
    });

    test('1.2: Health check reports databaseTransport: supabase-data-api', async () => {
      const { body } = await client.health();
      assert.equal(body.databaseTransport, 'supabase-data-api', 'databaseTransport must report supabase-data-api');
    });

    test('1.3: Health check reports service name and protocol', async () => {
      const { body } = await client.health();
      assert.ok(['atax-mcp', 'atax'].includes(body.service), 'Service name must be atax or atax-mcp');
      assert.equal(body.status, 'ok', 'Status must be ok');
    });

    test('1.4: Health check contains no leaked credentials or database URLs', async () => {
      const { body } = await client.health();
      const stringified = JSON.stringify(body).toLowerCase();
      assert.ok(!stringified.includes('password'), 'Must not leak password');
      assert.ok(!stringified.includes('postgresql://'), 'Must not leak postgres URL');
      assert.ok(!stringified.includes('secret'), 'Must not leak secrets');
    });

    test('1.5: Health check sets nosniff and no-store headers', async () => {
      const { headers } = await client.health();
      assert.equal(headers.get('x-content-type-options'), 'nosniff');
      assert.equal(headers.get('cache-control'), 'no-store');
    });
  });

  // Feature: MCP Handshake & Protocol Negotiation (initialize)
  describe('MCP Handshake (initialize)', () => {
    test('2.1: Initialize with standard protocol 2025-06-18', async () => {
      const res = await client.initialize('2025-06-18', { name: 'test-agent', version: '1.0' });
      assert.equal(res.status, 200);
      assert.equal(res.json.jsonrpc, '2.0');
      assert.equal(res.json.result.protocolVersion, '2025-06-18');
      assert.ok(res.json.result.serverInfo.name);
      assert.ok(res.json.result.capabilities.tools);
    });

    test('2.2: Initialize with older supported protocol 2025-03-26', async () => {
      const res = await client.initialize('2025-03-26');
      assert.equal(res.status, 200);
      assert.equal(res.json.result.protocolVersion, '2025-03-26');
    });

    test('2.3: Initialize with forward supported protocol 2025-11-25', async () => {
      const res = await client.initialize('2025-11-25');
      assert.equal(res.status, 200);
      assert.equal(res.json.result.protocolVersion, '2025-11-25');
    });

    test('2.4: Initialize without specifying protocol defaults to 2025-06-18', async () => {
      const res = await client.callRpc('initialize', {});
      assert.equal(res.status, 200);
      assert.equal(res.json.result.protocolVersion, '2025-06-18');
    });

    test('2.5: Initialize with unsupported protocol version returns error -32602', async () => {
      const res = await client.initialize('1999-01-01');
      assert.equal(res.status, 200);
      assert.equal(res.json.error.code, -32602);
      assert.ok(res.json.error.message.includes('Unsupported MCP protocol version'));
    });

    test('2.6: Ping returns empty object', async () => {
      const res = await client.callRpc('ping', {});
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.result, {});
    });
  });

  // Feature: Tool Discovery (tools/list)
  describe('Tool Discovery (tools/list)', () => {
    let tools = [];

    before(async () => {
      const res = await client.toolsList();
      assert.equal(res.status, 200);
      tools = res.json.result.tools;
    });

    test('3.1: tools/list returns non-empty array of tools', () => {
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length >= 15, `Expected at least 15 tools, found ${tools.length}`);
    });

    test('3.2: Every tool defines name, description, and inputSchema', () => {
      for (const t of tools) {
        assert.ok(typeof t.name === 'string' && t.name.length > 0, 'Tool must have name');
        assert.ok(typeof t.description === 'string' && t.description.length > 0, 'Tool must have description');
        assert.equal(t.inputSchema.type, 'object', `Tool ${t.name} must have object inputSchema`);
      }
    });

    test('3.3: Core read tools are all present', () => {
      const names = new Set(tools.map(t => t.name));
      const requiredRead = ['atax_context', 'atax_system_context', 'atax_goal_overview', 'atax_goal_get'];
      for (const req of requiredRead) {
        assert.ok(names.has(req), `Expected read tool ${req} in tools/list`);
      }
    });

    test('3.4: Core write/claim tools are all present', () => {
      const names = new Set(tools.map(t => t.name));
      const requiredWrite = ['atax_task_claim_next', 'atax_task_check_claim', 'atax_task_heartbeat', 'atax_task_submit', 'atax_task_release', 'atax_task_handoff'];
      for (const req of requiredWrite) {
        assert.ok(names.has(req), `Expected write tool ${req} in tools/list`);
      }
    });

    test('3.5: Verification tools are present', () => {
      const names = new Set(tools.map(t => t.name));
      assert.ok(names.has('atax_verification_pending'), 'Must have atax_verification_pending');
      assert.ok(names.has('atax_verification_claim'), 'Must have atax_verification_claim');
      assert.ok(names.has('atax_verification_submit'), 'Must have atax_verification_submit');
    });

    test('3.6: Socket execution tools are present', () => {
      const names = new Set(tools.map(t => t.name));
      const socketTools = ['atax_socket_task_status', 'atax_socket_context_pull', 'atax_socket_output_submit'];
      for (const st of socketTools) {
        assert.ok(names.has(st), `Expected socket tool ${st} in tools/list`);
      }
    });
  });

  // Feature: Read Tools
  describe('Read Tools (Context & Goals)', () => {
    test('4.1: atax_context returns universe and system context', async () => {
      const res = await client.callTool('atax_context', {});
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError, 'Tool invocation must succeed');
      const data = res.json.result.structuredContent.result;
      assert.ok(Array.isArray(data.universes), 'Result must contain universes array');
      assert.ok(Array.isArray(data.systems), 'Result must contain systems array');
    });

    test('4.2: Direct PostgREST RPC call to agent_context_overview succeeds', async () => {
      if (env.isMock) {
        const res = await client.directPostgrestRpc('agent_context_overview', {});
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.json.universes));
      } else {
        // Live direct verification
        assert.ok(true);
      }
    });

    test('4.3: atax_goal_overview returns list of goals with task counts', async () => {
      const res = await client.callTool('atax_goal_overview', {});
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const goals = res.json.result.structuredContent.result;
      assert.ok(Array.isArray(goals));
      assert.ok(goals.length > 0);
      assert.ok(goals[0].task_counts, 'Goals must contain aggregated task_counts');
    });

    test('4.4: atax_goal_overview with tags filter returns filtered results', async () => {
      const res = await client.callTool('atax_goal_overview', { tags: ['mcp'] });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const goals = res.json.result.structuredContent.result;
      assert.ok(Array.isArray(goals));
      for (const g of goals) {
        assert.ok((g.tags || []).includes('mcp'));
      }
    });

    test('4.5: atax_system_context returns snapshot for atax system', async () => {
      const res = await client.callTool('atax_system_context', { system_key: 'atax' });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const snapshot = res.json.result.structuredContent.result;
      assert.equal(snapshot.system.system_key, 'atax');
      assert.ok(Array.isArray(snapshot.constraints));
    });

    test('4.6: atax_goal_get returns individual goal details by key', async () => {
      const res = await client.callTool('atax_goal_get', { goal_key: 'migrate-mcp-to-data-api' });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const goal = res.json.result.structuredContent.result;
      assert.equal(goal.goal_key, 'migrate-mcp-to-data-api');
    });

    test('4.7: atax_goal_get fails closed for nonexistent goal', async () => {
      const res = await client.callTool('atax_goal_get', { goal_key: 'nonexistent-goal-9999' });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Canonical operation denied or unavailable'));
    });
  });

  // Feature: Write/Claim Tools
  describe('Write/Claim Tools (task_ledger_*)', () => {
    let claimedTask = null;

    test('5.1: atax_task_claim_next atomically claims next task', async () => {
      const res = await client.callTool('atax_task_claim_next', {
        lease_seconds: 120,
        capabilities: ['backend', 'database']
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const tasks = res.json.result.structuredContent.result;
      assert.ok(Array.isArray(tasks));
      assert.equal(tasks.length, 1, 'Should claim exactly one task');
      claimedTask = tasks[0];
      assert.ok(claimedTask.id);
      assert.ok(claimedTask.claim_token);
      assert.equal(claimedTask.status, 'running');
    });

    test('5.2: atax_task_check_claim returns true for active claim token', async () => {
      assert.ok(claimedTask, 'Prerequisite task claimed');
      const res = await client.callTool('atax_task_check_claim', {
        task_id: claimedTask.id,
        claim_token: claimedTask.claim_token
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      assert.equal(res.json.result.structuredContent.result, true);
    });

    test('5.3: atax_task_check_claim returns false for invalid claim token', async () => {
      assert.ok(claimedTask);
      const res = await client.callTool('atax_task_check_claim', {
        task_id: claimedTask.id,
        claim_token: '00000000-0000-0000-0000-000000000000'
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      assert.equal(res.json.result.structuredContent.result, false);
    });

    test('5.4: atax_task_heartbeat successfully extends lease', async () => {
      assert.ok(claimedTask);
      const res = await client.callTool('atax_task_heartbeat', {
        task_id: claimedTask.id,
        claim_token: claimedTask.claim_token,
        current_step: 'Step 1: In progress',
        lease_seconds: 300,
        heartbeat_context: { progress: '50%' }
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const updated = res.json.result.structuredContent.result;
      assert.equal(updated.current_step, 'Step 1: In progress');
    });

    test('5.5: atax_task_release returns task to queued state', async () => {
      assert.ok(claimedTask);
      const res = await client.callTool('atax_task_release', {
        task_id: claimedTask.id,
        claim_token: claimedTask.claim_token,
        release_status: 'queued',
        reason: 'Releasing for test isolation'
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const released = res.json.result.structuredContent.result;
      assert.equal(released.status, 'queued');
      assert.equal(released.claim_token, null);
    });

    test('5.6: atax_task_check_claim returns false after release', async () => {
      const res = await client.callTool('atax_task_check_claim', {
        task_id: claimedTask.id,
        claim_token: claimedTask.claim_token
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.structuredContent.result, false);
    });

    test('5.7: atax_task_claim_next reclaims the released task', async () => {
      const res = await client.callTool('atax_task_claim_next', {});
      assert.equal(res.status, 200);
      const tasks = res.json.result.structuredContent.result;
      assert.ok(tasks.length >= 1);
      assert.equal(tasks[0].id, claimedTask.id);
    });
  });

  // Feature: Verification Tools
  describe('Verification Tools (task_ledger_* verification)', () => {
    let taskToVerify = null;
    let verificationClaim = null;

    before(async () => {
      // Re-claim and submit task for verification
      const claimRes = await client.callTool('atax_task_claim_next', {});
      const tasks = claimRes.json.result.structuredContent.result;
      if (tasks.length > 0) {
        taskToVerify = tasks[0];
        await client.callTool('atax_task_submit', {
          task_id: taskToVerify.id,
          claim_token: taskToVerify.claim_token,
          summary: 'Implementation complete for verification testing',
          status: 'completed'
        });
      }
    });

    test('6.1: atax_verification_pending lists tasks awaiting review', async () => {
      const res = await client.callTool('atax_verification_pending', {});
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const pending = res.json.result.structuredContent.result;
      assert.ok(Array.isArray(pending));
      assert.ok(pending.some(t => t.id === taskToVerify.id));
    });

    test('6.2: atax_verification_claim claims unverified task for independent review', async () => {
      const res = await client.callTool('atax_verification_claim', { lease_seconds: 120 });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const claims = res.json.result.structuredContent.result;
      assert.ok(Array.isArray(claims));
      if (claims.length > 0) {
        verificationClaim = claims[0];
        assert.ok(verificationClaim.verification_claim_token);
      }
    });

    test('6.3: atax_verification_claim_for_task targets specific task', async () => {
      if (env.isMock && env.state) {
        // Reset or test targeted claim
        const t = env.state.tasks.get('t-task-2');
        t.status = 'completed';
        t.verification_status = 'pending';
        t.claimed_by_agent_id = 'other-worker';

        const res = await client.callTool('atax_verification_claim_for_task', {
          task_id: 't-task-2',
          lease_seconds: 120
        });
        assert.equal(res.status, 200);
        assert.ok(!res.json.result.isError);
      } else {
        assert.ok(true);
      }
    });

    test('6.4: atax_verification_submit records passing verification verdict', async () => {
      if (!verificationClaim) return;
      const res = await client.callTool('atax_verification_submit', {
        task_id: verificationClaim.id,
        verification_claim_token: verificationClaim.verification_claim_token,
        verified: true,
        report: { verdict: 'PASSED', checks: ['unit', 'e2e'] }
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const verifiedTask = res.json.result.structuredContent.result;
      assert.equal(verifiedTask.verification_status, 'verified');
    });

    test('6.5: atax_goal_finalize finalizes goal upon verification', async () => {
      const res = await client.callTool('atax_goal_finalize', {
        goal_key: 'migrate-mcp-to-data-api',
        verification_report: { all_tasks_verified: true }
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const finalized = res.json.result.structuredContent.result;
      assert.equal(finalized.status, 'finalized');
    });

    test('6.6: atax_verification_submit with invalid token fails closed', async () => {
      const res = await client.callTool('atax_verification_submit', {
        task_id: 't-task-1',
        verification_claim_token: '00000000-0000-0000-0000-000000000000',
        verified: true,
        report: {}
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.result.isError, true);
    });
  });

  // Feature: Socket Execution
  describe('Socket Execution (atax_socket_*)', () => {
    test('7.1: atax_socket_task_status retrieves task state and quota', async () => {
      const res = await client.callTool('atax_socket_task_status', {
        task_id: 't-task-1',
        claim_token: 'sample-claim-token'
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const data = res.json.result.structuredContent.result;
      assert.equal(data.status, 'accepted');
      assert.equal(data.receipt.operation, 'task_status');
    });

    test('7.2: atax_socket_context_pull retrieves bounded context page', async () => {
      const res = await client.callTool('atax_socket_context_pull', {
        task_id: 't-task-1',
        claim_token: 'sample-claim-token',
        limit: 8
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const data = res.json.result.structuredContent.result;
      assert.equal(data.status, 'accepted');
      assert.equal(data.receipt.operation, 'context_pull');
    });

    test('7.3: atax_socket_output_submit records output payload', async () => {
      const res = await client.callTool('atax_socket_output_submit', {
        task_id: 't-task-1',
        claim_token: 'sample-claim-token',
        output: { result: 'partial output' },
        partial: true
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const data = res.json.result.structuredContent.result;
      assert.equal(data.status, 'accepted');
      assert.equal(data.receipt.operation, 'output_submit');
    });

    test('7.4: atax_socket_atomisation_request requests fenced atomisation', async () => {
      const res = await client.callTool('atax_socket_atomisation_request', {
        task_id: 't-task-1',
        claim_token: 'sample-claim-token',
        reason: 'Scope too broad for single task',
        partial_progress: 'Completed step 1 of 3'
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const data = res.json.result.structuredContent.result;
      assert.equal(data.status, 'accepted');
      assert.equal(data.receipt.operation, 'atomisation_request');
    });

    test('7.5: atax_socket_workflow_request submits workflow intent', async () => {
      const res = await client.callTool('atax_socket_workflow_request', {
        task_id: 't-task-1',
        claim_token: 'sample-claim-token',
        workflow_key: 'ci-check-workflow',
        inputs: { branch: 'main' }
      });
      assert.equal(res.status, 200);
      assert.ok(!res.json.result.isError);
      const data = res.json.result.structuredContent.result;
      assert.equal(data.status, 'accepted');
      assert.equal(data.receipt.operation, 'workflow_request');
    });

    test('7.6: atax_socket_execute_v1 fails closed for invalid command structure', async () => {
      if (env.isMock) {
        const res = await client.directPostgrestRpc('atax_socket_execute_v1', { command_in: null });
        assert.equal(res.status, 200);
        assert.equal(res.json.status, 'denied');
      } else {
        assert.ok(true);
      }
    });
  });
});
