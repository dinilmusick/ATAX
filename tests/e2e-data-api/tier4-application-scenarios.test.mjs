/**
 * Tier 4: Real-World Application Scenarios (Lifecycles & Workloads)
 * Implements full realistic end-to-end task loop lifecycles and operational workflows:
 * - Scenario 4.1: Complete End-to-End Autonomous Agent Execution & Independent Verification
 * - Scenario 4.2: Ephemeral Lease Forfeiture & Safe Handoff Recovery
 * - Scenario 4.3: Restricted Task Socket Metered Execution Lifecycle
 * - Scenario 4.4: High-Concurrency Multi-Agent Contention & Mutual Exclusion
 * - Scenario 4.5: Goal Authoring, Priority Adjustment & Dependency Graph Lifecycle
 * - Scenario 4.6: Bounded Omni Loop Iteration Failure & Remediation Sequence
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnvironment } from './harness.mjs';

describe('Tier 4: Real-World Application Scenarios', async () => {
  let env;
  let client;

  before(async () => {
    env = await setupTestEnvironment();
    client = env.client;
  });

  after(async () => {
    if (env?.cleanup) await env.cleanup();
  });

  test('4.1: Complete End-to-End Autonomous Task Execution & Independent Verification Lifecycle', async () => {
    // Phase 1: Agent Handshake & Orientation
    const initRes = await client.initialize('2025-06-18', { name: 'autonomous-worker-1', version: '2.0.0' });
    assert.equal(initRes.status, 200);

    const toolsRes = await client.toolsList();
    assert.equal(toolsRes.status, 200);
    assert.ok(toolsRes.json.result.tools.length >= 15);

    // Phase 2: Substrate Hydration
    const ctxRes = await client.callTool('atax_context', {});
    assert.equal(ctxRes.status, 200);
    const substrate = ctxRes.json.result.structuredContent.result;
    assert.ok(substrate.systems.length > 0);

    const goalsRes = await client.callTool('atax_goal_overview', {});
    assert.equal(goalsRes.status, 200);
    const goals = goalsRes.json.result.structuredContent.result;
    assert.ok(goals.length > 0);

    // Phase 3: Atomic Task Claim
    const claimRes = await client.callTool('atax_task_claim_next', { lease_seconds: 120 });
    assert.equal(claimRes.status, 200);
    const tasks = claimRes.json.result.structuredContent.result;
    assert.ok(tasks.length >= 1);
    const task = tasks[0];
    const taskId = task.id;
    const claimToken = task.claim_token;

    // Phase 4: Fencing Token Verification
    const checkRes = await client.callTool('atax_task_check_claim', {
      task_id: taskId,
      claim_token: claimToken
    });
    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.json.result.structuredContent.result, true);

    // Phase 5: Periodic Heartbeat & Progress Reporting
    const hbRes = await client.callTool('atax_task_heartbeat', {
      task_id: taskId,
      claim_token: claimToken,
      current_step: 'Step 1: Reading PostgREST schema specifications',
      lease_seconds: 300,
      heartbeat_context: { progress: '25%', blocker: null }
    });
    assert.equal(hbRes.status, 200);
    assert.ok(!hbRes.json.result.isError);

    // Phase 6: Omni Loop Iteration Recording
    const loopRes = await client.callTool('atax_task_record_loop', {
      task_id: taskId,
      claim_token: claimToken,
      iteration_no: 1,
      verdict: 'pass',
      next_action: 'Proceed to submit result with evidence',
      evidence: [{ step: 'fetch_adapter_tested', result: 'all_pass' }]
    });
    assert.equal(loopRes.status, 200);
    assert.ok(!loopRes.json.result.isError);

    // Phase 7: Result Submission for Independent Review
    const submitRes = await client.callTool('atax_task_submit', {
      task_id: taskId,
      claim_token: claimToken,
      summary: 'Data API adapter implementation fully verified against PostgREST RPC',
      status: 'completed',
      tools_used: ['fetch', 'node:test', 'mock-server'],
      evidence: [{ artifact: 'data-api-ledger.mjs', tests: 40, passed: 40 }]
    });
    assert.equal(submitRes.status, 200);
    assert.ok(!submitRes.json.result.isError);

    // Phase 8: Independent Verification Discovery
    const pendingRes = await client.callTool('atax_verification_pending', {});
    assert.equal(pendingRes.status, 200);
    const pendingTasks = pendingRes.json.result.structuredContent.result;
    assert.ok(pendingTasks.some(t => t.id === taskId));

    // Phase 9: Independent Verifier Claims Task
    const claimVerRes = await client.callTool('atax_verification_claim', { lease_seconds: 180 });
    assert.equal(claimVerRes.status, 200);
    const claims = claimVerRes.json.result.structuredContent.result;
    if (claims.length > 0) {
      const verClaim = claims[0];
      const verToken = verClaim.verification_claim_token;

      // Phase 10: Independent Verifier Evaluates Evidence & Submits Verdict
      const submitVerRes = await client.callTool('atax_verification_submit', {
        task_id: verClaim.id,
        verification_claim_token: verToken,
        verified: true,
        report: {
          verifier: 'independent-qa-agent',
          checks_executed: ['opaque-box-tests', 'payload-limits', 'fencing-safety'],
          verdict: 'ACCEPTED_AND_VERIFIED'
        }
      });
      assert.equal(submitVerRes.status, 200);
      assert.ok(!submitVerRes.json.result.isError);
      assert.equal(submitVerRes.json.result.structuredContent.result.verification_status, 'verified');

      // Phase 11: Goal Finalization
      const finalizeRes = await client.callTool('atax_goal_finalize', {
        goal_key: 'migrate-mcp-to-data-api',
        verification_report: { verified_tasks: [taskId], status: 'all_verified' }
      });
      assert.equal(finalizeRes.status, 200);
      assert.ok(!finalizeRes.json.result.isError);
      assert.equal(finalizeRes.json.result.structuredContent.result.status, 'finalized');
    }
  });

  test('4.2: Ephemeral Lease Forfeiture & Safe Handoff Recovery Scenario', async () => {
    if (env.isMock && env.state) {
      // Setup Task 1 with an expired lease held by Agent-1
      const t = env.state.tasks.get('t-task-1');
      t.status = 'running';
      t.claimed_by_agent_id = 'agent-1';
      t.claim_token = 'token-agent-1';
      t.claim_expires_at = new Date(Date.now() - 10000).toISOString();

      // Step 1: Agent 1 checks claim and detects lease loss
      const check1 = await client.callTool('atax_task_check_claim', {
        task_id: t.id,
        claim_token: t.claim_token
      });
      assert.equal(check1.json.result.structuredContent.result, false, 'Expired lease must return false');

      // Step 2: Agent 1 writes bounded handoff note without modifying canonical task state
      const handoff = await client.callTool('atax_task_handoff', {
        task_id: t.id,
        claim_token: t.claim_token,
        note: 'Lease expired during test run. Steps 1-3 complete. Step 4 remaining.',
        context: { completed_steps: [1, 2, 3], pending: 4 }
      });
      assert.equal(handoff.status, 200);
      assert.ok(!handoff.json.result.isError);

      // Step 3: Agent 2 claims the now-available task socket
      const claim2 = await client.callTool('atax_task_claim_next', { lease_seconds: 180 });
      assert.equal(claim2.status, 200);
      const reclaimed = claim2.json.result.structuredContent.result[0];
      assert.equal(reclaimed.id, t.id);
      assert.notEqual(reclaimed.claim_token, 'token-agent-1', 'Agent 2 must receive a new fencing token');

      // Step 4: Agent 2 completes remaining step and submits
      const submit2 = await client.callTool('atax_task_submit', {
        task_id: reclaimed.id,
        claim_token: reclaimed.claim_token,
        summary: 'Agent 2 completed step 4 after recovery',
        status: 'completed'
      });
      assert.equal(submit2.status, 200);
      assert.ok(!submit2.json.result.isError);
    }
  });

  test('4.3: Restricted Task Socket Metered Execution Lifecycle', async () => {
    const taskId = 't-task-1';
    const claimToken = 'socket-test-claim-token';

    // Step 1: Pull bounded context page
    const pullRes = await client.callTool('atax_socket_context_pull', {
      task_id: taskId,
      claim_token: claimToken,
      cursor: 'page-0',
      limit: 5
    });
    assert.equal(pullRes.status, 200);
    assert.ok(!pullRes.json.result.isError);
    const pullReceipt = pullRes.json.result.structuredContent.result;
    assert.equal(pullReceipt.status, 'accepted');
    assert.ok(pullReceipt.receipt.inboundTokens > 0);

    // Step 2: Query task socket status and quota
    const statusRes = await client.callTool('atax_socket_task_status', {
      task_id: taskId,
      claim_token: claimToken
    });
    assert.equal(statusRes.status, 200);
    assert.ok(!statusRes.json.result.isError);
    const statusReceipt = statusRes.json.result.structuredContent.result;
    assert.equal(statusReceipt.status, 'accepted');

    // Step 3: Submit bounded task output
    const outRes = await client.callTool('atax_socket_output_submit', {
      task_id: taskId,
      claim_token: claimToken,
      output: { tests_passed: 40, coverage: '100%' },
      partial: false
    });
    assert.equal(outRes.status, 200);
    assert.ok(!outRes.json.result.isError);
    assert.equal(outRes.json.result.structuredContent.result.status, 'accepted');

    // Step 4: Submit workflow dispatch intent
    const wfRes = await client.callTool('atax_socket_workflow_request', {
      task_id: taskId,
      claim_token: claimToken,
      workflow_key: 'ci-dispatch',
      inputs: { target: 'deploy-check' }
    });
    assert.equal(wfRes.status, 200);
    assert.ok(!wfRes.json.result.isError);
    assert.equal(wfRes.json.result.structuredContent.result.status, 'accepted');
  });

  test('4.4: High-Concurrency Multi-Agent Contention & Mutual Exclusion', async () => {
    if (env.isMock && env.state) {
      // Reset tasks to queued
      for (const t of env.state.tasks.values()) {
        t.status = 'queued';
        t.claimed_by_agent_id = null;
        t.claim_token = null;
      }

      // Simulate 5 concurrent claim requests
      const concurrentClaims = await Promise.all([
        client.callTool('atax_task_claim_next', { lease_seconds: 60 }),
        client.callTool('atax_task_claim_next', { lease_seconds: 60 }),
        client.callTool('atax_task_claim_next', { lease_seconds: 60 }),
        client.callTool('atax_task_claim_next', { lease_seconds: 60 }),
        client.callTool('atax_task_claim_next', { lease_seconds: 60 })
      ]);

      const successfullyClaimedTasks = [];
      const usedClaimTokens = new Set();

      for (const res of concurrentClaims) {
        assert.equal(res.status, 200);
        const tasks = res.json.result.structuredContent.result;
        for (const t of tasks) {
          successfullyClaimedTasks.push(t);
          assert.ok(!usedClaimTokens.has(t.claim_token), 'Fencing token must be strictly unique');
          usedClaimTokens.add(t.claim_token);
        }
      }

      // Max claims possible is the total number of queued tasks (2 tasks)
      assert.ok(successfullyClaimedTasks.length <= 2, `Cannot over-allocate claims: got ${successfullyClaimedTasks.length}`);
    }
  });

  test('4.5: Goal Authoring, Priority Adjustment & Dependency Graph Lifecycle', async () => {
    if (env.isMock) {
      // Update goal priority
      const prioRes = await client.directPostgrestRpc('goal_ledger_set_priority', {
        goal_key_in: 'migrate-mcp-to-data-api',
        priority_in: 0.95
      });
      assert.equal(prioRes.status, 200);
      assert.equal(prioRes.json.priority, 0.95);

      // Verify updated goal in overview
      const ovRes = await client.callTool('atax_goal_overview', {});
      assert.equal(ovRes.status, 200);
      const goals = ovRes.json.result.structuredContent.result;
      const targetGoal = goals.find(g => g.goal_key === 'migrate-mcp-to-data-api');
      assert.ok(targetGoal);
      assert.equal(targetGoal.priority, 0.95);
    }
  });

  test('4.6: Bounded Omni Loop Iteration Failure & Remediation Flow', async () => {
    if (env.isMock && env.state) {
      const t = env.state.tasks.get('t-task-2');
      t.status = 'running';
      t.claimed_by_agent_id = 'atax-test-operator';
      t.claim_token = 'token-remediation';
      t.claim_expires_at = new Date(Date.now() + 600000).toISOString();

      // Step 1: Record failing iteration
      const failIter = await client.callTool('atax_task_record_loop', {
        task_id: t.id,
        claim_token: t.claim_token,
        iteration_no: 1,
        verdict: 'fail',
        next_action: 'Apply boundary sanitization patch',
        observation: { error: 'Payload exceeded 1MB unhandled' }
      });
      assert.equal(failIter.status, 200);
      assert.ok(!failIter.json.result.isError);

      // Step 2: Record passing iteration after fix
      const passIter = await client.callTool('atax_task_record_loop', {
        task_id: t.id,
        claim_token: t.claim_token,
        iteration_no: 2,
        verdict: 'pass',
        next_action: 'Submit remediation result',
        evidence: [{ patch: 'payload-limit-guard', passed: true }]
      });
      assert.equal(passIter.status, 200);
      assert.ok(!passIter.json.result.isError);

      // Step 3: Submit final result with both iterations tracked
      const submit = await client.callTool('atax_task_submit', {
        task_id: t.id,
        claim_token: t.claim_token,
        summary: 'Fixed payload limit failure in iteration 2',
        status: 'completed',
        evidence: [{ iteration: 2, status: 'pass' }]
      });
      assert.equal(submit.status, 200);
      assert.ok(!submit.json.result.isError);
      assert.equal(submit.json.result.structuredContent.result.loop_iterations.length, 2);
    }
  });
});
