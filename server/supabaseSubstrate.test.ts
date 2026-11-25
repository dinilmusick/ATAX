import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubstrateService, STATIC_QUERIES } from './supabaseSubstrate.ts';

function makeEnv() {
  return {
    ATAX_SUPABASE_CONNECTION_URL:
      'postgresql://test-user:test-pass@db.vcaerawuwffziufvpbvw.supabase.co/postgres?sslmode=require',
  };
}

function makeLedgerFactory(mockFetcher: typeof fetch) {
  return async () => ({
    async query(sql: string) {
      const entry = [...(STATIC_QUERIES as Map<string,string>).entries()].find(([, value]) => value === sql);
      if (!entry) throw new Error('Unknown test SQL query');
      const response = await mockFetcher(
        `https://vcaerawuwffziufvpbvw.supabase.co/rest/v1/${entry[0]}`,
      );
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as Array<Record<string, unknown>>;
    },
    async rpc(name: string, _params: Record<string, unknown> = {}) {
      const response = await mockFetcher(
        `https://vcaerawuwffziufvpbvw.supabase.co/rest/v1/rpc/${name}`,
      );
      if (!response.ok) throw new Error(await response.text());
      return await response.json();
    },
    async ping() { return true; },
  });
}

test('getSystemsGraph queries Data API tables and maps subsystems, functions, relationships, and wormholes', async () => {
  const mockFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers || {}) as Record<string, string>;
    assert.equal(headers.apikey, makeEnv().ATAX_SUPABASE_CONNECTION_URL);
    assert.equal(headers.Authorization, `Bearer ${makeEnv().ATAX_SUPABASE_SECRET_KEY}`);

    if (url.includes('/rest/v1/universes?')) {
      return Response.json([
        { id: 'u1', universe_key: 'atax', name: 'ATAX', description: 'Control plane', status: 'active' },
      ]);
    }
    if (url.includes('/rest/v1/systems?')) {
      return Response.json([
        {
          id: 's1',
          universe_id: 'u1',
          system_key: 'ledger',
          parent_system_id: null,
          name: 'Ledger DB',
          system_type: 'database',
          description: 'Canonical ledger',
          status: 'active',
          parameters: { pool: 10 },
          context_version: 3,
        },
        {
          id: 's2',
          universe_id: 'u1',
          system_key: 'claims',
          parent_system_id: 's1',
          name: 'Atomic Claims',
          system_type: 'service',
          description: 'Socket lock',
          status: 'active',
          parameters: { rpc: 'claim_task' },
          context_version: 1,
        },
        {
          id: 's3',
          universe_id: 'u1',
          system_key: 'mcp',
          parent_system_id: null,
          name: 'MCP Worker',
          system_type: 'service',
          description: 'Edge MCP',
          status: 'active',
          parameters: {},
          context_version: 2,
        },
      ]);
    }
    if (url.includes('/rest/v1/system_functions?')) {
      return Response.json([
        {
          id: 'f1',
          system_id: 's1',
          function_key: 'claim_task',
          name: 'Claim Task',
          description: 'Claims socket',
          input_contract: { task_id: 'uuid' },
          output_contract: { lease: 'token' },
          status: 'active',
        },
      ]);
    }
    if (url.includes('/rest/v1/system_memories?')) {
      return Response.json([
        { system_id: 's1', memory_type: 'constraint' },
        { system_id: 's1', memory_type: 'note' },
        { system_id: 's1', memory_type: 'note' },
        { system_id: 's1', memory_type: 'note' },
      ]);
    }
    if (url.includes('/rest/v1/system_constraints?')) {
      return Response.json([{ system_id: 's1' }, { system_id: 's1' }]);
    }
    if (url.includes('/rest/v1/system_relationships?')) {
      return Response.json([
        {
          id: 'r1',
          source_system_id: 's3',
          target_system_id: 's1',
          relation_type: 'depends_on',
          description: 'Reads state',
        },
      ]);
    }
    if (url.includes('/rest/v1/system_wormholes?')) {
      return Response.json([
        {
          id: 'w1',
          source_system_id: 's1',
          target_system_id: 's3',
          status: 'active',
          sync_mode: 'bidirectional',
          description: '',
        },
      ]);
    }
    return Response.json([]);
  }) as typeof fetch;

  const svc = createSubstrateService(makeEnv(), undefined, makeLedgerFactory(mockFetcher));
  const res = await svc.getSystemsGraph();

  assert.equal(res.universes.length, 1);
  assert.equal(res.systems.length, 2);
  const ledger = res.systems.find((s) => s.id === 's1')!;
  assert.equal(ledger.universeName, 'ATAX');
  assert.equal(ledger.subsystems.length, 1);
  assert.equal(ledger.memoriesCount, 4);
  assert.equal(ledger.constraintsCount, 3);
  assert.equal(ledger.functions.length, 1);
  assert.equal(res.edges.length, 2);
  assert.ok(res.edges.some((e) => e.isWormhole));
});

test('getSystemsGraph falls back to agent_context_overview() RPC when direct REST SELECT fails', async () => {
  const mockFetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/rest/v1/rpc/agent_context_overview')) {
      return Response.json({
        universes: [{ id: 'u1', universe_key: 'core', name: 'Core', status: 'active' }],
        systems: [
          {
            id: 'sys-rpc',
            system_key: 'sys-rpc',
            name: 'RPC System',
            system_type: 'service',
            status: 'active',
            description: 'From RPC',
            context_version: 2,
          },
        ],
        system_relationships: [],
        system_wormholes: [],
      });
    }
    return new Response('permission denied', { status: 403 });
  }) as typeof fetch;

  const svc = createSubstrateService(makeEnv(), undefined, makeLedgerFactory(mockFetcher));
  const res = await svc.getSystemsGraph();
  assert.equal(res.systems.length, 1);
  assert.equal(res.systems[0].name, 'RPC System');
});

test('getVisionsGoalsGraph excludes sensitive lease tokens, hashes agent IDs, and detects lease state', async () => {
  const futureExpiry = new Date(Date.now() + 600_000).toISOString();
  const pastExpiry = new Date(Date.now() - 600_000).toISOString();
  let capturedTaskUrl = '';

  const mockFetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/rest/v1/visions?')) {
      return Response.json([
        {
          id: 'v1',
          vision_key: 'VIS-1',
          title: 'Live Vision',
          description: 'Vision desc',
          target: { type: 'system', id: 'ledger' },
          status: 'active',
        },
      ]);
    }
    if (url.includes('/rest/v1/vision_targets?')) {
      return Response.json([{ id: 'vt1', vision_id: 'v1', target: {}, label: 'Primary' }]);
    }
    if (url.includes('/rest/v1/vision_target_goals?')) {
      return Response.json([{ vision_target_id: 'vt1', goal_id: 'g1' }]);
    }
    if (url.includes('/rest/v1/goals?')) {
      return Response.json([
        {
          id: 'g1',
          goal_key: 'G-1',
          name: 'Goal One',
          description: 'Linked goal',
          status: 'in_progress',
          goal_type: 'feature',
          user_priority: 0.8,
          goal_loop_definition: { max_iterations: 4 },
          goal_loop_iteration: 1,
          system_id: 's1',
        },
        {
          id: 'g2',
          goal_key: 'G-2',
          name: 'Standalone Goal',
          description: null,
          status: 'ready',
          goal_type: 'ops',
          user_priority: 0.5,
          goal_loop_definition: {},
          goal_loop_iteration: 0,
          system_id: null,
        },
      ]);
    }
    if (url.includes('/rest/v1/systems?')) {
      return Response.json([{ id: 's1', system_key: 'ledger' }]);
    }
    if (url.includes('/rest/v1/tasks?')) {
      capturedTaskUrl = url;
      return Response.json([
        {
          id: 't1',
          task_key: 'T-1',
          goal_id: 'g1',
          task_name: 'Valid Lease Task',
          task_type: 'implementation',
          status: 'running',
          verification_status: 'not_started',
          priority: 1,
          claimed_by_agent_id: 'secret-agent-session-id-xyz',
          claimed_by_agent_name: 'WorkerA',
          claimed_at: '2026-11-23T05:00:00.000Z',
          heartbeat_at: '2026-11-23T05:01:00.000Z',
          claim_expires_at: futureExpiry,
          current_step: 'running tests',
          blocker: null,
          blocker_notoriety: 0,
          input_contract: { repo: 'string' },
          output_contract: { report: 'json' },
          required_tools: ['bash'],
          required_capabilities: [],
          acceptance_criteria: ['tests pass'],
          verification_plan: { command: 'npm test' },
          checkpoints: [{ parameter_id: 'cp-1', objective: 'Pass unit tests', status: 'passed' }],
        },
        {
          id: 't2',
          task_key: 'T-2',
          goal_id: 'g2',
          task_name: 'Expired Lease Task',
          task_type: 'verification',
          status: 'running',
          verification_status: 'not_started',
          priority: 2,
          claimed_by_agent_id: 'stale-agent-999',
          claimed_by_agent_name: 'WorkerB',
          claimed_at: '2026-11-23T04:00:00.000Z',
          claim_expires_at: pastExpiry,
          blocker_notoriety: 2,
          input_contract: {},
          output_contract: {},
          required_tools: [],
          required_capabilities: [],
          checkpoints: [],
        },
      ]);
    }
    if (url.includes('/rest/v1/socket_task_budgets?')) {
      return Response.json([{ task_id: 't1', max_total: 100000, input_used: 15000, output_used: 5000 }]);
    }
    return Response.json([]);
  }) as typeof fetch;

  const svc = createSubstrateService(makeEnv(), undefined, makeLedgerFactory(mockFetcher));
  const res = await svc.getVisionsGoalsGraph();

  // Never select secret claim or verification tokens
  assert.equal(capturedTaskUrl.includes('claim_token'), false);
  assert.equal(capturedTaskUrl.includes('claimed_session_id'), false);
  assert.equal(capturedTaskUrl.includes('verification_claim_token'), false);

  assert.equal(res.visions.length, 1);
  assert.equal(res.visions[0].goalsCount, 1);
  assert.equal(res.goals.length, 2);
  assert.equal(res.goals.find((g) => g.id === 'g1')!.systemKey, 'ledger');
  assert.equal(res.goals.find((g) => g.id === 'g2')!.visionId, null);

  const t1 = res.tasks.find((t) => t.id === 't1')!;
  assert.equal(t1.occupancy.leaseState, 'lease_valid');
  assert.ok(t1.occupancy.agentDisplayLabel?.includes('WorkerA'));
  assert.equal(t1.occupancy.agentDisplayLabel?.includes('secret-agent-session-id-xyz'), false);
  assert.deepEqual(t1.contextLimit, { usedTokens: 20000, maxTokens: 100000, windowLabel: '100k tok' });
  assert.equal(t1.checkpoints.length, 1);

  const t2 = res.tasks.find((t) => t.id === 't2')!;
  assert.equal(t2.occupancy.leaseState, 'lease_expired');
  assert.equal(t2.contextLimit, null);
});

test('getSkillsCatalog queries skills registry via Data API and falls back cleanly on RPC', async () => {
  const directFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/rest/v1/skills?')) {
      return Response.json([
        {
          id: 10,
          name: 'Atomic Claim',
          slug: 'atomic-claim',
          description: 'Claims task sockets safely',
          status: 'active',
          metadata: { path: 'skills/atomic-claim/SKILL.md' },
          category_id: 'c1',
          current_version_id: 'v1',
        },
      ]);
    }
    if (url.includes('/rest/v1/skill_categories?')) {
      return Response.json([{ id: 'c1', name: 'Coordination' }]);
    }
    if (url.includes('/rest/v1/skill_versions?')) {
      return Response.json([{ id: 'v1', version: '2.0.0' }]);
    }
    if (url.includes('/rest/v1/skill_tool_links?')) {
      return Response.json([{ skill_id: 10, tool_id: 'tool1', is_required: true }]);
    }
    if (url.includes('/rest/v1/skill_tools?')) {
      return Response.json([{ id: 'tool1', slug: 'rpc', name: 'RPC', tool_type: 'mcp' }]);
    }
    return Response.json([]);
  }) as typeof fetch;

  const svc1 = createSubstrateService(makeEnv(), undefined, makeLedgerFactory(directFetch));
  const directRes = await svc1.getSkillsCatalog();
  assert.equal(directRes.skills.length, 1);
  assert.deepEqual(directRes.categories, ['Coordination']);
  assert.equal(directRes.skills[0].version, '2.0.0');
  assert.equal(directRes.skills[0].tools.length, 1);

  const rpcFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/rest/v1/rpc/atax_mcp_skills_catalog_v1')) {
      return Response.json([{ id: 1, slug: 'fallback-skill', name: 'Fallback Skill', status: 'active' }]);
    }
    return new Response('permission denied', { status: 403 });
  }) as typeof fetch;

  const svc2 = createSubstrateService(makeEnv(), undefined, makeLedgerFactory(rpcFetch));
  const rpcRes = await svc2.getSkillsCatalog();
  assert.equal(rpcRes.skills.length, 1);
  assert.equal(rpcRes.skills[0].slug, 'fallback-skill');
});

test('createSubstrateService rejects unconfigured env with PostgreSQL connection URI error', async () => {
  const svc = createSubstrateService({});
  await assert.rejects(
    () => svc.getSystemsGraph(),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes('ATAX_SUPABASE_CONNECTION_URL') &&
      err.message.includes('ATAX_SUPABASE_SECRET_KEY')
  );
});
