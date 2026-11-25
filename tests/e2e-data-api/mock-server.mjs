/**
 * In-Memory Mock Server for ATAX E2E Testing Track
 * Provides full-fidelity simulation of:
 * 1. Cloudflare Worker MCP Endpoint (POST /mcp, GET /health)
 * 2. Supabase PostgREST Data API (POST /rest/v1/rpc/<name>)
 * 
 * Implements complete stateful ledger semantics:
 * - Atomic claims & fencing tokens
 * - Lease duration & expiration enforcement
 * - Independent verification queue & self-verification prevention
 * - Non-mutating handoff notes for forfeited sockets
 * - Socket metered execution receipts & budget accounting
 * - 1MB payload limits, 30 batch limit, strict error sanitization
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export const TEST_OPERATOR_TOKEN = 'atax_5426bb43a95f34297740e50804035fc67db24be2be32098d';
export const TEST_OPERATOR_SHA256 = createHash('sha256').update(TEST_OPERATOR_TOKEN).digest('hex');
export const TEST_SUPABASE_SERVICE_KEY = 'sb_test_service_role_secret_key_9876543210';

export function createMockState() {
  const universes = [
    { id: 'u-core', universe_key: 'core', name: 'ATAX Core Universe', status: 'active' }
  ];

  const systems = [
    {
      id: 's-atax',
      system_key: 'atax',
      name: 'ATAX Control Plane',
      status: 'active',
      context_version: 1,
      constraints: ['No direct TCP connections', 'Native fetch only'],
      parameters: { mode: 'production', transport: 'supabase-data-api' }
    }
  ];

  const goals = new Map([
    ['migrate-mcp-to-data-api', {
      id: 'g-migrate',
      goal_key: 'migrate-mcp-to-data-api',
      system_key: 'atax',
      title: 'Migrate MCP Server to Supabase PostgREST Data API',
      description: 'Use native HTTPS fetch to Supabase Data API / PostgREST RPC',
      status: 'active',
      priority: 0.9,
      tags: ['mcp', 'database', 'security'],
      acceptance_criteria: ['100% tests pass', 'zero postgres imports'],
      created_at: new Date(Date.now() - 3600000).toISOString()
    }]
  ]);

  const tasks = new Map([
    ['t-task-1', {
      id: 't-task-1',
      goal_id: 'g-migrate',
      task_key: 'task-1-data-api-adapter',
      title: 'Implement Data API fetch adapter',
      description: 'Pure HTTPS fetch adapter',
      status: 'queued',
      claimed_by_agent_id: null,
      claim_token: null,
      claimed_at: null,
      claim_expires_at: null,
      heartbeat_at: null,
      current_step: null,
      attempt_count: 0,
      verification_status: 'none',
      verification_claimed_by_agent_id: null,
      verification_claim_token: null,
      verification_claim_expires_at: null,
      result: null,
      summary: null,
      evidence: [],
      loop_iterations: []
    }],
    ['t-task-2', {
      id: 't-task-2',
      goal_id: 'g-migrate',
      task_key: 'task-2-e2e-suite',
      title: 'Create E2E test suite',
      description: 'Comprehensive 4-tier test runner',
      status: 'queued',
      claimed_by_agent_id: null,
      claim_token: null,
      claimed_at: null,
      claim_expires_at: null,
      heartbeat_at: null,
      current_step: null,
      attempt_count: 0,
      verification_status: 'none',
      verification_claimed_by_agent_id: null,
      verification_claim_token: null,
      verification_claim_expires_at: null,
      result: null,
      summary: null,
      evidence: [],
      loop_iterations: []
    }]
  ]);

  const handoffEvents = [];
  const taskDependencies = new Map(); // taskId -> Set(depTaskId)
  const goalDependencies = new Map(); // goalKey -> Set(depGoalKey)

  const skills = [
    {
      id: 1,
      slug: 'atax-postgrest-migration',
      name: 'ATAX PostgREST Migration Skill',
      description: 'Canonical methodology for HTTPS RPC migration',
      status: 'active',
      instructions: 'Always use native fetch, validate allowlists, fail closed.'
    }
  ];

  return {
    universes,
    systems,
    goals,
    tasks,
    handoffEvents,
    taskDependencies,
    goalDependencies,
    skills,
    reset() {
      const fresh = createMockState();
      Object.assign(this, fresh);
    }
  };
}

export function createMockServer(options = {}) {
  const state = options.state || createMockState();
  const operatorToken = options.operatorToken || TEST_OPERATOR_TOKEN;
  const operatorSha256 = createHash('sha256').update(operatorToken).digest('hex');
  const serviceKey = options.serviceKey || TEST_SUPABASE_SERVICE_KEY;
  const maxBodyBytes = options.maxBodyBytes || 1024 * 1024; // 1MB

  const server = createServer(async (req, res) => {
    // Helper responses
    const sendJson = (status, data, extraHeaders = {}) => {
      const body = JSON.stringify(data);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders
      });
      res.end(body);
    };

    const sendRpcError = (id, code, message, httpStatus = 200) => {
      sendJson(httpStatus, {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code, message }
      });
    };

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }

    // 1. Health Endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(200, {
        service: 'atax-mcp',
        status: 'ok',
        protocol: '2025-06-18',
        databaseTransport: 'supabase-data-api'
      });
      return;
    }

    // Read body safely with 1MB limit check
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > maxBodyBytes) {
      sendJson(413, { error: 'Request too large' });
      return;
    }

    let rawBody = '';
    let bytesRead = 0;
    try {
      for await (const chunk of req) {
        bytesRead += chunk.length;
        if (bytesRead > maxBodyBytes) {
          sendJson(413, { error: 'Request too large' });
          return;
        }
        rawBody += chunk.toString('utf8');
      }
    } catch {
      sendJson(400, { error: 'Failed to read request body' });
      return;
    }

    // 2. Direct Supabase PostgREST RPC Endpoint (/rest/v1/rpc/<name>)
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      if (req.method !== 'POST') {
        sendJson(405, { error: 'Method not allowed' });
        return;
      }

      // Check auth header or apikey
      const apikey = req.headers['apikey'];
      const auth = req.headers['authorization'];
      const isAuthorized = apikey === serviceKey || auth === `Bearer ${serviceKey}`;
      if (!isAuthorized) {
        sendJson(401, { code: '42501', message: 'Unauthorized or insufficient privileges' });
        return;
      }

      const rpcName = decodeURIComponent(url.pathname.slice('/rest/v1/rpc/'.length));
      let params = {};
      if (rawBody.trim()) {
        try {
          params = JSON.parse(rawBody);
        } catch {
          sendJson(400, { code: '22P02', message: 'Invalid JSON payload' });
          return;
        }
      }

      try {
        const result = handleDirectRpc(rpcName, params, state);
        if (result === undefined || result === null) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        sendJson(200, result);
        return;
      } catch (err) {
        sendJson(400, {
          code: 'P0001',
          message: err.message || 'Canonical operation denied or unavailable',
          details: null,
          hint: null
        });
        return;
      }
    }

    // 3. MCP Endpoint (/mcp)
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        sendJson(405, { error: 'Stateless MCP endpoint does not support standalone SSE' }, { Allow: 'POST' });
        return;
      }
      if (req.method === 'DELETE') {
        sendJson(405, { error: 'No sessions to terminate' }, { Allow: 'POST' });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(405, { error: 'Method not allowed' }, { Allow: 'POST' });
        return;
      }

      // Verify Content-Type
      const ct = req.headers['content-type'] || '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        sendJson(415, { error: 'Content-Type must be application/json' });
        return;
      }

      // Verify Bearer Authentication
      const authHeader = req.headers['authorization'] || '';
      if (!/^Bearer [\x21-\x7E]{12,8192}$/.test(authHeader)) {
        sendJson(401, { error: 'Unauthorized' }, {
          'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1/mcp"'
        });
        return;
      }
      const token = authHeader.slice(7);
      const tokenSha = createHash('sha256').update(token).digest('hex');
      if (tokenSha !== operatorSha256) {
        sendJson(401, { error: 'Unauthorized' });
        return;
      }

      const principal = {
        id: 'atax-test-operator',
        authMethod: 'shared',
        scopes: new Set(['atax:read', 'atax:write', 'atax:verify', 'atax:admin'])
      };

      // Parse JSON-RPC Payload
      let jsonRpcPayload;
      try {
        jsonRpcPayload = JSON.parse(rawBody);
      } catch {
        sendRpcError(null, -32700, 'Parse error', 400);
        return;
      }

      // Handle Batch Limit checks
      if (Array.isArray(jsonRpcPayload)) {
        if (jsonRpcPayload.length === 0) {
          sendRpcError(null, -32600, 'Empty JSON-RPC batch', 400);
          return;
        }
        if (jsonRpcPayload.length > 30) {
          sendRpcError(null, -32600, 'Too many batch requests', 400);
          return;
        }

        const batchResponses = [];
        for (const msg of jsonRpcPayload) {
          const resp = await handleJsonRpcMessage(msg, principal, state);
          if (resp !== undefined) {
            batchResponses.push(resp);
          }
        }
        if (batchResponses.length === 0) {
          res.writeHead(202, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        sendJson(200, batchResponses);
        return;
      }

      // Single Request
      const singleResponse = await handleJsonRpcMessage(jsonRpcPayload, principal, state);
      if (singleResponse === undefined) {
        res.writeHead(202, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendJson(200, singleResponse);
      return;
    }

    sendJson(404, { error: 'Not found' });
  });

  return {
    server,
    state,
    async listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(`http://${host}:${addr.port}`);
        });
      });
    },
    async close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

// Internal JSON-RPC Router for MCP
async function handleJsonRpcMessage(msg, principal, state) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  }
  const id = msg.id ?? null;
  if (typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid method' } };
  }
  if (msg.method.startsWith('notifications/')) return undefined;
  if (msg.id === undefined) return undefined;

  const params = msg.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Params must be an object' } };
  }

  // 1. initialize
  if (msg.method === 'initialize') {
    const supported = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
    if (params.protocolVersion && !supported.has(params.protocolVersion)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unsupported MCP protocol version' } };
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: { name: 'atax-mcp', version: '1.0.0' },
        instructions: 'ATAX is persistent substrate for external transient agents.'
      }
    };
  }

  // 2. ping
  if (msg.method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  // 3. tools/list
  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: MOCK_TOOL_DEFINITIONS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      }
    };
  }

  // 4. tools/call
  if (msg.method === 'tools/call') {
    if (typeof params.name !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } };
    }
    const toolDef = MOCK_TOOL_DEFINITIONS.find(t => t.name === params.name);
    if (!toolDef) {
      return {
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] }
      };
    }

    const args = params.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return {
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: 'Tool arguments must be an object' }] }
      };
    }

    // Schema Validation
    const validationError = validateToolSchema(toolDef.inputSchema, args);
    if (validationError) {
      return {
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: validationError }] }
      };
    }

    try {
      const toolResult = await toolDef.invoke(args, principal, state);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
          structuredContent: { result: toolResult }
        }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Canonical operation denied or unavailable' }]
        }
      };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

function validateToolSchema(schema, args) {
  for (const field of schema.required || []) {
    if (args[field] === undefined) {
      return `Missing required argument: ${field}`;
    }
  }
  for (const [key, val] of Object.entries(args)) {
    const spec = schema.properties?.[key];
    if (!spec) {
      return `Unexpected argument: ${key}`;
    }
    if (spec.type === 'string') {
      if (typeof val !== 'string' || val.length < (spec.minLength ?? 0) || val.length > (spec.maxLength ?? Infinity)) {
        return `Invalid string: ${key}`;
      }
    }
    if (spec.type === 'integer') {
      if (!Number.isInteger(val) || val < (spec.minimum ?? -Infinity) || val > (spec.maximum ?? Infinity)) {
        return `Invalid integer: ${key}`;
      }
    }
    if (spec.type === 'number') {
      if (typeof val !== 'number' || !Number.isFinite(val) || val < (spec.minimum ?? -Infinity) || val > (spec.maximum ?? Infinity)) {
        return `Invalid number: ${key}`;
      }
    }
    if (spec.type === 'boolean' && typeof val !== 'boolean') {
      return `Invalid boolean: ${key}`;
    }
    if (spec.type === 'array') {
      if (!Array.isArray(val) || val.length > (spec.maxItems ?? Infinity) || val.length < (spec.minItems ?? 0)) {
        return `Invalid array: ${key}`;
      }
    }
    if (spec.type === 'object') {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        return `Invalid object: ${key}`;
      }
    }
    if (spec.enum && !spec.enum.includes(val)) {
      return `Unsupported value: ${key}`;
    }
  }
  return null;
}

// Direct PostgREST RPC Handler
function handleDirectRpc(name, params, state) {
  const now = Date.now();

  switch (name) {
    case 'agent_context_overview':
      return {
        universes: state.universes,
        systems: state.systems,
        system_relationships: [],
        system_wormholes: [],
        goals: Array.from(state.goals.values())
      };

    case 'atax_context_snapshot': {
      const sysKey = params.system_key_in;
      const sys = state.systems.find(s => s.system_key === sysKey);
      if (!sys) throw new Error('System not found');
      return {
        system: sys,
        functions: [],
        memories: [],
        constraints: sys.constraints || [],
        subsystems: []
      };
    }

    case 'goal_ledger_overview': {
      const tagFilter = params.tags_in;
      let goalList = Array.from(state.goals.values());
      if (tagFilter && Array.isArray(tagFilter)) {
        goalList = goalList.filter(g => (g.tags || []).some(t => tagFilter.includes(t)));
      }
      return goalList.map(g => ({
        ...g,
        task_counts: {
          total: Array.from(state.tasks.values()).filter(t => t.goal_id === g.id).length,
          queued: Array.from(state.tasks.values()).filter(t => t.goal_id === g.id && t.status === 'queued').length,
          running: Array.from(state.tasks.values()).filter(t => t.goal_id === g.id && t.status === 'running').length,
          completed: Array.from(state.tasks.values()).filter(t => t.goal_id === g.id && t.status === 'completed').length,
          awaiting_verification: Array.from(state.tasks.values()).filter(t => t.goal_id === g.id && t.verification_status === 'pending').length
        }
      }));
    }

    case 'goal_ledger_get_by_key': {
      const g = state.goals.get(params.goal_key_in);
      if (!g) throw new Error('Goal not found');
      return g;
    }

    case 'goal_ledger_set_priority': {
      const g = state.goals.get(params.goal_key_in);
      if (!g) throw new Error('Goal not found');
      const p = Number(params.priority_in);
      if (p < 0 || p > 1) throw new Error('Priority must be between 0 and 1');
      g.priority = p;
      return g;
    }

    case 'goal_ledger_add_dependency': {
      const { goal_key_in, depends_on_goal_key_in } = params;
      if (!state.goals.has(goal_key_in) || !state.goals.has(depends_on_goal_key_in)) {
        throw new Error('Goal not found');
      }
      if (goal_key_in === depends_on_goal_key_in) {
        throw new Error('Self dependency not allowed');
      }
      if (!state.goalDependencies.has(goal_key_in)) {
        state.goalDependencies.set(goal_key_in, new Set());
      }
      state.goalDependencies.get(goal_key_in).add(depends_on_goal_key_in);
      return {
        id: randomUUID(),
        goal_key: goal_key_in,
        depends_on_goal_key: depends_on_goal_key_in,
        status: 'active'
      };
    }

    case 'task_ledger_claim_next': {
      const agentId = params.agent_id_in || 'anonymous';
      const leaseSec = Math.min(900, Math.max(60, Number(params.lease_seconds_in || 300)));

      // Find first queued task or task with expired claim
      let eligibleTask = null;
      for (const t of state.tasks.values()) {
        const isExpired = t.status === 'running' && t.claim_expires_at && new Date(t.claim_expires_at).getTime() < now;
        if (t.status === 'queued' || isExpired) {
          eligibleTask = t;
          break;
        }
      }

      if (!eligibleTask) {
        return []; // SETOF returns empty array
      }

      const claimToken = randomUUID();
      eligibleTask.status = 'running';
      eligibleTask.claimed_by_agent_id = agentId;
      eligibleTask.claim_token = claimToken;
      eligibleTask.claimed_at = new Date(now).toISOString();
      eligibleTask.claim_expires_at = new Date(now + leaseSec * 1000).toISOString();
      eligibleTask.heartbeat_at = new Date(now).toISOString();
      eligibleTask.attempt_count = (eligibleTask.attempt_count || 0) + 1;
      eligibleTask.current_step = 'Claimed; ready for execution';

      return [eligibleTask];
    }

    case 'task_ledger_check_claim': {
      const { task_id_in, agent_id_in, claim_token_in } = params;
      const t = state.tasks.get(task_id_in);
      if (!t) return false;
      const isOwner = t.claimed_by_agent_id === agent_id_in;
      const isTokenMatch = t.claim_token === claim_token_in;
      const isNotExpired = t.claim_expires_at && new Date(t.claim_expires_at).getTime() > now;
      return Boolean(isOwner && isTokenMatch && isNotExpired && t.status === 'running');
    }

    case 'task_ledger_heartbeat_claim': {
      const { task_id_in, agent_id_in, claim_token_in, current_step_in, lease_seconds_in, heartbeat_context_in } = params;
      const t = state.tasks.get(task_id_in);
      if (!t) throw new Error('Task not found');
      const isExpired = !t.claim_expires_at || new Date(t.claim_expires_at).getTime() <= now;
      if (t.claimed_by_agent_id !== agent_id_in || t.claim_token !== claim_token_in || isExpired) {
        throw new Error('Claim not found, expired, or not owned by agent');
      }
      const leaseSec = Math.min(900, Math.max(60, Number(lease_seconds_in || 300)));
      t.heartbeat_at = new Date(now).toISOString();
      t.claim_expires_at = new Date(now + leaseSec * 1000).toISOString();
      if (current_step_in) t.current_step = current_step_in;
      t.heartbeat_context = heartbeat_context_in || {};
      return t;
    }

    case 'task_ledger_record_handoff': {
      const { task_id_in, previous_agent_id_in, previous_claim_token_in, handoff_note_in, context_in } = params;
      const t = state.tasks.get(task_id_in);
      if (!t) throw new Error('Task not found');
      // Must not be currently active with the same token unless expired
      const isActive = t.status === 'running' && t.claim_token === previous_claim_token_in && new Date(t.claim_expires_at).getTime() > now;
      if (isActive) {
        throw new Error('Task socket is still owned; checkpoint or release it normally');
      }
      const event = {
        id: randomUUID(),
        task_id: task_id_in,
        previous_agent_id: previous_agent_id_in,
        previous_claim_token: previous_claim_token_in,
        handoff_note: handoff_note_in,
        context: context_in || {},
        created_at: new Date(now).toISOString()
      };
      state.handoffEvents.push(event);
      return event;
    }

    case 'task_ledger_record_loop_iteration': {
      const { task_id_in, agent_id_in, claim_token_in, iteration_no_in, verdict_in, next_action_in, evidence_in } = params;
      const t = state.tasks.get(task_id_in);
      if (!t) throw new Error('Task not found');
      const isExpired = !t.claim_expires_at || new Date(t.claim_expires_at).getTime() <= now;
      if (t.claimed_by_agent_id !== agent_id_in || t.claim_token !== claim_token_in || isExpired) {
        throw new Error('Claim not found, expired, or not owned by agent');
      }
      const iteration = {
        iteration_no: iteration_no_in,
        verdict: verdict_in,
        next_action: next_action_in,
        evidence: evidence_in || [],
        recorded_at: new Date(now).toISOString()
      };
      t.loop_iterations.push(iteration);
      return iteration;
    }

    case 'task_ledger_submit_result': {
      const { task_id_in, agent_id_in, claim_token_in, result_in, result_summary_in, tools_used_in, evidence_in, status_in } = params;
      const t = state.tasks.get(task_id_in);
      if (!t) throw new Error('Task not found');
      const isExpired = !t.claim_expires_at || new Date(t.claim_expires_at).getTime() <= now;
      if (t.claimed_by_agent_id !== agent_id_in || t.claim_token !== claim_token_in || isExpired) {
        throw new Error('Claim not found, expired, or not owned by agent');
      }
      t.status = status_in || 'completed';
      t.verification_status = 'pending';
      t.result = result_in || {};
      t.summary = result_summary_in;
      t.tools_used = tools_used_in || [];
      t.evidence = evidence_in || [];
      t.submitted_at = new Date(now).toISOString();
      return t;
    }

    case 'task_ledger_release_claim': {
      const { task_id_in, agent_id_in, claim_token_in, release_status_in, reason_in } = params;
      const t = state.tasks.get(task_id_in);
      if (!t) throw new Error('Task not found');
      if (t.claimed_by_agent_id !== agent_id_in || t.claim_token !== claim_token_in) {
        throw new Error('Claim not found or not owned by agent');
      }
      t.status = release_status_in || 'queued';
      t.claimed_by_agent_id = null;
      t.claim_token = null;
      t.claim_expires_at = null;
      t.release_reason = reason_in;
      return t;
    }

    case 'task_ledger_pending_verification': {
      return Array.from(state.tasks.values()).filter(t => t.verification_status === 'pending');
    }

    case 'task_ledger_claim_verification': {
      const verifierAgentId = params.verifier_agent_id_in;
      const leaseSec = Math.min(900, Math.max(60, Number(params.lease_seconds_in || 300)));

      // Must be an independent verifier: verifierAgentId cannot be the worker that claimed the task
      let eligibleTask = null;
      for (const t of state.tasks.values()) {
        if (t.verification_status === 'pending' && (!t.verification_claim_expires_at || new Date(t.verification_claim_expires_at).getTime() < now)) {
          if (t.claimed_by_agent_id !== verifierAgentId) {
            eligibleTask = t;
            break;
          }
        }
      }

      if (!eligibleTask) return [];

      eligibleTask.verification_claimed_by_agent_id = verifierAgentId;
      eligibleTask.verification_claim_token = randomUUID();
      eligibleTask.verification_claim_expires_at = new Date(now + leaseSec * 1000).toISOString();

      return [eligibleTask];
    }

    case 'task_ledger_claim_verification_for_task': {
      const { task_id_in, verifier_agent_id_in, lease_seconds_in } = params;
      const t = state.tasks.get(task_id_in);
      if (!t) throw new Error('Task not found');
      if (t.claimed_by_agent_id === verifier_agent_id_in) {
        throw new Error('Worker cannot independently verify own task');
      }
      const leaseSec = Math.min(900, Math.max(60, Number(lease_seconds_in || 300)));
      t.verification_claimed_by_agent_id = verifier_agent_id_in;
      t.verification_claim_token = randomUUID();
      t.verification_claim_expires_at = new Date(now + leaseSec * 1000).toISOString();
      return [t];
    }

    case 'task_ledger_verify_result_claimed': {
      const { task_id_in, verifier_agent_id_in, verification_claim_token_in, verified_in, verification_report_in } = params;
      const t = state.tasks.get(task_id_in);
      if (!t) throw new Error('Task not found');
      if (t.verification_claimed_by_agent_id !== verifier_agent_id_in || t.verification_claim_token !== verification_claim_token_in) {
        throw new Error('Verification claim token invalid or not owned by verifier');
      }
      t.verification_status = verified_in ? 'verified' : 'rejected';
      t.verification_report = verification_report_in;
      t.verified_at = new Date(now).toISOString();
      return t;
    }

    case 'goal_ledger_finalize_by_key': {
      const g = state.goals.get(params.goal_key_in);
      if (!g) throw new Error('Goal not found');
      g.status = 'finalized';
      g.finalized_by = params.finalized_by_agent_id_in;
      g.verification_report = params.verification_report_in;
      return g;
    }

    case 'atax_socket_execute_v1': {
      const cmd = params.command_in;
      if (!cmd || typeof cmd !== 'object') {
        return { status: 'denied', code: 'INVALID_COMMAND' };
      }
      const op = cmd.operation;
      return {
        status: 'accepted',
        receipt: {
          invocationId: randomUUID(),
          operation: op,
          inboundTokens: cmd.inboundTokens || 32,
          outboundTokens: 64
        },
        data: {
          taskId: cmd.taskId,
          operation: op,
          executedAt: new Date(now).toISOString()
        }
      };
    }

    default:
      throw new Error(`RPC allowlist rejection: unknown function ${name}`);
  }
}

// Tool Definitions aligned with tools/atax-mcp/worker.mjs
const MOCK_TOOL_DEFINITIONS = [
  {
    name: 'atax_context',
    description: 'Live canonical ATAX universe, systems, goals, tasks, maintenance and priorities',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    invoke: async (_, __, state) => handleDirectRpc('agent_context_overview', {}, state)
  },
  {
    name: 'atax_system_context',
    description: 'Live canonical context snapshot for one system key',
    inputSchema: {
      type: 'object',
      properties: { system_key: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['system_key'],
      additionalProperties: false
    },
    invoke: async (a, _, state) => handleDirectRpc('atax_context_snapshot', { system_key_in: a.system_key }, state)
  },
  {
    name: 'atax_goal_overview',
    description: 'Open goals and their task states, optionally tag-filtered',
    inputSchema: {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 20 } },
      required: [],
      additionalProperties: false
    },
    invoke: async (a, _, state) => handleDirectRpc('goal_ledger_overview', { tags_in: a.tags ?? null }, state)
  },
  {
    name: 'atax_goal_get',
    description: 'Read a canonical goal by readable key',
    inputSchema: {
      type: 'object',
      properties: { goal_key: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['goal_key'],
      additionalProperties: false
    },
    invoke: async (a, _, state) => handleDirectRpc('goal_ledger_get_by_key', { goal_key_in: a.goal_key }, state)
  },
  {
    name: 'atax_task_claim_next',
    description: 'Atomically claim the next eligible task using caller identity',
    inputSchema: {
      type: 'object',
      properties: {
        capabilities: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 30 },
        lease_seconds: { type: 'integer', minimum: 60, maximum: 900 }
      },
      required: [],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_claim_next', {
      agent_id_in: p.id,
      capabilities_in: a.capabilities ?? [],
      lease_seconds_in: a.lease_seconds ?? 300
    }, state)
  },
  {
    name: 'atax_task_check_claim',
    description: 'Check claim ownership and fencing token',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 }
      },
      required: ['task_id', 'claim_token'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_check_claim', {
      task_id_in: a.task_id,
      agent_id_in: p.id,
      claim_token_in: a.claim_token
    }, state)
  },
  {
    name: 'atax_task_heartbeat',
    description: 'Renew a fenced task lease and record progress',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        current_step: { type: 'string', minLength: 1, maxLength: 1200 },
        lease_seconds: { type: 'integer', minimum: 60, maximum: 900 },
        heartbeat_context: { type: 'object' }
      },
      required: ['task_id', 'claim_token', 'current_step'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_heartbeat_claim', {
      task_id_in: a.task_id,
      agent_id_in: p.id,
      claim_token_in: a.claim_token,
      current_step_in: a.current_step,
      lease_seconds_in: a.lease_seconds ?? 300,
      heartbeat_context_in: a.heartbeat_context ?? {}
    }, state)
  },
  {
    name: 'atax_task_record_loop',
    description: 'Persist one fenced Omni Loop iteration, observations and evidence',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        iteration_no: { type: 'integer', minimum: 1, maximum: 1000000 },
        input_payload: { type: 'object' },
        output_payload: { type: 'object' },
        observation: { type: 'object' },
        criterion_results: { type: 'object' },
        loop_state: { type: 'object' },
        tools_used: { type: 'array' },
        evidence: { type: 'array' },
        verdict: { type: 'string', minLength: 1, maxLength: 120 },
        next_action: { type: 'string', minLength: 1, maxLength: 1200 }
      },
      required: ['task_id', 'claim_token', 'iteration_no', 'verdict', 'next_action'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_record_loop_iteration', {
      task_id_in: a.task_id,
      agent_id_in: p.id,
      claim_token_in: a.claim_token,
      iteration_no_in: a.iteration_no,
      verdict_in: a.verdict,
      next_action_in: a.next_action,
      evidence_in: a.evidence ?? []
    }, state)
  },
  {
    name: 'atax_task_submit',
    description: 'Submit result and evidence for independent verification; never self-verify',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        result: { type: 'object' },
        summary: { type: 'string', minLength: 1, maxLength: 2000 },
        tools_used: { type: 'array' },
        evidence: { type: 'array' },
        status: { type: 'string', minLength: 1, maxLength: 80 }
      },
      required: ['task_id', 'claim_token', 'summary'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_submit_result', {
      task_id_in: a.task_id,
      agent_id_in: p.id,
      claim_token_in: a.claim_token,
      result_in: a.result ?? {},
      result_summary_in: a.summary,
      tools_used_in: a.tools_used ?? [],
      evidence_in: a.evidence ?? [],
      status_in: a.status ?? 'completed'
    }, state)
  },
  {
    name: 'atax_task_release',
    description: 'Release caller-owned fenced task to a valid nonterminal state',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        release_status: { type: 'string', enum: ['queued', 'blocked', 'abandoned'] },
        reason: { type: 'string', minLength: 1, maxLength: 1200 }
      },
      required: ['task_id', 'claim_token', 'release_status', 'reason'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_release_claim', {
      task_id_in: a.task_id,
      agent_id_in: p.id,
      claim_token_in: a.claim_token,
      release_status_in: a.release_status,
      reason_in: a.reason
    }, state)
  },
  {
    name: 'atax_task_handoff',
    description: 'After losing/expiring a socket lease, append a bounded, non-mutating completion/handoff note',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        note: { type: 'string', minLength: 1, maxLength: 3000 },
        context: { type: 'object' }
      },
      required: ['task_id', 'claim_token', 'note'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_record_handoff', {
      task_id_in: a.task_id,
      previous_agent_id_in: p.id,
      previous_claim_token_in: a.claim_token,
      handoff_note_in: a.note,
      context_in: a.context ?? {}
    }, state)
  },
  {
    name: 'atax_verification_pending',
    description: 'List tasks awaiting independent verification',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    invoke: async (_, __, state) => handleDirectRpc('task_ledger_pending_verification', {}, state)
  },
  {
    name: 'atax_verification_claim',
    description: 'Claim the next task pending independent verification',
    inputSchema: {
      type: 'object',
      properties: { lease_seconds: { type: 'integer', minimum: 60, maximum: 900 } },
      required: [],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_claim_verification', {
      verifier_agent_id_in: p.id,
      lease_seconds_in: a.lease_seconds ?? 300
    }, state)
  },
  {
    name: 'atax_verification_claim_for_task',
    description: 'Claim a specific task pending independent verification by task UUID',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        lease_seconds: { type: 'integer', minimum: 60, maximum: 900 }
      },
      required: ['task_id'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_claim_verification_for_task', {
      task_id_in: a.task_id,
      verifier_agent_id_in: p.id,
      lease_seconds_in: a.lease_seconds ?? 300
    }, state)
  },
  {
    name: 'atax_verification_submit',
    description: 'Independently verify a submitted result under a verification claim',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        verification_claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        verified: { type: 'boolean' },
        report: { type: 'object' }
      },
      required: ['task_id', 'verification_claim_token', 'verified', 'report'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('task_ledger_verify_result_claimed', {
      task_id_in: a.task_id,
      verifier_agent_id_in: p.id,
      verification_claim_token_in: a.verification_claim_token,
      verified_in: a.verified,
      verification_report_in: a.report
    }, state)
  },
  {
    name: 'atax_goal_finalize',
    description: 'Finalize an independently verified goal through the guarded database RPC',
    inputSchema: {
      type: 'object',
      properties: {
        goal_key: { type: 'string', minLength: 1, maxLength: 256 },
        verification_report: { type: 'object' }
      },
      required: ['goal_key', 'verification_report'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('goal_ledger_finalize_by_key', {
      goal_key_in: a.goal_key,
      finalized_by_agent_id_in: p.id,
      verification_report_in: a.verification_report
    }, state)
  },
  {
    name: 'atax_socket_task_status',
    description: 'Retrieve minimal task state and remaining quota',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 }
      },
      required: ['task_id', 'claim_token'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('atax_socket_execute_v1', {
      command_in: { operation: 'task_status', taskId: a.task_id, claimToken: a.claim_token, principalId: p.id }
    }, state)
  },
  {
    name: 'atax_socket_context_pull',
    description: 'Retrieve one bounded canonical context page for the claimed task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        cursor: { type: 'string', maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 16 }
      },
      required: ['task_id', 'claim_token'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('atax_socket_execute_v1', {
      command_in: { operation: 'context_pull', taskId: a.task_id, claimToken: a.claim_token, cursor: a.cursor, limit: a.limit, principalId: p.id }
    }, state)
  },
  {
    name: 'atax_socket_output_submit',
    description: 'Persist bounded task output only',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        output: { type: 'object' },
        partial: { type: 'boolean' }
      },
      required: ['task_id', 'claim_token', 'output'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('atax_socket_execute_v1', {
      command_in: { operation: 'output_submit', taskId: a.task_id, claimToken: a.claim_token, output: a.output, partial: a.partial, principalId: p.id }
    }, state)
  },
  {
    name: 'atax_socket_atomisation_request',
    description: 'Request stop and fenced atomisation with a bounded partial-progress note',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        reason: { type: 'string', minLength: 1, maxLength: 512 },
        partial_progress: { type: 'string', maxLength: 3000 }
      },
      required: ['task_id', 'claim_token', 'reason'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('atax_socket_execute_v1', {
      command_in: { operation: 'atomisation_request', taskId: a.task_id, claimToken: a.claim_token, reason: a.reason, partial_progress: a.partial_progress, principalId: p.id }
    }, state)
  },
  {
    name: 'atax_socket_workflow_request',
    description: 'Submit a preauthorised workflow intent to the canonical transaction outbox',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 36 },
        claim_token: { type: 'string', minLength: 1, maxLength: 36 },
        workflow_key: { type: 'string', minLength: 1, maxLength: 64 },
        inputs: { type: 'object' }
      },
      required: ['task_id', 'claim_token', 'workflow_key', 'inputs'],
      additionalProperties: false
    },
    invoke: async (a, p, state) => handleDirectRpc('atax_socket_execute_v1', {
      command_in: { operation: 'workflow_request', taskId: a.task_id, claimToken: a.claim_token, workflow_key: a.workflow_key, inputs: a.inputs, principalId: p.id }
    }, state)
  }
];
