import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubstrateService } from './supabaseSubstrate.ts';
import type { SqlRunner } from './supabaseVault.ts';

function makeEnv() {
  return {
    ATAX_SUPABASE_CONNECTION_URL: 'postgresql://postgres:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
  };
}

test('getSystemsGraph queries canonical tables and maps subsystems, functions, relationships, and wormholes', async () => {
  const runner: SqlRunner = {
    unsafe: async (query: string) => {
      if (query.includes('FROM public.universes')) {
        return [{ id: 'u1', universe_key: 'atax', name: 'ATAX', description: 'Control plane', status: 'active' }];
      }
      if (query.includes('FROM public.systems')) {
        return [
          {
            id: 's1',
            universe_id: 'u1',
            universe_name: 'ATAX',
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
            universe_name: 'ATAX',
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
            universe_name: 'ATAX',
            system_key: 'mcp',
            parent_system_id: null,
            name: 'MCP Worker',
            system_type: 'service',
            description: 'Edge MCP',
            status: 'active',
            parameters: {},
            context_version: 2,
          },
        ];
      }
      if (query.includes('FROM public.system_functions')) {
        return [
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
        ];
      }
      if (query.includes('FROM public.system_memories')) {
        return [{ system_id: 's1', active_memories: 4, constraint_memories: 1 }];
      }
      if (query.includes('FROM public.system_constraints')) {
        return [{ system_id: 's1', cnt: 2 }];
      }
      if (query.includes('FROM public.system_relationships')) {
        return [{ id: 'r1', source: 's3', target: 's1', relation_type: 'depends_on', description: 'Reads state' }];
      }
      if (query.includes('FROM public.system_wormholes')) {
        return [{ id: 'w1', source: 's1', target: 's3', status: 'active', sync_mode: 'bidirectional', description: '' }];
      }
      return [];
    },
  };

  const svc = createSubstrateService(makeEnv(), () => runner);
  const res = await svc.getSystemsGraph();

  assert.equal(res.universes.length, 1);
  assert.equal(res.systems.length, 2);
  const ledger = res.systems.find((s) => s.id === 's1')!;
  assert.equal(ledger.subsystems.length, 1);
  assert.equal(ledger.memoriesCount, 4);
  assert.equal(ledger.constraintsCount, 3);
  assert.equal(ledger.functions.length, 1);
  assert.equal(res.edges.length, 2);
  assert.ok(res.edges.some((e) => e.isWormhole));
});

test('getSystemsGraph falls back to agent_context_overview() when direct SELECT fails', async () => {
  const runner: SqlRunner = {
    unsafe: async (query: string) => {
      if (query.includes('agent_context_overview')) {
        return [
          {
            overview: {
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
            },
          },
        ];
      }
      throw new Error('permission denied for table systems');
    },
  };

  const svc = createSubstrateService(makeEnv(), () => runner);
  const res = await svc.getSystemsGraph();
  assert.equal(res.systems.length, 1);
  assert.equal(res.systems[0].name, 'RPC System');
});

test('getVisionsGoalsGraph excludes sensitive lease tokens, hashes agent IDs, and detects lease state', async () => {
  const futureExpiry = new Date(Date.now() + 600_000).toISOString();
  const pastExpiry = new Date(Date.now() - 600_000).toISOString();
  let capturedTaskQuery = '';

  const runner: SqlRunner = {
    unsafe: async (query: string) => {
      if (query.includes('FROM public.visions')) {
        return [
          {
            id: 'v1',
            vision_key: 'VIS-1',
            title: 'Live Vision',
            description: 'Vision desc',
            target: { type: 'system', id: 'ledger' },
            status: 'active',
          },
        ];
      }
      if (query.includes('FROM public.vision_targets')) {
        return [{ id: 'vt1', vision_id: 'v1', target: {}, label: 'Primary' }];
      }
      if (query.includes('FROM public.vision_target_goals')) {
        return [{ vision_target_id: 'vt1', goal_id: 'g1', vision_id: 'v1', target_label: 'Primary' }];
      }
      if (query.includes('FROM public.goals')) {
        return [
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
            system_key: 'ledger',
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
            system_key: null,
          },
        ];
      }
      if (query.includes('FROM public.tasks')) {
        capturedTaskQuery = query;
        return [
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
        ];
      }
      if (query.includes('FROM public.socket_task_budgets')) {
        return [{ task_id: 't1', max_total: 100000, input_used: 15000, output_used: 5000 }];
      }
      return [];
    },
  };

  const svc = createSubstrateService(makeEnv(), () => runner);
  const res = await svc.getVisionsGoalsGraph();

  // Never select secret claim or verification tokens
  assert.equal(capturedTaskQuery.includes('claim_token'), false);
  assert.equal(capturedTaskQuery.includes('claimed_session_id'), false);
  assert.equal(capturedTaskQuery.includes('verification_claim_token'), false);

  assert.equal(res.visions.length, 1);
  assert.equal(res.visions[0].goalsCount, 1);
  assert.equal(res.goals.length, 2);
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

test('getSkillsCatalog queries skills registry and falls back cleanly on RPC', async () => {
  const directRunner: SqlRunner = {
    unsafe: async () => [
      {
        id: 10,
        name: 'Atomic Claim',
        slug: 'atomic-claim',
        description: 'Claims task sockets safely',
        status: 'active',
        metadata: { path: 'skills/atomic-claim/SKILL.md' },
        category_name: 'Coordination',
        version: '2.0.0',
        tools: [{ slug: 'rpc', name: 'RPC', type: 'mcp', required: true }],
      },
    ],
  };

  const svc1 = createSubstrateService(makeEnv(), () => directRunner);
  const directRes = await svc1.getSkillsCatalog();
  assert.equal(directRes.skills.length, 1);
  assert.deepEqual(directRes.categories, ['Coordination']);
  assert.equal(directRes.skills[0].tools.length, 1);

  const rpcRunner: SqlRunner = {
    unsafe: async (query: string) => {
      if (query.includes('atax_mcp_skills_catalog_v1')) {
        return [{ catalog: [{ id: 1, slug: 'fallback-skill', name: 'Fallback Skill', status: 'active' }] }];
      }
      throw new Error('permission denied');
    },
  };

  const svc2 = createSubstrateService(makeEnv(), () => rpcRunner);
  const rpcRes = await svc2.getSkillsCatalog();
  assert.equal(rpcRes.skills.length, 1);
  assert.equal(rpcRes.skills[0].slug, 'fallback-skill');
});

test('createSubstrateService prefers HTTPS Data API over TCP pooler when ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY are set', async () => {
  const calls: string[] = [];
  const mockFetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/rest/v1/universes?')) {
      return Response.json([{ id: 'u1', universe_key: 'atax', name: 'ATAX', description: '', status: 'active' }]);
    }
    if (url.includes('/rest/v1/systems?')) {
      return Response.json([
        {
          id: 's1',
          universe_id: 'u1',
          system_key: 'atax',
          parent_system_id: null,
          name: 'ATAX',
          system_type: 'service',
          description: 'Data API system',
          status: 'active',
          parameters: {},
          context_version: 1,
        },
      ]);
    }
    if (url.includes('/rest/v1/system_memories?')) {
      return Response.json([
        { system_id: 's1', memory_type: 'constraint' },
        { system_id: 's1', memory_type: 'note' },
      ]);
    }
    if (url.includes('/rest/v1/system_constraints?')) {
      return Response.json([{ system_id: 's1' }]);
    }
    return Response.json([]);
  }) as typeof fetch;

  const svc = createSubstrateService(
    {
      ATAX_SUPABASE_URL: 'https://vcaerawuwffziufvpbvw.supabase.co',
      ATAX_SUPABASE_SECRET_KEY: 'sb_secret_mock_key_1234567890',
      ATAX_SUPABASE_CONNECTION_URL: 'postgresql://postgres:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    },
    undefined,
    mockFetcher
  );

  const sysRes = await svc.getSystemsGraph();
  assert.equal(sysRes.systems.length, 1);
  assert.equal(sysRes.systems[0].memoriesCount, 2);
  assert.equal(sysRes.systems[0].constraintsCount, 2);
  assert.ok(calls.some((u) => u.startsWith('https://vcaerawuwffziufvpbvw.supabase.co/rest/v1/')));
});
