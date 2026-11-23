import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MockSocket } from './mock-socket.mjs';
import { determineCeiling, deriveReliableCeiling } from './calibration.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const models = JSON.parse(readFileSync(join(dir, 'model-profiles.json'), 'utf8'));
const synthetic = JSON.parse(readFileSync(join(dir, 'fixtures/calibration-synthetic.json'), 'utf8'));
const err = (fn, code) => assert.throws(fn, e => e.code === code, `expected ${code}`);
const valid = (id, dependsOn = []) => ({ id, input: 'bounded input', output: 'bounded output',
  acceptance: 'single independently verifiable outcome', verifier: 'independent agent',
  actions: ['perform a finite action'], dependsOn });
const req = (overrides = {}) => ({ target: 'approved-repo', revision: 'rev-immutable',
  operation: 'test', inputContract: 'bounded request', outputContract: 'signed results',
  correlationId: 'correl-1', idempotencyKey: 'idem-1', ...overrides });
function setup(budget = 100) {
  const s = new MockSocket({ budget }); s.createTask('root');
  const a = s.claim('root', { agent: 'agent-A', session: 'session-1' }); return { s, a };
}
function successful(s, taskId, agent, session) {
  const id = s.claim(taskId, { agent, session });
  const r = s.requestWorkflow(id, req({ idempotencyKey: taskId, correlationId: `correl-${taskId}` }));
  s.dispatchAck(r.id, { correlationId: r.correlationId, fence: id.fence });
  s.dispatchFinish(r.id, { correlationId: r.correlationId, fence: id.fence, result: { evidence: `evidence-${taskId}` } });
  s.submit(id, { evidence: 'repository test result', output: 'expected artifact' });
  s.verify(taskId, { verifier: `verifier-${taskId}`, pass: true, report: 'independently checked artifact' });
}

test('all five model-provider families represented with cited versioned IDs and explicit unknown capacities', () => {
  assert.equal(models.schemaVersion, 1);
  assert.deepEqual(new Set(models.profiles.map(p => p.provider)), new Set(['google', 'anthropic', 'openai', 'xai', 'cerebras', 'unknown']));
  for (const profile of models.profiles) {
    assert.ok(profile.key && profile.model && profile.tier && profile.publishedContext);
    assert.ok(profile.contextTokens === null || (Number.isSafeInteger(profile.contextTokens) && profile.contextTokens > 0));
    assert.ok(profile.maxOutputTokens === null || (Number.isSafeInteger(profile.maxOutputTokens) && profile.maxOutputTokens > 0));
    assert.equal(profile.reliableCeilingTokens, null, 'no synthetic observation may masquerade as a measurement');
    if (profile.provider !== 'unknown') assert.ok(profile.source?.startsWith('https://'));
  }
});

test('40 percent is a strict inclusive maximum, with explicit reserved context and output cap', () => {
  for (const profile of models.profiles) {
    const r = determineCeiling(profile, models.policy);
    if (profile.contextTokens) {
      assert.ok(r.usableTokens <= Math.floor(profile.contextTokens * 0.4));
      assert.ok(r.usableTokens <= profile.contextTokens - models.policy.systemReserveTokens - models.policy.generationReserveTokens);
    } else {
      assert.ok(r.usableTokens <= models.policy.unknownModelFallbackTokens);
    }
    if (profile.maxOutputTokens) {
      assert.equal(r.maxOutputTokens, profile.maxOutputTokens);
      assert.ok(r.outputLimitTokens <= profile.maxOutputTokens);
    } else {
      assert.equal(r.maxOutputTokens, null);
      assert.ok(r.outputLimitTokens <= models.policy.unknownOutputFallbackTokens);
    }
  }
  assert.equal(determineCeiling({ contextTokens: 1000, maxOutputTokens: 100 }, { ...models.policy, systemReserveTokens: 300, generationReserveTokens: 400 }).usableTokens, 300);
  assert.equal(determineCeiling({ contextTokens: 10000 }, { ...models.policy, systemReserveTokens: 2048, generationReserveTokens: 4096 }).usableTokens, 3856);
});

test('a lower externally observed reliable ceiling wins, not vice versa', () => {
  const p = models.profiles.find(p => p.provider === 'openai');
  assert.equal(determineCeiling(p, models.policy, 1200).usableTokens, 1200);
  assert.ok(determineCeiling(p, models.policy, 500000).usableTokens <= Math.floor(p.contextTokens * 0.4));
  assert.throws(() => determineCeiling(p, models.policy, -1), /invalid reliability cap/);
  assert.throws(() => determineCeiling(p, { ...models.policy, defaultContextFraction: 0.7 }), /unsafe policy/);
});

test('calibration cannot pass with synthetic, missing, or one-off evidence', () => {
  assert.throws(() => deriveReliableCeiling(synthetic), /missing independently reproducible/);
  const r = { ...synthetic, kind: 'provider-observation', trials: synthetic.trials.slice(0, 1) };
  assert.equal(deriveReliableCeiling(r), null);
  assert.throws(() => deriveReliableCeiling({ kind: 'provider-observation', trials: [] }), /missing independently reproducible/);
});

test('repeatable provider-style fixture yields first reliably passing contiguous threshold only', () => {
  const trials = [];
  for (const n of [1000, 2000, 3000]) for (const index of [0, 1, 2]) trials.push({ budgetTokens: n, success: n !== 3000 || index !== 2, responseId: `${n}-${index}` });
  const record = { kind: 'provider-observation', provenance: { provider: 'fake', model: 'mock-v1', observedAt: '2026-11-22', tokenizer: 'mock-exact', responseIds: trials.map(t => t.responseId) }, trials };
  assert.equal(deriveReliableCeiling(record), 2000);
  assert.equal(deriveReliableCeiling(record, 0.65), 3000);
  assert.throws(() => deriveReliableCeiling({ ...record, trials: [{ budgetTokens: 4000, success: true, responseId: 'fabricated' }] }), /unreferenced response/);
});

test('normal bounded completion requires delegated success and independent result verification', () => {
  const { s, a } = setup();
  s.pull(a, 12); s.push(a, 4); s.checkpoint(a, 'partial verifiable output');
  const d = s.requestWorkflow(a, req());
  err(() => s.submit(a, { evidence: 'artifact', output: 'done' }), 'DISPATCH_NOT_COMPLETE');
  s.dispatchAck(d.id, { correlationId: 'correl-1', fence: a.fence });
  s.dispatchFinish(d.id, { correlationId: 'correl-1', fence: a.fence, result: { evidence: 'trusted CI result' } });
  assert.equal(s.submit(a, { evidence: 'artifact', output: 'done' }), 'pending_verification');
  err(() => s.verify('root', { verifier: 'agent-A', pass: true, report: 'own check' }), 'INDEPENDENT_VERIFIER_REQUIRED');
  assert.equal(s.verify('root', { verifier: 'auditor', pass: true, report: 'verified artifact' }), 'completed');
});

test('overflow -> non-executable -> atomise -> later other agent executes child -> independent verification', () => {
  const { s, a } = setup(40);
  s.checkpoint(a, 'safe partial result'); s.pull(a, 30, 'tool-return');
  err(() => s.push(a, 11, 'generation'), 'CONTEXT_OVERFLOW');
  assert.deepEqual(s.usage('root'), { input: 30, output: 11, total: 41, state: 'stopped_overflow', events: 2 });
  err(() => s.pull(a, 1), 'NOT_EXECUTABLE');
  err(() => s.submit(a, { evidence: 'x', output: 'x' }), 'NOT_EXECUTABLE');
  const root = s.get('root');
  assert.deepEqual(s.atomize('root', { planner: 'planner-B', expectedRevision: root.revisionCounter,
    children: [valid('child-1'), valid('child-2', ['child-1'])] }), ['child-1', 'child-2']);
  assert.equal(s.get('root').status, 'atomized');
  assert.deepEqual(s.get('root').atomization.evidence, ['safe partial result']);
  err(() => s.claim('child-1', { agent: 'agent-A', session: 'new-session' }), 'SEPARATE_AGENT_REQUIRED');
  successful(s, 'child-1', 'agent-C', 'new-session');
  successful(s, 'child-2', 'agent-D', 'next-session');
  assert.equal(s.finalizeParent('root', { verifier: 'final-auditor' }), 'completed');
});

test('output-only overflow stops work and records attempted output', () => {
  const { s, a } = setup(20);
  s.push(a, 16); err(() => s.push(a, 5, 'retry'), 'CONTEXT_OVERFLOW');
  assert.equal(s.get('root').overflow.direction, 'output'); assert.equal(s.usage('root').output, 21);
});

test('input-only overflow via tool chunks is cumulative and does not reset', () => {
  const { s, a } = setup(10);
  for (let i = 0; i < 10; i++) s.pull(a, 1, 'chunk');
  err(() => s.pull(a, 1, 'chunk-11'), 'CONTEXT_OVERFLOW');
  assert.equal(s.usage('root').events, 11);
});

test('retries, duplicate chunks and repeated tool payloads are never deduplicated from token accounting', () => {
  const { s, a } = setup(30);
  s.pull(a, 8, 'tool'); s.pull(a, 8, 'same-tool-retry'); s.push(a, 8, 'reply');
  err(() => s.pull(a, 8, 'same-tool-retry'), 'CONTEXT_OVERFLOW');
  assert.equal(s.usage('root').total, 32);
  assert.deepEqual(s.get('root').consumption.map(e => e.tokens), [8, 8, 8, 8]);
});

test('reconnect and forged new socket do not reset cumulative usage or claim identity', () => {
  const { s, a } = setup(25);
  s.pull(a, 20);
  assert.equal(s.reconnect(a).total, 20);
  err(() => s.reconnect({ ...a, session: 'other' }), 'STALE_OR_FORGED_CLAIM');
  err(() => s.pull({ ...a, fence: 'new-fence' }, 1), 'STALE_OR_FORGED_CLAIM');
  err(() => s.push(a, 6), 'CONTEXT_OVERFLOW');
});

test('no direct GitHub mutation, raw provider credential or unrestricted network API', () => {
  const { s, a } = setup();
  err(() => s.directTarget(a, 'git.push'), 'DIRECT_TARGET_ACCESS_FORBIDDEN');
  err(() => s.directTarget(a, 'writeFile'), 'DIRECT_TARGET_ACCESS_FORBIDDEN');
  err(() => s.readCredential(a), 'RAW_CREDENTIAL_FORBIDDEN');
  err(() => s.unrestrictedFetch(a), 'UNRESTRICTED_API_FORBIDDEN');
  assert.equal(s.calls.every(c => !c.allowed), true);
});

test('stale lease is fenced out; recovery rotates token; old agent cannot mutate', () => {
  const { s, a } = setup();
  s.pull(a, 8); s.tick(121);
  err(() => s.push(a, 1), 'STALE_OR_FORGED_CLAIM');
  const next = s.claim('root', { agent: 'agent-B', session: 'session-2' });
  assert.notEqual(a.fence, next.fence);
  err(() => s.checkpoint(a, 'stale mutation'), 'STALE_OR_FORGED_CLAIM');
  assert.equal(s.reconnect(next).input, 8);
});

test('claim cannot be stolen while lease is live, even by an otherwise valid agent', () => {
  const { s } = setup();
  err(() => s.claim('root', { agent: 'agent-B', session: 'session-2' }), 'NOT_CLAIMABLE');
});

test('atomization requires independent planner and stopped parent; failed split is atomic', () => {
  const { s, a } = setup(10);
  err(() => s.atomize('root', { planner: 'planner', expectedRevision: 1, children: [valid('a'), valid('b')] }), 'NOT_STOPPED');
  err(() => s.pull(a, 11), 'CONTEXT_OVERFLOW');
  const v = s.get('root').revisionCounter;
  err(() => s.atomize('root', { planner: 'agent-A', expectedRevision: v, children: [valid('a'), valid('b')] }), 'INDEPENDENT_PLANNER_REQUIRED');
  err(() => s.atomize('root', { planner: 'planner', expectedRevision: v, children: [valid('a', ['b']), valid('b', ['a'])] }), 'DEPENDENCY_CYCLE');
  assert.equal(s.tasks.has('a'), false);
  err(() => s.atomize('root', { planner: 'planner', expectedRevision: v, children: [valid('a'), { ...valid('b'), acceptance: '' }] }), 'INVALID_CHILD_CONTRACT');
  assert.equal(s.get('root').status, 'stopped_overflow');
});

test('concurrent split compare-and-swap prevents double creation, and refuses stale expected revision', () => {
  const { s, a } = setup(10); err(() => s.pull(a, 11), 'CONTEXT_OVERFLOW');
  const v = s.get('root').revisionCounter;
  s.atomize('root', { planner: 'planner-B', expectedRevision: v, children: [valid('a'), valid('b')] });
  err(() => s.atomize('root', { planner: 'planner-C', expectedRevision: v, children: [valid('c'), valid('d')] }), 'NOT_STOPPED');
  assert.deepEqual(s.get('root').children, ['a', 'b']);
});

test('child dependency cannot run until predecessor was independently verified', () => {
  const { s, a } = setup(10); err(() => s.pull(a, 11), 'CONTEXT_OVERFLOW');
  s.atomize('root', { planner: 'planner-B', expectedRevision: s.get('root').revisionCounter,
    children: [valid('a'), valid('b', ['a'])] });
  err(() => s.claim('b', { agent: 'agent-C', session: 'session-C' }), 'DEPENDENCY_UNVERIFIED');
  successful(s, 'a', 'agent-C', 'session-C');
  assert.equal(s.claim('b', { agent: 'agent-D', session: 'session-D' }).taskId, 'b');
});

test('delegated work requires pinned authorized revision, operation and bounded input', () => {
  const { s, a } = setup();
  err(() => s.requestWorkflow(a, req({ target: 'unauthorized' })), 'UNAUTHORIZED_TARGET_OR_REVISION');
  err(() => s.requestWorkflow(a, req({ revision: 'main-latest' })), 'UNAUTHORIZED_TARGET_OR_REVISION');
  err(() => s.requestWorkflow(a, req({ operation: 'arbitrary-shell' })), 'INVALID_WORKFLOW_CONTRACT');
  err(() => s.requestWorkflow(a, req({ token: 'never-in-source' })), 'RAW_CREDENTIAL_FORBIDDEN');
  err(() => s.requestWorkflow(a, req({ inputContract: 'X'.repeat(3000) })), 'OVERSIZED_WORKFLOW_REQUEST');
});

test('dispatch retry is idempotent, cannot overwrite existing payload, and needs correlated acknowledgment', () => {
  const { s, a } = setup(); const r = s.requestWorkflow(a, req());
  assert.equal(s.requestWorkflow(a, req()), r);
  err(() => s.requestWorkflow(a, req({ correlationId: 'changed' })), 'IDEMPOTENCY_COLLISION');
  err(() => s.dispatchAck(r.id, { correlationId: 'forged', fence: a.fence }), 'DISPATCH_CORRELATION_MISMATCH');
  err(() => s.dispatchFinish(r.id, { correlationId: 'correl-1', fence: a.fence, result: { evidence: 'ok' } }), 'INVALID_DISPATCH_STATE');
  s.dispatchAck(r.id, { correlationId: 'correl-1', fence: a.fence });
  err(() => s.dispatchAck(r.id, { correlationId: 'correl-1', fence: a.fence }), 'INVALID_DISPATCH_STATE');
});

test('oversized results are rejected before any terminal success, no premature completion', () => {
  const { s, a } = setup(); const r = s.requestWorkflow(a, req());
  s.dispatchAck(r.id, { correlationId: r.correlationId, fence: a.fence });
  err(() => s.dispatchFinish(r.id, { correlationId: r.correlationId, fence: a.fence, result: { evidence: 'Z'.repeat(3000) } }), 'OVERSIZED_EXECUTION_RESULT');
  err(() => s.submit(a, { evidence: 'fake', output: 'fake' }), 'DISPATCH_NOT_COMPLETE');
  s.dispatchFinish(r.id, { correlationId: r.correlationId, fence: a.fence, result: { evidence: 'workflow fail' }, success: false });
  err(() => s.submit(a, { evidence: 'fake', output: 'fake' }), 'DISPATCH_NOT_COMPLETE');
});

test('forged principal, wrong session, missing fence or task ID cannot access socket', () => {
  const { s, a } = setup();
  for (const bad of [ { ...a, agent: 'evil' }, { ...a, session: 'evil' }, { ...a, fence: 'evil' }, { ...a, taskId: '' }, null ]) {
    assert.throws(() => s.status(bad), e => ['STALE_OR_FORGED_CLAIM', 'IDENTITY_REQUIRED'].includes(e.code));
  }
});

test('parent cannot be finalized while a child remains unfinished or by planning agent', () => {
  const { s, a } = setup(10); err(() => s.pull(a, 11), 'CONTEXT_OVERFLOW');
  s.atomize('root', { planner: 'planner-B', expectedRevision: s.get('root').revisionCounter, children: [valid('a'), valid('b')] });
  err(() => s.finalizeParent('root', { verifier: 'planner-B' }), 'INDEPENDENT_VERIFIER_REQUIRED');
  err(() => s.finalizeParent('root', { verifier: 'auditor' }), 'CHILDREN_NOT_VERIFIED');
});