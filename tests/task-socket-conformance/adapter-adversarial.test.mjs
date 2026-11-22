// Agent K integration-neutral negative gates. Same suite runs with the mock or an
// external disposable adapter; never import an A-D runtime from this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { MockSocket } from './mock-socket.mjs';

const external = process.env.ATAX_SOCKET_CONFORMANCE_ADAPTER;
const createAdapter = external
  ? (await import(pathToFileURL(resolve(external)).href)).createAdapter
  : options => new MockSocket(options);
if (typeof createAdapter !== 'function') throw new TypeError('Expected createAdapter(options)');
const label = external ? 'integrated' : 'mock';
const rejects = (action, code) => assert.rejects(async () => action(), error => error?.code === code, 'expected ' + code);
const children = () => ['child-a', 'child-b'].map(id => ({ id, input: 'bounded input', output: 'bounded output',
  acceptance: 'independently verifiable result', verifier: 'third-party auditor',
  actions: ['one finite action'], dependsOn: [] }));
const request = (changes = {}) => ({ target: 'approved-repo', revision: 'rev-immutable', operation: 'test',
  inputContract: 'bounded', outputContract: 'signed result', correlationId: 'corr-one',
  idempotencyKey: 'idem-one', ...changes });
async function setup(options) {
  const s = await createAdapter(options);
  await s.createTask('root');
  const id = await s.claim('root', { agent: 'executor', session: 'session-1' });
  return { s, id };
}
test(label + ': mixed input/output/retry consumption cannot reset at exact boundary', async () => {
  const { s, id } = await setup({ budget: 16 });
  await s.pull(id, 5, 'context'); await s.push(id, 4, 'generation');
  await s.pull(id, 5, 'identical-context-retry'); await s.push(id, 2, 'tool-output');
  assert.equal((await s.usage('root')).total, 16);
  assert.equal((await s.reconnect(id)).total, 16);
  await rejects(() => s.pull(id, 1, 'hidden-context-reset'), 'CONTEXT_OVERFLOW');
  assert.equal((await s.usage('root')).total, 17);
  await rejects(() => s.push(id, 1, 'post-overflow'), 'NOT_EXECUTABLE');
});
test(label + ': unknown and invalid token counts fail closed', async () => {
  const { s, id } = await setup({ budget: 20 });
  for (const n of [null, undefined, -1, 0, 1.2, NaN]) {
    await rejects(() => s.pull(id, n, 'invalid-provider-meter'), 'INVALID_METERING');
  }
  assert.equal((await s.usage('root')).total, 0);
});
test(label + ': principal, child-session and fence substitution are denied', async () => {
  const { s, id } = await setup();
  for (const forged of [
    { ...id, session: 'other-session' }, { ...id, agent: 'other-agent' },
    { ...id, fence: 'forged-fence' }, { ...id, taskId: 'other-task' }
  ]) {
    const code = forged.taskId !== id.taskId ? 'TASK_NOT_FOUND' : 'STALE_OR_FORGED_CLAIM';
    await rejects(() => s.pull(forged, 1), code);
  }
  assert.equal((await s.usage('root')).total, 0);
});
test(label + ': expired claimant cannot restart context; successor retains meter', async () => {
  const { s, id } = await setup({ budget: 25 });
  await s.pull(id, 10); await s.tick(121);
  await rejects(() => s.pull(id, 1), 'STALE_OR_FORGED_CLAIM');
  const newer = await s.claim('root', { agent: 'incoming', session: 'session-2' });
  assert.notEqual(newer.fence, id.fence);
  assert.equal((await s.reconnect(newer)).total, 10);
  await rejects(() => s.push(id, 1), 'STALE_OR_FORGED_CLAIM');
});
test(label + ': direct writes, credentials and unrestricted APIs remain unavailable', async () => {
  const { s, id } = await setup();
  for (const operation of ['git.push', 'repository.edit', 'workflow.write']) {
    await rejects(() => s.directTarget(id, operation), 'DIRECT_TARGET_ACCESS_FORBIDDEN');
  }
  await rejects(() => s.readCredential(id), 'RAW_CREDENTIAL_FORBIDDEN');
  await rejects(() => s.unrestrictedFetch(id), 'UNRESTRICTED_API_FORBIDDEN');
});
test(label + ': oversize output forces stop, cannot submit or re-claim', async () => {
  const { s, id } = await setup({ budget: 8 });
  await rejects(() => s.push(id, 9, 'oversized-output'), 'CONTEXT_OVERFLOW');
  assert.equal((await s.usage('root')).output, 9);
  await rejects(() => s.submit(id, { evidence: 'fake', output: 'fake' }), 'NOT_EXECUTABLE');
  await rejects(() => s.claim('root', { agent: 'executor', session: 'session-reset' }), 'NOT_CLAIMABLE');
});
test(label + ': only independent atomic planner may atomize, once', async () => {
  const { s, id } = await setup({ budget: 2 });
  await rejects(() => s.pull(id, 3), 'CONTEXT_OVERFLOW');
  const rev = (await s.get('root')).revisionCounter;
  await rejects(() => s.atomize('root', { planner: 'executor', expectedRevision: rev, children: children() }), 'INDEPENDENT_PLANNER_REQUIRED');
  await rejects(() => s.atomize('root', { planner: 'planner', expectedRevision: rev - 1, children: children() }), 'CONCURRENT_SPLIT_CONFLICT');
  await s.atomize('root', { planner: 'planner', expectedRevision: rev, children: children() });
  await rejects(() => s.atomize('root', { planner: 'second-planner', expectedRevision: rev, children: children() }), 'NOT_STOPPED');
  assert.equal((await s.get('root')).children.length, 2);
  await rejects(() => s.claim('child-a', { agent: 'executor', session: 'reset' }), 'SEPARATE_AGENT_REQUIRED');
  const successor = await s.claim('child-a', { agent: 'child-executor', session: 'new-session' });
  await rejects(() => s.pull({ ...successor, session: 'root-session' }, 1), 'STALE_OR_FORGED_CLAIM');
});
test(label + ': invalid dependencies cannot partially insert children', async () => {
  const { s, id } = await setup({ budget: 1 });
  await rejects(() => s.pull(id, 2), 'CONTEXT_OVERFLOW');
  const revision = (await s.get('root')).revisionCounter;
  const list = children();
  list[0].dependsOn = ['child-b']; list[1].dependsOn = ['child-a'];
  await rejects(() => s.atomize('root', { planner: 'planner', expectedRevision: revision, children: list }), 'DEPENDENCY_CYCLE');
  assert.equal((await s.get('root')).children.length, 0);
  await rejects(() => s.get('child-a'), 'TASK_NOT_FOUND');
});
test(label + ': outbox correlation, bounded results and idempotency are mandatory', async () => {
  const { s, id } = await setup({ maxPayloadBytes: 512 });
  const job = await s.requestWorkflow(id, request());
  assert.equal((await s.requestWorkflow(id, request())).id, job.id);
  await rejects(() => s.requestWorkflow(id, request({ operation: 'change' })), 'IDEMPOTENCY_COLLISION');
  await rejects(() => s.dispatchAck(job.id, { correlationId: 'forged', fence: id.fence }), 'DISPATCH_CORRELATION_MISMATCH');
  await s.dispatchAck(job.id, { correlationId: job.correlationId, fence: id.fence });
  await rejects(() => s.dispatchFinish(job.id, { correlationId: job.correlationId, fence: 'forged', result: { evidence: 'fake' } }), 'DISPATCH_CORRELATION_MISMATCH');
  await rejects(() => s.dispatchFinish(job.id, { correlationId: job.correlationId, fence: id.fence, result: { evidence: 'x'.repeat(1000) } }), 'OVERSIZED_EXECUTION_RESULT');
  await rejects(() => s.submit(id, { evidence: 'fake', output: 'fake' }), 'DISPATCH_NOT_COMPLETE');
});
test(label + ': failed delegated job cannot be promoted into verified completion', async () => {
  const { s, id } = await setup();
  const job = await s.requestWorkflow(id, request());
  await s.dispatchAck(job.id, { correlationId: job.correlationId, fence: id.fence });
  await s.dispatchFinish(job.id, { correlationId: job.correlationId, fence: id.fence,
    result: { evidence: 'job failed' }, success: false });
  await rejects(() => s.submit(id, { evidence: 'claimed success', output: 'fake' }), 'DISPATCH_NOT_COMPLETE');
});
test(label + ': verifier must be independent and negative evaluation is terminal rejection', async () => {
  const { s, id } = await setup();
  const job = await s.requestWorkflow(id, request());
  await s.dispatchAck(job.id, { correlationId: job.correlationId, fence: id.fence });
  await s.dispatchFinish(job.id, { correlationId: job.correlationId, fence: id.fence,
    result: { evidence: 'terminal immutable evidence' } });
  await s.submit(id, { evidence: 'signed result', output: 'bounded output' });
  await rejects(() => s.verify('root', { verifier: 'executor', pass: true, report: 'self-approved' }), 'INDEPENDENT_VERIFIER_REQUIRED');
  assert.equal(await s.verify('root', { verifier: 'independent-auditor', pass: false, report: 'failed acceptance' }), 'rejected');
  await rejects(() => s.verify('root', { verifier: 'another-auditor', pass: true, report: 'retroactive approval' }), 'NOT_PENDING_VERIFICATION');
});
