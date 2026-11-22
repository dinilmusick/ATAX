// Executable, implementation-agnostic oracle. Never imported by production.
// Real adapters must implement the same externally visible transitions.
export class SocketError extends Error {
  constructor(code, message = code) { super(message); this.name = 'SocketError'; this.code = code; }
}
const deny = code => { throw new SocketError(code); };
const size = x => Buffer.byteLength(JSON.stringify(x ?? null), 'utf8');
const requiredText = v => typeof v === 'string' && v.trim().length > 0;
const contract = v => v && requiredText(v.input) && requiredText(v.output) &&
  requiredText(v.acceptance) && requiredText(v.verifier) &&
  Array.isArray(v.actions) && v.actions.length >= 1 && v.actions.length <= 4 &&
  v.actions.every(requiredText) && Array.isArray(v.dependsOn);

/** Fake durable task store + bounded gateway + fake dispatch + independent verifier. */
export class MockSocket {
  constructor({ budget = 100, maxPayloadBytes = 1024 } = {}) {
    if (!Number.isSafeInteger(budget) || budget <= 0) deny('INVALID_BUDGET');
    this.now = 1000;
    this.budget = budget;
    this.maxPayloadBytes = maxPayloadBytes;
    this.tasks = new Map();
    this.outbox = new Map();
    this.idempotency = new Map();
    this.calls = [];
    this.nextFence = 0;
  }
  tick(seconds) { this.now += seconds; }
  createTask(id, { parentId = null, agent = null, revision = 'rev-immutable', contract: taskContract = null } = {}) {
    if (this.tasks.has(id)) deny('DUPLICATE_TASK');
    const task = { id, parentId, revision, contract: taskContract, status: 'queued', owner: null,
      ownerSession: null, fence: null, leaseUntil: null, revisionCounter: 0,
      initialAgent: agent, inputUsed: 0, outputUsed: 0, consumption: [], children: [],
      evidence: [], overflow: null, submittedBy: null, result: null, verifiedBy: null, dispatchId: null };
    this.tasks.set(id, task); return task;
  }
  get(taskId) { const t = this.tasks.get(taskId); if (!t) deny('TASK_NOT_FOUND'); return t; }
  claim(taskId, { agent, session, leaseSeconds = 120 }) {
    const t = this.get(taskId);
    if (!requiredText(agent) || !requiredText(session) || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) deny('INVALID_IDENTITY');
    if (t.status !== 'queued' && !(t.status === 'running' && t.leaseUntil <= this.now)) deny('NOT_CLAIMABLE');
    if (t.parentId) {
      const p = this.get(t.parentId);
      if (p.status !== 'atomized') deny('PARENT_NOT_ATOMIZED');
      if (agent === p.initialAgent) deny('SEPARATE_AGENT_REQUIRED');
      for (const dep of t.contract.dependsOn) if (this.get(dep).status !== 'completed') deny('DEPENDENCY_UNVERIFIED');
    }
    t.owner = agent; t.ownerSession = session; t.fence = `fence-${++this.nextFence}`;
    t.leaseUntil = this.now + leaseSeconds; t.status = 'running'; t.revisionCounter++;
    if (!t.initialAgent) t.initialAgent = agent;
    return { taskId, agent, session, fence: t.fence };
  }
  guard(id) {
    if (!id || !requiredText(id.taskId) || !requiredText(id.agent) || !requiredText(id.session) || !requiredText(id.fence)) deny('IDENTITY_REQUIRED');
    const t = this.get(id.taskId);
    if (t.status !== 'running') deny('NOT_EXECUTABLE');
    if (t.fence !== id.fence || t.owner !== id.agent || t.ownerSession !== id.session || t.leaseUntil <= this.now) deny('STALE_OR_FORGED_CLAIM');
    return t;
  }
  reconnect(id) { this.guard(id); return this.usage(id.taskId); }
  heartbeat(id, seconds = 120) { const t = this.guard(id); t.leaseUntil = this.now + seconds; return t.leaseUntil; }
  usage(taskId) { const t = this.get(taskId); return { input: t.inputUsed, output: t.outputUsed, total: t.inputUsed + t.outputUsed, state: t.status, events: t.consumption.length }; }
  // A signed or provider-attested measurement is supplied to a real adapter; mock integer counts are deterministic.
  charge(id, direction, tokens, kind = 'chunk') {
    const t = this.guard(id);
    if (!['input', 'output'].includes(direction) || !Number.isSafeInteger(tokens) || tokens <= 0) deny('INVALID_METERING');
    const entry = { direction, tokens, kind, time: this.now, fence: id.fence, sequence: t.consumption.length + 1 };
    t.consumption.push(entry); // append-only, including repeats, retries, tool payloads and overage attempt
    if (direction === 'input') t.inputUsed += tokens; else t.outputUsed += tokens;
    if (t.inputUsed + t.outputUsed > this.budget || t[direction === 'input' ? 'inputUsed' : 'outputUsed'] > this.budget) {
      t.status = 'stopped_overflow';
      t.overflow = { direction, atSequence: entry.sequence, total: t.inputUsed + t.outputUsed,
        actor: id.agent, fence: id.fence, snapshot: structuredClone(t.evidence) };
      t.revisionCounter++;
      deny('CONTEXT_OVERFLOW');
    }
    return this.usage(id.taskId);
  }
  pull(id, tokens, kind = 'context-pull') { return this.charge(id, 'input', tokens, kind); }
  push(id, tokens, kind = 'output-push') { return this.charge(id, 'output', tokens, kind); }
  checkpoint(id, evidence) { const t = this.guard(id); if (!requiredText(evidence)) deny('INVALID_EVIDENCE'); t.evidence.push(evidence); }
  status(id) { const t = this.guard(id); return { taskId: t.id, status: t.status, budget: this.usage(t.id) }; }
  directTarget(id, operation) { this.guard(id); this.calls.push({ operation, allowed: false }); deny('DIRECT_TARGET_ACCESS_FORBIDDEN'); }
  readCredential(id) { this.guard(id); deny('RAW_CREDENTIAL_FORBIDDEN'); }
  unrestrictedFetch(id) { this.guard(id); deny('UNRESTRICTED_API_FORBIDDEN'); }
  atomize(parentId, { planner, expectedRevision, children }) {
    const p = this.get(parentId);
    if (p.status !== 'stopped_overflow') deny('NOT_STOPPED');
    if (!requiredText(planner) || planner === p.overflow.actor) deny('INDEPENDENT_PLANNER_REQUIRED');
    if (p.revisionCounter !== expectedRevision) deny('CONCURRENT_SPLIT_CONFLICT');
    if (!Array.isArray(children) || children.length < 2 || children.length > 16) deny('INVALID_DECOMPOSITION');
    const ids = children.map(c => c.id);
    if (new Set(ids).size !== ids.length || ids.some(id => !requiredText(id) || this.tasks.has(id))) deny('DUPLICATE_CHILD');
    for (const c of children) {
      if (!contract(c)) deny('INVALID_CHILD_CONTRACT');
      if (!c.dependsOn.every(dep => ids.includes(dep) && dep !== c.id)) deny('INVALID_DEPENDENCY');
    }
    const visited = new Set(), active = new Set(), byId = new Map(children.map(c => [c.id, c]));
    const visit = id => {
      if (active.has(id)) deny('DEPENDENCY_CYCLE');
      if (visited.has(id)) return;
      active.add(id); for (const dep of byId.get(id).dependsOn) visit(dep);
      active.delete(id); visited.add(id);
    };
    ids.forEach(visit);
    // Single critical section with version check; no child exists until ALL validation succeeds.
    for (const c of children) this.createTask(c.id, { parentId, revision: p.revision, contract: structuredClone(c) });
    p.status = 'atomized'; p.children = ids; p.owner = null; p.fence = null; p.leaseUntil = null;
    p.revisionCounter++;
    p.atomization = { planner, provenance: p.overflow, children: ids, evidence: structuredClone(p.evidence) };
    return ids;
  }
  requestWorkflow(id, req) {
    const t = this.guard(id);
    if (size(req) > this.maxPayloadBytes) deny('OVERSIZED_WORKFLOW_REQUEST');
    if (!req || !requiredText(req.idempotencyKey) || !requiredText(req.correlationId) ||
        !requiredText(req.target) || !requiredText(req.revision) || !requiredText(req.outputContract) ||
        !['test', 'build', 'change'].includes(req.operation) || !requiredText(req.inputContract)) deny('INVALID_WORKFLOW_CONTRACT');
    if (req.target !== 'approved-repo' || req.revision !== t.revision) deny('UNAUTHORIZED_TARGET_OR_REVISION');
    if (req.token || req.credentials || req.unrestrictedAccess) deny('RAW_CREDENTIAL_FORBIDDEN');
    const digest = JSON.stringify({ task: t.id, req });
    const previous = this.idempotency.get(req.idempotencyKey);
    if (previous) {
      if (previous.digest !== digest) deny('IDEMPOTENCY_COLLISION');
      return previous.record;
    }
    if (t.dispatchId) deny('MULTIPLE_DISPATCH_NOT_ALLOWED');
    const record = { id: `dispatch-${this.outbox.size + 1}`, correlationId: req.correlationId,
      taskId: t.id, owner: id.agent, fence: id.fence, state: 'requested', result: null,
      attemptCount: 0, request: structuredClone(req) };
    this.idempotency.set(req.idempotencyKey, { digest, record }); this.outbox.set(record.id, record);
    t.dispatchId = record.id;
    return record;
  }
  dispatchAck(dispatchId, { correlationId, fence } = {}) {
    const d = this.outbox.get(dispatchId); if (!d) deny('DISPATCH_NOT_FOUND');
    if (d.correlationId !== correlationId || d.fence !== fence) deny('DISPATCH_CORRELATION_MISMATCH');
    if (d.state !== 'requested') deny('INVALID_DISPATCH_STATE');
    d.state = 'acknowledged'; d.attemptCount++; return d;
  }
  dispatchFinish(dispatchId, { correlationId, fence, result, success = true } = {}) {
    const d = this.outbox.get(dispatchId); if (!d) deny('DISPATCH_NOT_FOUND');
    if (d.correlationId !== correlationId || d.fence !== fence) deny('DISPATCH_CORRELATION_MISMATCH');
    if (d.state !== 'acknowledged') deny('INVALID_DISPATCH_STATE');
    if (size(result) > this.maxPayloadBytes) deny('OVERSIZED_EXECUTION_RESULT');
    if (!requiredText(result?.evidence)) deny('MISSING_DISPATCH_EVIDENCE');
    d.result = structuredClone(result); d.state = success ? 'succeeded' : 'failed'; return d;
  }
  submit(id, { evidence, output } = {}) {
    const t = this.guard(id);
    if (t.children.length) deny('PARENT_CANNOT_SELF_COMPLETE');
    if (!requiredText(evidence) || !requiredText(output)) deny('MISSING_RESULT_EVIDENCE');
    if (!t.dispatchId || this.outbox.get(t.dispatchId)?.state !== 'succeeded') deny('DISPATCH_NOT_COMPLETE');
    t.result = { evidence, output }; t.submittedBy = id.agent; t.status = 'pending_verification';
    t.revisionCounter++; return t.status;
  }
  verify(taskId, { verifier, pass, report } = {}) {
    const t = this.get(taskId);
    if (t.status !== 'pending_verification') deny('NOT_PENDING_VERIFICATION');
    if (!requiredText(verifier) || verifier === t.submittedBy || !requiredText(report) || typeof pass !== 'boolean') deny('INDEPENDENT_VERIFIER_REQUIRED');
    if (!pass) { t.status = 'rejected'; t.verifiedBy = verifier; return t.status; }
    t.status = 'completed'; t.verifiedBy = verifier; t.verificationReport = report; return t.status;
  }
  finalizeParent(parentId, { verifier } = {}) {
    const p = this.get(parentId);
    if (p.status !== 'atomized') deny('PARENT_NOT_ATOMIZED');
    if (!requiredText(verifier) || verifier === p.initialAgent || verifier === p.atomization.planner) deny('INDEPENDENT_VERIFIER_REQUIRED');
    if (!p.children.every(id => this.get(id).status === 'completed')) deny('CHILDREN_NOT_VERIFIED');
    p.status = 'completed'; p.verifiedBy = verifier; return p.status;
  }
}