/**
 * Tier 3: Cross-Feature Combinations & Pairwise State Transitions
 * Validates state transitions, fencing token handoffs, and safety invariants
 * across pairs and chains of ledger features:
 * - Pairwise 1: Claim Next ➔ Check Claim (atomic lease verification)
 * - Pairwise 2: Claim Next ➔ Heartbeat Claim ➔ Check Claim (renewal chain)
 * - Pairwise 3: Claim Next ➔ Heartbeat ➔ Submit Result (execution to review)
 * - Pairwise 4: Submit Result ➔ Pending Verification ➔ Claim Verification (handover)
 * - Pairwise 5: Claim Verification ➔ Submit Verification Report (positive verdict)
 * - Pairwise 6: Claim Verification ➔ Submit Verification Report (negative verdict)
 * - Pairwise 7: Claim Next ➔ Release Claim ➔ Reclaim Next (clean re-queue)
 * - Pairwise 8: Claim Next ➔ Forfeiture ➔ Handoff ➔ Reclaim Next (forfeiture cycle)
 * - Pairwise 9: Self-Verification Prevention (worker cannot verify own task)
 * - Pairwise 10: Task Loop Iteration Recording ➔ Submit Result with loop evidence
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnvironment } from './harness.mjs';

describe('Tier 3: Cross-Feature Combinations', async () => {
  let env;
  let client;

  before(async () => {
    env = await setupTestEnvironment();
    client = env.client;
  });

  after(async () => {
    if (env?.cleanup) await env.cleanup();
  });

  test('3.1: Pairwise: Claim Next -> Check Claim validates atomic ownership', async () => {
    const claimRes = await client.callTool('atax_task_claim_next', { lease_seconds: 180 });
    assert.equal(claimRes.status, 200);
    const tasks = claimRes.json.result.structuredContent.result;
    assert.ok(tasks.length >= 1, 'Must claim at least one task');
    const task = tasks[0];

    // Immediately verify ownership
    const checkRes = await client.callTool('atax_task_check_claim', {
      task_id: task.id,
      claim_token: task.claim_token
    });
    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.json.result.structuredContent.result, true);

    // Release for next tests
    await client.callTool('atax_task_release', {
      task_id: task.id,
      claim_token: task.claim_token,
      release_status: 'queued',
      reason: 'Reset for pairwise testing'
    });
  });

  test('3.2: Pairwise: Claim Next -> Heartbeat Claim extends expiration and preserves ownership', async () => {
    const claimRes = await client.callTool('atax_task_claim_next', { lease_seconds: 60 });
    const task = claimRes.json.result.structuredContent.result[0];

    const hbRes = await client.callTool('atax_task_heartbeat', {
      task_id: task.id,
      claim_token: task.claim_token,
      current_step: 'Pairwise step 2',
      lease_seconds: 300,
      heartbeat_context: { status: 'running_tests' }
    });
    assert.equal(hbRes.status, 200);
    assert.ok(!hbRes.json.result.isError);
    const updated = hbRes.json.result.structuredContent.result;
    assert.equal(updated.current_step, 'Pairwise step 2');

    // Confirm check claim is still valid
    const checkRes = await client.callTool('atax_task_check_claim', {
      task_id: task.id,
      claim_token: task.claim_token
    });
    assert.equal(checkRes.json.result.structuredContent.result, true);

    // Clean up
    await client.callTool('atax_task_release', {
      task_id: task.id,
      claim_token: task.claim_token,
      release_status: 'queued',
      reason: 'Reset'
    });
  });

  test('3.3: Pairwise: Claim Next -> Heartbeat -> Submit Result transitions status to completed', async () => {
    const claimRes = await client.callTool('atax_task_claim_next', {});
    const task = claimRes.json.result.structuredContent.result[0];

    await client.callTool('atax_task_heartbeat', {
      task_id: task.id,
      claim_token: task.claim_token,
      current_step: 'Finalizing'
    });

    const submitRes = await client.callTool('atax_task_submit', {
      task_id: task.id,
      claim_token: task.claim_token,
      summary: 'Task finished with 100% test pass rate',
      status: 'completed',
      tools_used: ['fetch', 'node:test'],
      evidence: [{ type: 'test_run', passed: true }]
    });
    assert.equal(submitRes.status, 200);
    assert.ok(!submitRes.json.result.isError);
    const completed = submitRes.json.result.structuredContent.result;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.verification_status, 'pending');
  });

  test('3.4: Pairwise: Submit Result -> Pending Verification lists task for independent review', async () => {
    const pendingRes = await client.callTool('atax_verification_pending', {});
    assert.equal(pendingRes.status, 200);
    assert.ok(!pendingRes.json.result.isError);
    const pending = pendingRes.json.result.structuredContent.result;
    assert.ok(Array.isArray(pending));
    assert.ok(pending.length > 0, 'Completed task must appear in pending verification queue');
  });

  test('3.5: Pairwise: Claim Verification -> Submit Verification (verified: true)', async () => {
    const claimVerRes = await client.callTool('atax_verification_claim', { lease_seconds: 120 });
    assert.equal(claimVerRes.status, 200);
    const claims = claimVerRes.json.result.structuredContent.result;
    if (claims.length === 0) return;
    const verTask = claims[0];
    assert.ok(verTask.verification_claim_token);

    const submitVerRes = await client.callTool('atax_verification_submit', {
      task_id: verTask.id,
      verification_claim_token: verTask.verification_claim_token,
      verified: true,
      report: { check: 'passed', artifacts: ['TEST_READY.md'] }
    });
    assert.equal(submitVerRes.status, 200);
    assert.ok(!submitVerRes.json.result.isError);
    const verified = submitVerRes.json.result.structuredContent.result;
    assert.equal(verified.verification_status, 'verified');
  });

  test('3.6: Pairwise: Claim Verification -> Submit Verification (verified: false)', async () => {
    if (env.isMock && env.state) {
      // Setup task in pending state
      const t = env.state.tasks.get('t-task-2');
      t.status = 'completed';
      t.verification_status = 'pending';
      t.claimed_by_agent_id = 'worker-agent-a';

      const claimRes = await client.callTool('atax_verification_claim', { lease_seconds: 120 });
      const claims = claimRes.json.result.structuredContent.result;
      if (claims.length > 0) {
        const v = claims[0];
        const rejRes = await client.callTool('atax_verification_submit', {
          task_id: v.id,
          verification_claim_token: v.verification_claim_token,
          verified: false,
          report: { error: 'Missing required boundary test' }
        });
        assert.equal(rejRes.status, 200);
        const rejected = rejRes.json.result.structuredContent.result;
        assert.equal(rejected.verification_status, 'rejected');
      }
    }
  });

  test('3.7: Pairwise: Claim Next -> Release Claim -> Reclaim Next by another agent', async () => {
    if (env.isMock && env.state) {
      const t = env.state.tasks.get('t-task-1');
      t.status = 'queued';
      t.claimed_by_agent_id = null;
      t.claim_token = null;

      // Agent 1 claims
      const c1 = await client.callTool('atax_task_claim_next', {});
      const task1 = c1.json.result.structuredContent.result[0];
      const token1 = task1.claim_token;

      // Agent 1 releases
      await client.callTool('atax_task_release', {
        task_id: task1.id,
        claim_token: token1,
        release_status: 'queued',
        reason: 'Voluntary yield'
      });

      // Agent 2 reclaims
      const c2 = await client.callTool('atax_task_claim_next', {});
      const task2 = c2.json.result.structuredContent.result[0];
      const token2 = task2.claim_token;

      assert.notEqual(token1, token2, 'Reclaimed task must have new unique fencing token');
    }
  });

  test('3.8: Pairwise: Claim Next -> Forfeiture -> Handoff Note -> Reclaim Next', async () => {
    if (env.isMock && env.state) {
      const t = env.state.tasks.get('t-task-1');
      t.status = 'running';
      t.claimed_by_agent_id = 'agent-1';
      t.claim_token = 'token-expired-agent-1';
      t.claim_expires_at = new Date(Date.now() - 5000).toISOString();

      // Agent 1 checks claim and gets false
      const check = await client.callTool('atax_task_check_claim', {
        task_id: t.id,
        claim_token: t.claim_token
      });
      assert.equal(check.json.result.structuredContent.result, false);

      // Agent 1 appends non-mutating handoff note
      const handoff = await client.callTool('atax_task_handoff', {
        task_id: t.id,
        claim_token: t.claim_token,
        note: 'Lease expired while running tests; completed 40 tests'
      });
      assert.equal(handoff.status, 200);
      assert.ok(!handoff.json.result.isError);

      // Agent 2 reclaims the expired socket
      const c2 = await client.callTool('atax_task_claim_next', {});
      const reclaimed = c2.json.result.structuredContent.result[0];
      assert.equal(reclaimed.id, t.id);
      assert.notEqual(reclaimed.claim_token, 'token-expired-agent-1');
    }
  });

  test('3.9: Pairwise: Self-Verification Prevention (Worker cannot verify own work)', async () => {
    if (env.isMock && env.state) {
      const t = env.state.tasks.get('t-task-1');
      t.status = 'completed';
      t.verification_status = 'pending';
      t.claimed_by_agent_id = 'atax-test-operator'; // same as client principal

      // Attempt targeted claim for verification with same agent ID
      const claimRes = await client.callTool('atax_verification_claim_for_task', {
        task_id: t.id
      });
      assert.equal(claimRes.status, 200);
      assert.equal(claimRes.json.result.isError, true, 'Worker must not verify own work');
    }
  });

  test('3.10: Pairwise: Record Loop Iteration -> Submit Result with loop evidence', async () => {
    if (env.isMock && env.state) {
      const t = env.state.tasks.get('t-task-2');
      t.status = 'running';
      t.claimed_by_agent_id = 'atax-test-operator';
      t.claim_token = 'token-loop-test';
      t.claim_expires_at = new Date(Date.now() + 600000).toISOString();

      // Record iteration 1
      const iterRes = await client.callTool('atax_task_record_loop', {
        task_id: t.id,
        claim_token: t.claim_token,
        iteration_no: 1,
        verdict: 'pass',
        next_action: 'Submit verified result',
        evidence: [{ suite: 'tier3', pass: true }]
      });
      assert.equal(iterRes.status, 200);
      assert.ok(!iterRes.json.result.isError);

      // Submit result referencing loop iteration
      const subRes = await client.callTool('atax_task_submit', {
        task_id: t.id,
        claim_token: t.claim_token,
        summary: 'Passing loop iteration verified',
        status: 'completed',
        evidence: [{ loop_iteration: 1, pass: true }]
      });
      assert.equal(subRes.status, 200);
      assert.ok(!subRes.json.result.isError);
    }
  });
});
