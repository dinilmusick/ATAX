// Public integration seam. No imports from any ATAX production component.
// Reconciler supplies createAdapter() implementing the MockSocket surface.
import assert from 'node:assert/strict';
import test from 'node:test';

export const CONTRACT_VERSION = 'task-socket-v1.0.0';
const rejectCode = async (operation, code) => {
  await assert.rejects(async () => operation(), e => e?.code === code, `expected ${code}`);
};
const child = id => ({ id, input: 'bounded input', output: 'bounded output',
  acceptance: 'one independent verifiable result', verifier: 'independent reviewer',
  actions: ['one scoped action'], dependsOn: [] });
const request = () => ({ target: 'approved-repo', revision: 'rev-immutable',
  operation: 'test', inputContract: 'bounded', outputContract: 'signed result',
  correlationId: 'integration-correlation-1', idempotencyKey: 'idem-1' });

/**
 * Adapter methods (sync or async): createTask, claim, pull, push, usage, atomize,
 * get, requestWorkflow, dispatchAck, dispatchFinish, submit, verify, directTarget,
 * tick, reconnect. createAdapter options: {budget, maxPayloadBytes}.
 * Error shape: {code: stable uppercase machine code}.
 */
export function registerAdapterConformance(createAdapter, suiteName = 'adapter') {
  test(`${suiteName}: metering is cumulative across reconnect and repeated tools`, async () => {
    const s = await createAdapter({ budget: 24 });
    await s.createTask('root');
    const id = await s.claim('root', { agent: 'author', session: 'first' });
    await s.pull(id, 9, 'chunk'); await s.pull(id, 9, 'repeat');
    assert.equal((await s.reconnect(id)).total, 18);
    await rejectCode(() => s.push(id, 7, 'output'), 'CONTEXT_OVERFLOW');
    const usage = await s.usage('root');
    assert.equal(usage.total, 25);
    assert.equal(usage.state, 'stopped_overflow');
  });

  test(`${suiteName}: input-only overflow atomizes; child executed by later agent`, async () => {
    const s = await createAdapter({ budget: 12 });
    await s.createTask('root'); const id = await s.claim('root', { agent: 'author', session: 'first' });
    await rejectCode(() => s.pull(id, 13, 'oversized'), 'CONTEXT_OVERFLOW');
    await rejectCode(() => s.pull(id, 1, 'after-stop'), 'NOT_EXECUTABLE');
    const p = await s.get('root');
    await s.atomize('root', { planner: 'independent-planner', expectedRevision: p.revisionCounter,
      children: [child('child-a'), child('child-b')] });
    await rejectCode(() => s.claim('child-a', { agent: 'author', session: 'second' }), 'SEPARATE_AGENT_REQUIRED');
    const later = await s.claim('child-a', { agent: 'later-agent', session: 'second' });
    const d = await s.requestWorkflow(later, request());
    await s.dispatchAck(d.id, { correlationId: d.correlationId, fence: later.fence });
    await s.dispatchFinish(d.id, { correlationId: d.correlationId, fence: later.fence, result: { evidence: 'trusted job' } });
    await s.submit(later, { evidence: 'signed result', output: 'expected output' });
    await rejectCode(() => s.verify('child-a', { verifier: 'later-agent', pass: true, report: 'self' }), 'INDEPENDENT_VERIFIER_REQUIRED');
    assert.equal(await s.verify('child-a', { verifier: 'other-auditor', pass: true, report: 'validated artifact' }), 'completed');
  });

  test(`${suiteName}: direct target mutation is rejected`, async () => {
    const s = await createAdapter(); await s.createTask('root');
    const id = await s.claim('root', { agent: 'author', session: 'first' });
    await rejectCode(() => s.directTarget(id, 'git.push'), 'DIRECT_TARGET_ACCESS_FORBIDDEN');
  });

  test(`${suiteName}: stale lease and forged principal are rejected`, async () => {
    const s = await createAdapter(); await s.createTask('root');
    const id = await s.claim('root', { agent: 'author', session: 'first', leaseSeconds: 120 });
    await rejectCode(() => s.pull({ ...id, agent: 'impostor' }, 1), 'STALE_OR_FORGED_CLAIM');
    await s.tick(121);
    await rejectCode(() => s.pull(id, 1), 'STALE_OR_FORGED_CLAIM');
  });

  test(`${suiteName}: premature result submission and unauthorized revision rejected`, async () => {
    const s = await createAdapter(); await s.createTask('root');
    const id = await s.claim('root', { agent: 'author', session: 'first' });
    await rejectCode(() => s.requestWorkflow(id, { ...request(), revision: 'mutable-main' }), 'UNAUTHORIZED_TARGET_OR_REVISION');
    await rejectCode(() => s.submit(id, { evidence: 'fake', output: 'fake' }), 'DISPATCH_NOT_COMPLETE');
  });
}