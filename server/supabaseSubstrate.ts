import { createHash } from 'node:crypto';
import { openLedger } from '../tools/atax-mcp/data-api-ledger.mjs';
import type {
  GoalGraphNodeData,
  SkillRecord,
  SkillsSubstrateResponse,
  SubstrateSubsystem,
  SubstrateSystem,
  SubstrateSystemEdge,
  SubstrateUniverse,
  SystemFunctionSummary,
  SystemsSubstrateResponse,
  TaskCheckpointSummary,
  TaskContextLimit,
  TaskGraphNodeData,
  TaskOccupancyInfo,
  VisionGoalTaskEdge,
  VisionGraphNodeData,
  VisionsGoalsSubstrateResponse,
} from '../src/types/substrate.ts';

function asRecord(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

function asArray(val: unknown): unknown[] {
  return Array.isArray(val) ? val : [];
}

function formatContractKeys(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const r = item as Record<string, unknown>;
          return String(r.name || r.key || r.id || r.description || JSON.stringify(r));
        }
        return String(item);
      })
      .filter(Boolean);
  }
  if (val && typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    return entries.map(([k, v]) => {
      if (v === null || v === undefined) return k;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        return `${k}: ${v}`;
      }
      return k;
    });
  }
  return [];
}

function summarizeJsonContract(val: unknown): string {
  if (!val || typeof val !== 'object') return '{}';
  const keys = Object.keys(val as Record<string, unknown>);
  if (keys.length === 0) return '{}';
  return `{ ${keys.join(', ')} }`;
}

function deriveEvalScript(taskRow: Record<string, unknown>): string {
  const verificationPlan = asRecord(taskRow.verification_plan);
  const loopDef = asRecord(taskRow.loop_definition);
  const taskDef = asRecord(taskRow.task_definition);
  const evaluation = asRecord(loopDef.evaluation);

  const directScript =
    verificationPlan.command ||
    verificationPlan.script ||
    verificationPlan.eval_script ||
    evaluation.command ||
    evaluation.script ||
    taskDef.eval_script ||
    loopDef.transformation;

  if (typeof directScript === 'string' && directScript.trim()) {
    return directScript.trim();
  }

  const criteria = asArray(taskRow.acceptance_criteria);
  if (criteria.length > 0) {
    return criteria
      .map((c) => (typeof c === 'string' ? c : JSON.stringify(c)))
      .join(' | ');
  }

  const checkpoints = asArray(taskRow.checkpoints);
  if (checkpoints.length > 0) {
    const preds = checkpoints
      .map((cp) => {
        const r = asRecord(cp);
        const key = r.predicate_key ? String(r.predicate_key) : '';
        const ver = r.predicate_version ? `@${r.predicate_version}` : '';
        return key ? `${key}${ver}` : '';
      })
      .filter(Boolean);
    if (preds.length > 0) {
      return `predicates: ${preds.join(', ')}`;
    }
  }

  return '';
}

function buildOpaqueAgentLabel(
  agentId: unknown,
  agentName: unknown,
  claimedAt: unknown
): string | null {
  const idStr = typeof agentId === 'string' ? agentId.trim() : '';
  const nameStr = typeof agentName === 'string' ? agentName.trim() : '';
  if (!idStr && !nameStr) return null;

  const opaqueSuffix = idStr
    ? createHash('sha256').update(idStr).digest('hex').slice(0, 6)
    : 'none';
  const baseName = nameStr || 'Agent';
  if (typeof claimedAt === 'string' && claimedAt) {
    const d = new Date(claimedAt);
    if (!Number.isNaN(d.getTime())) {
      const iso = d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      return `${baseName} · ${iso} · #${opaqueSuffix}`;
    }
  }
  return `${baseName} · #${opaqueSuffix}`;
}

function deriveOccupancy(row: Record<string, unknown>, nowMs: number): TaskOccupancyInfo {
  const status = String(row.status || '');
  const claimedAt = typeof row.claimed_at === 'string' ? row.claimed_at : null;
  const heartbeatAt = typeof row.heartbeat_at === 'string' ? row.heartbeat_at : null;
  const claimExpiresAt = typeof row.claim_expires_at === 'string' ? row.claim_expires_at : null;
  const agentDisplayLabel = buildOpaqueAgentLabel(
    row.claimed_by_agent_id,
    row.claimed_by_agent_name,
    claimedAt
  );
  const currentStep = typeof row.current_step === 'string' && row.current_step.trim()
    ? row.current_step.trim()
    : null;
  const blocker = typeof row.blocker === 'string' && row.blocker.trim()
    ? row.blocker.trim()
    : null;

  let leaseState: TaskOccupancyInfo['leaseState'] = 'no_claim';
  if (agentDisplayLabel || claimedAt || claimExpiresAt) {
    if (claimExpiresAt) {
      const expMs = Date.parse(claimExpiresAt);
      if (Number.isNaN(expMs)) {
        leaseState = 'unknown';
      } else if (expMs > nowMs && status === 'running') {
        leaseState = 'lease_valid';
      } else {
        leaseState = 'lease_expired';
      }
    } else if (status === 'running') {
      leaseState = 'unknown';
    } else {
      leaseState = 'lease_expired';
    }
  }

  return {
    agentDisplayLabel,
    claimedAt,
    heartbeatAt,
    claimExpiresAt,
    leaseState,
    currentStep,
    blocker,
  };
}

function parseCheckpoints(raw: unknown): TaskCheckpointSummary[] {
  return asArray(raw)
    .map((cp) => {
      const r = asRecord(cp);
      return {
        parameterId: String(r.parameter_id || r.id || ''),
        objective: String(r.objective || r.description || ''),
        status: String(r.status || 'pending'),
        predicateKey: r.predicate_key ? String(r.predicate_key) : null,
      };
    })
    .filter((cp) => cp.parameterId || cp.objective);
}

type SafeQueryResult =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; error: string };

const STATIC_QUERIES = new Map<string,string>([
  ['universes?select=id,universe_key,name,description,status&status=neq.retired&order=created_at.asc',
   "select id,universe_key,name,description,status from public.universes where status <> 'retired' order by created_at asc"],
  ['systems?select=id,universe_id,system_key,parent_system_id,name,system_type,description,status,parameters,context_version&status=neq.retired&order=created_at.asc,name.asc',
   "select id,universe_id,system_key,parent_system_id,name,system_type,description,status,parameters,context_version from public.systems where status <> 'retired' order by created_at asc,name asc"],
  ['system_functions?select=id,system_id,function_key,name,description,input_contract,output_contract,transformation,status&order=created_at.asc',
   'select id,system_id,function_key,name,description,input_contract,output_contract,transformation,status from public.system_functions order by created_at asc'],
  ['system_memories?select=system_id,memory_type&status=eq.active',
   "select system_id,memory_type from public.system_memories where status='active'"],
  ['system_constraints?select=system_id',
   'select system_id from public.system_constraints'],
  ['system_relationships?select=id,source_system_id,target_system_id,relation_type,description&order=created_at.asc',
   'select id,source_system_id,target_system_id,relation_type,description from public.system_relationships order by created_at asc'],
  ['system_wormholes?select=id,source_system_id,target_system_id,status,sync_mode,description&status=neq.closed&order=created_at.asc',
   "select id,source_system_id,target_system_id,status,sync_mode,description from public.system_wormholes where status <> 'closed' order by created_at asc"],
  ['visions?select=id,vision_key,title,description,target,status,created_at,updated_at&status=neq.archived&order=updated_at.desc',
   "select id,vision_key,title,description,target,status,created_at,updated_at from public.visions where status <> 'archived' order by updated_at desc"],
  ['vision_targets?select=id,vision_id,parent_target_id,target,label',
   'select id,vision_id,parent_target_id,target,label from public.vision_targets'],
  ['vision_target_goals?select=vision_target_id,goal_id',
   'select vision_target_id,goal_id from public.vision_target_goals'],
  ['goals?select=id,goal_key,name,description,status,goal_type,target,user_priority,goal_loop_definition,goal_loop_iteration,system_id,created_at,updated_at&status=not.in.(archived,cancelled)&order=user_priority.desc.nullslast,updated_at.desc',
   "select id,goal_key,name,description,status,goal_type,target,user_priority,goal_loop_definition,goal_loop_iteration,system_id,created_at,updated_at from public.goals where status not in ('archived','cancelled') order by user_priority desc nulls last,updated_at desc"],
  ['tasks?select=id,task_key,goal_id,parent_task_id,task_name,description,task_type,status,verification_status,priority,claimed_by_agent_id,claimed_by_agent_name,claimed_at,heartbeat_at,claim_expires_at,current_step,blocker,blocker_notoriety,input_contract,output_contract,required_tools,required_capabilities,acceptance_criteria,verification_plan,loop_definition,task_definition,checkpoints,updated_at&status=not.in.(cancelled,abandoned)&order=priority.asc,created_at.asc',
   "select id,task_key,goal_id,parent_task_id,task_name,description,task_type,status,verification_status,priority,claimed_by_agent_id,claimed_by_agent_name,claimed_at,heartbeat_at,claim_expires_at,current_step,blocker,blocker_notoriety,input_contract,output_contract,required_tools,required_capabilities,acceptance_criteria,verification_plan,loop_definition,task_definition,checkpoints,updated_at from public.tasks where status not in ('cancelled','abandoned') order by priority asc,created_at asc"],
  ['systems?select=id,system_key',
   'select id,system_key from public.systems'],
  ['goal_dependencies?select=id,goal_id,depends_on_goal_id,dependency_type',
   'select id,goal_id,depends_on_goal_id,dependency_type from public.goal_dependencies'],
  ['task_dependencies?select=id,task_id,depends_on_task_id,dependency_type',
   'select id,task_id,depends_on_task_id,dependency_type from public.task_dependencies'],
  ['socket_task_budgets?select=task_id,max_total,input_used,output_used',
   'select task_id,max_total,input_used,output_used from public.socket_task_budgets'],
  ['socket_atomization_edges?select=source_task_id,target_task_id,dependency_type,source_output,target_input',
   'select source_task_id,target_task_id,dependency_type,source_output,target_input from public.socket_atomization_edges'],
  ['skills?select=id,name,slug,description,status,metadata,category_id,current_version_id&status=in.(active,deprecated)&order=name.asc',
   "select id,name,slug,description,status,metadata,category_id,current_version_id from public.skills where status in ('active','deprecated') order by name asc"],
  ['skill_categories?select=id,name',
   'select id,name from public.skill_categories'],
  ['skill_versions?select=id,version',
   'select id,version from public.skill_versions'],
  ['skill_tool_links?select=skill_id,tool_id,is_required',
   'select skill_id,tool_id,is_required from public.skill_tool_links'],
  ['skill_tools?select=id,slug,name,tool_type',
   'select id,slug,name,tool_type from public.skill_tools'],
]);

function createDataApiClient(env: Record<string,string|undefined>){
  return {
    async selectAll(pathWithQuery: string): Promise<SafeQueryResult>{
      const sql=STATIC_QUERIES.get(pathWithQuery);
      if(!sql) return {ok:false,error:'Unsupported substrate query.'};
      try{
        const db=await openLedger(env);
        return {ok:true,rows:await db.query(sql)};
      }catch(err){
        return {ok:false,error:err instanceof Error?err.message:'Supabase PostgreSQL query failed.'};
      }
    },
    async callRpc(name:string,body:Record<string,unknown>={}):Promise<SafeQueryResult>{
      try{
        const db=await openLedger(env);
        return {ok:true,rows:[{value:await db.rpc(name,body)}]};
      }catch(err){
        return {ok:false,error:err instanceof Error?err.message:'Supabase PostgreSQL RPC failed.'};
      }
    }
  };
}

export function createSubstrateService(
  env: Record<string, string | undefined> = process.env,
  _fetcher?: typeof fetch
) {
  function resolveApi(): ReturnType<typeof createDataApiClient> {
    return createDataApiClient(env);
  }

  async function getSystemsGraph(): Promise<SystemsSubstrateResponse> {
    const api = resolveApi();
    const fetchedAt = new Date().toISOString();

    let universesRes: SafeQueryResult;
    let systemsRes: SafeQueryResult;
    let fnRes: SafeQueryResult;
    let memCountsRes: SafeQueryResult;
    let constraintsRes: SafeQueryResult;
    let relRes: SafeQueryResult;
    let wormholesRes: SafeQueryResult;
    let overviewRpc: SafeQueryResult | null = null;

    [universesRes, systemsRes] = await Promise.all([
      api.selectAll(
        'universes?select=id,universe_key,name,description,status&status=neq.retired&order=created_at.asc'
      ),
      api.selectAll(
        'systems?select=id,universe_id,system_key,parent_system_id,name,system_type,description,status,parameters,context_version&status=neq.retired&order=created_at.asc,name.asc'
      ),
    ]);
    if (systemsRes.ok) {
      const universeNameById = new Map(
        (universesRes.ok ? universesRes.rows : []).map((u) => [String(u.id), String(u.name || '')])
      );
      systemsRes = {
        ok: true,
        rows: systemsRes.rows.map((s) => ({
          ...s,
          universe_name: s.universe_id ? universeNameById.get(String(s.universe_id)) ?? null : null,
        })),
      };
      const [rawFns, rawMems, rawCons, rawRels, rawWormholes] = await Promise.all([
        api.selectAll(
          'system_functions?select=id,system_id,function_key,name,description,input_contract,output_contract,transformation,status&order=created_at.asc'
        ),
        api.selectAll('system_memories?select=system_id,memory_type&status=eq.active'),
        api.selectAll('system_constraints?select=system_id'),
        api.selectAll(
          'system_relationships?select=id,source_system_id,target_system_id,relation_type,description&order=created_at.asc'
        ),
        api.selectAll(
          'system_wormholes?select=id,source_system_id,target_system_id,status,sync_mode,description&status=neq.closed&order=created_at.asc'
        ),
      ]);
      fnRes = rawFns;
      if (rawMems.ok) {
        const counts = new Map<string, { active: number; constraint: number }>();
        for (const m of rawMems.rows) {
          const sid = String(m.system_id || '');
          const cur = counts.get(sid) ?? { active: 0, constraint: 0 };
          cur.active += 1;
          if (m.memory_type === 'constraint') cur.constraint += 1;
          counts.set(sid, cur);
        }
        memCountsRes = {
          ok: true,
          rows: Array.from(counts.entries()).map(([system_id, c]) => ({
            system_id,
            active_memories: c.active,
            constraint_memories: c.constraint,
          })),
        };
      } else {
        memCountsRes = rawMems;
      }
      if (rawCons.ok) {
        const counts = new Map<string, number>();
        for (const c of rawCons.rows) {
          const sid = String(c.system_id || '');
          counts.set(sid, (counts.get(sid) ?? 0) + 1);
        }
        constraintsRes = {
          ok: true,
          rows: Array.from(counts.entries()).map(([system_id, cnt]) => ({ system_id, cnt })),
        };
      } else {
        constraintsRes = rawCons;
      }
      relRes = rawRels.ok
        ? {
            ok: true,
            rows: rawRels.rows.map((r) => ({
              ...r,
              source: r.source_system_id,
              target: r.target_system_id,
            })),
          }
        : rawRels;
      wormholesRes = rawWormholes.ok
        ? {
            ok: true,
            rows: rawWormholes.rows.map((w) => ({
              ...w,
              source: w.source_system_id,
              target: w.target_system_id,
            })),
          }
        : rawWormholes;
    } else {
      fnRes = { ok: false, error: 'Skipped' };
      memCountsRes = { ok: false, error: 'Skipped' };
      constraintsRes = { ok: false, error: 'Skipped' };
      relRes = { ok: false, error: 'Skipped' };
      wormholesRes = { ok: false, error: 'Skipped' };
      const rpc = await api.callRpc('agent_context_overview');
      overviewRpc = rpc.ok ? { ok: true, rows: [{ overview: rpc.rows[0]?.value }] } : rpc;
    }

    if (systemsRes.ok) {

      const functionsBySystem = new Map<string, SystemFunctionSummary[]>();
      if (fnRes.ok) {
        for (const r of fnRes.rows) {
          const sysId = String(r.system_id || '');
          const list = functionsBySystem.get(sysId) ?? [];
          list.push({
            key: String(r.function_key || ''),
            name: String(r.name || ''),
            description: String(r.description || ''),
            status: String(r.status || 'active'),
            inputContract: summarizeJsonContract(r.input_contract),
            outputContract: summarizeJsonContract(r.output_contract),
          });
          functionsBySystem.set(sysId, list);
        }
      }

      const memMap = new Map<string, { memories: number; constraints: number }>();
      if (memCountsRes.ok) {
        for (const r of memCountsRes.rows) {
          memMap.set(String(r.system_id), {
            memories: Number(r.active_memories || 0),
            constraints: Number(r.constraint_memories || 0),
          });
        }
      }
      if (constraintsRes.ok) {
        for (const r of constraintsRes.rows) {
          const id = String(r.system_id);
          const cur = memMap.get(id) ?? { memories: 0, constraints: 0 };
          cur.constraints += Number(r.cnt || 0);
          memMap.set(id, cur);
        }
      }

      const topLevelRows = systemsRes.rows.filter((r) => !r.parent_system_id);
      const childRows = systemsRes.rows.filter((r) => Boolean(r.parent_system_id));
      const subsystemsByParent = new Map<string, SubstrateSubsystem[]>();
      for (const c of childRows) {
        const parentId = String(c.parent_system_id);
        const list = subsystemsByParent.get(parentId) ?? [];
        const fns = functionsBySystem.get(String(c.id)) ?? [];
        list.push({
          id: String(c.id),
          systemId: parentId,
          readableKey: String(c.system_key || c.id),
          name: String(c.name || ''),
          subsystemType: String(c.system_type || 'general'),
          status: String(c.status || 'active'),
          contract:
            fns.length > 0
              ? `${fns[0].key}: ${fns[0].inputContract} -> ${fns[0].outputContract}`
              : summarizeJsonContract(c.parameters),
          description: String(c.description || ''),
        });
        subsystemsByParent.set(parentId, list);
      }

      const systems: SubstrateSystem[] = topLevelRows.map((r, index) => {
        const id = String(r.id);
        const counts = memMap.get(id) ?? { memories: 0, constraints: 0 };
        return {
          id,
          universeId: r.universe_id ? String(r.universe_id) : null,
          universeName: r.universe_name ? String(r.universe_name) : null,
          systemKey: String(r.system_key || id),
          name: String(r.name || ''),
          systemType: String(r.system_type || 'general'),
          status: String(r.status || 'active'),
          description: String(r.description || ''),
          contextVersion: Number(r.context_version || 1),
          parameters: asRecord(r.parameters),
          functions: functionsBySystem.get(id) ?? [],
          memoriesCount: counts.memories,
          constraintsCount: counts.constraints,
          subsystems: subsystemsByParent.get(id) ?? [],
          position: { x: 20 + (index % 3) * 440, y: 20 + Math.floor(index / 3) * 290 },
        };
      });

      const edges: SubstrateSystemEdge[] = [];
      if (relRes.ok) {
        for (const r of relRes.rows) {
          edges.push({
            id: `rel-${r.id}`,
            source: String(r.source),
            target: String(r.target),
            relationType: String(r.relation_type) as SubstrateSystemEdge['relationType'],
            label: String(r.relation_type || 'related_to'),
          });
        }
      }
      if (wormholesRes.ok) {
        for (const w of wormholesRes.rows) {
          const syncMode = String(w.sync_mode || 'bidirectional') as SubstrateSystemEdge['syncMode'];
          edges.push({
            id: `wh-${w.id}`,
            source: String(w.source),
            target: String(w.target),
            relationType: 'wormhole',
            label: `wormhole · ${syncMode}`,
            isWormhole: true,
            syncMode,
          });
        }
      }

      const universes: SubstrateUniverse[] = universesRes.ok
        ? universesRes.rows.map((u) => ({
            id: String(u.id),
            universeKey: String(u.universe_key || ''),
            name: String(u.name || ''),
            description: String(u.description || ''),
            status: String(u.status || 'active'),
          }))
        : [];

      return { universes, systems, edges, fetchedAt };
    }

    // Fallback to canonical RPC agent_context_overview() if direct table SELECT is restricted
    const overviewRes = overviewRpc ?? { ok: false as const, error: 'Unavailable' };
    if (overviewRes.ok && overviewRes.rows[0]?.overview) {
      const ov = asRecord(overviewRes.rows[0].overview);
      const rawSystems = asArray(ov.systems).map(asRecord);
      const rawRels = asArray(ov.system_relationships).map(asRecord);
      const rawWormholes = asArray(ov.system_wormholes).map(asRecord);
      const systems: SubstrateSystem[] = rawSystems
        .filter((s) => !s.parent_system_id)
        .map((s, idx) => ({
          id: String(s.id || s.system_key || idx),
          universeId: s.universe_id ? String(s.universe_id) : null,
          universeName: s.universe_name ? String(s.universe_name) : null,
          systemKey: String(s.system_key || ''),
          name: String(s.name || ''),
          systemType: String(s.system_type || 'general'),
          status: String(s.status || 'active'),
          description: String(s.description || ''),
          contextVersion: Number(s.context_version || 1),
          parameters: asRecord(s.parameters),
          functions: asArray(s.functions).map((f) => {
            const fn = asRecord(f);
            return {
              key: String(fn.function_key || fn.key || ''),
              name: String(fn.name || ''),
              inputContract: summarizeJsonContract(fn.input_contract),
              outputContract: summarizeJsonContract(fn.output_contract),
            };
          }),
          memoriesCount: Number(s.memories_count || 0),
          constraintsCount: Number(s.constraints_count || 0),
          subsystems: [],
          position: { x: 20 + (idx % 3) * 440, y: 20 + Math.floor(idx / 3) * 290 },
        }));

      const edges: SubstrateSystemEdge[] = [
        ...rawRels.map((r, i) => ({
          id: `rel-${r.id || i}`,
          source: String(r.source_system_id || r.source || ''),
          target: String(r.target_system_id || r.target || ''),
          relationType: String(r.relation_type || 'related_to') as SubstrateSystemEdge['relationType'],
          label: String(r.relation_type || 'related_to'),
        })),
        ...rawWormholes.map((w, i) => ({
          id: `wh-${w.id || i}`,
          source: String(w.source_system_id || w.source || ''),
          target: String(w.target_system_id || w.target || ''),
          relationType: 'wormhole' as const,
          label: `wormhole · ${String(w.sync_mode || 'bidirectional')}`,
          isWormhole: true,
          syncMode: String(w.sync_mode || 'bidirectional') as SubstrateSystemEdge['syncMode'],
        })),
      ];

      return {
        universes: asArray(ov.universes).map((u) => {
          const r = asRecord(u);
          return {
            id: String(r.id || r.universe_key || ''),
            universeKey: String(r.universe_key || ''),
            name: String(r.name || ''),
            description: String(r.description || ''),
            status: String(r.status || 'active'),
          };
        }),
        systems,
        edges,
        fetchedAt,
      };
    }

    throw new Error(systemsRes.error || 'Unable to read systems from connected Supabase database.');
  }

  async function getVisionsGoalsGraph(): Promise<VisionsGoalsSubstrateResponse> {
    const api = resolveApi();
    const fetchedAt = new Date().toISOString();
    const nowMs = Date.now();

    let visionsRes: SafeQueryResult;
    let targetsRes: SafeQueryResult;
    let linksRes: SafeQueryResult;
    let goalsRes: SafeQueryResult;
    let tasksRes: SafeQueryResult;
    let goalDepsRes: SafeQueryResult = { ok: false, error: 'Skipped' };
    let taskDepsRes: SafeQueryResult = { ok: false, error: 'Skipped' };
    let budgetsRes: SafeQueryResult = { ok: false, error: 'Skipped' };
    let atomEdgesRes: SafeQueryResult = { ok: false, error: 'Skipped' };
    let overviewRpc: SafeQueryResult | null = null;

    let rawSystemsRes: SafeQueryResult;
    [visionsRes, targetsRes, linksRes, goalsRes, tasksRes, rawSystemsRes] = await Promise.all([
      api.selectAll(
        'visions?select=id,vision_key,title,description,target,status,created_at,updated_at&status=neq.archived&order=updated_at.desc'
      ),
      api.selectAll('vision_targets?select=id,vision_id,parent_target_id,target,label'),
      api.selectAll('vision_target_goals?select=vision_target_id,goal_id'),
      api.selectAll(
        'goals?select=id,goal_key,name,description,status,goal_type,target,user_priority,goal_loop_definition,goal_loop_iteration,system_id,created_at,updated_at&status=not.in.(archived,cancelled)&order=user_priority.desc.nullslast,updated_at.desc'
      ),
      api.selectAll(
        'tasks?select=id,task_key,goal_id,parent_task_id,task_name,description,task_type,status,verification_status,priority,claimed_by_agent_id,claimed_by_agent_name,claimed_at,heartbeat_at,claim_expires_at,current_step,blocker,blocker_notoriety,input_contract,output_contract,required_tools,required_capabilities,acceptance_criteria,verification_plan,loop_definition,task_definition,checkpoints,updated_at&status=not.in.(cancelled,abandoned)&order=priority.asc,created_at.asc'
      ),
      api.selectAll('systems?select=id,system_key'),
    ]);

    if (linksRes.ok && targetsRes.ok) {
      const targetById = new Map(targetsRes.rows.map((t) => [String(t.id), t]));
      linksRes = {
        ok: true,
        rows: linksRes.rows.map((l) => {
          const target = targetById.get(String(l.vision_target_id));
          return {
            ...l,
            vision_id: target?.vision_id ?? null,
            target_label: target?.label ?? '',
          };
        }),
      };
    }

    if (goalsRes.ok && rawSystemsRes.ok) {
      const sysKeyById = new Map(
        rawSystemsRes.rows.map((s) => [String(s.id), String(s.system_key || '')])
      );
      goalsRes = {
        ok: true,
        rows: goalsRes.rows.map((g) => ({
          ...g,
          system_key: g.system_id ? sysKeyById.get(String(g.system_id)) ?? null : null,
        })),
      };
    }

    if (goalsRes.ok && tasksRes.ok) {
      const [rawGoalDeps, rawTaskDeps, rawBudgets, rawAtomEdges] = await Promise.all([
        api.selectAll('goal_dependencies?select=id,goal_id,depends_on_goal_id,dependency_type'),
        api.selectAll('task_dependencies?select=id,task_id,depends_on_task_id,dependency_type'),
        api.selectAll('socket_task_budgets?select=task_id,max_total,input_used,output_used'),
        api.selectAll(
          'socket_atomization_edges?select=source_task_id,target_task_id,dependency_type,source_output,target_input'
        ),
      ]);
      goalDepsRes = rawGoalDeps.ok
        ? {
            ok: true,
            rows: rawGoalDeps.rows.map((d) => ({
              ...d,
              target: d.goal_id,
              source: d.depends_on_goal_id,
            })),
          }
        : rawGoalDeps;
      taskDepsRes = rawTaskDeps.ok
        ? {
            ok: true,
            rows: rawTaskDeps.rows.map((d) => ({
              ...d,
              target: d.task_id,
              source: d.depends_on_task_id,
            })),
          }
        : rawTaskDeps;
      budgetsRes = rawBudgets;
      atomEdgesRes = rawAtomEdges.ok
        ? {
            ok: true,
            rows: rawAtomEdges.rows.map((ae) => ({
              ...ae,
              source: ae.source_task_id,
              target: ae.target_task_id,
            })),
          }
        : rawAtomEdges;
    } else {
      const rpc = await api.callRpc('goal_ledger_overview', { tags_in: null });
      overviewRpc = rpc.ok ? { ok: true, rows: [{ overview: rpc.rows[0]?.value }] } : rpc;
    }

    if (goalsRes.ok && tasksRes.ok) {

      const budgetByTask = new Map<string, TaskContextLimit>();
      if (budgetsRes.ok) {
        for (const b of budgetsRes.rows) {
          const maxTokens = Number(b.max_total || 0);
          const usedTokens = Number(b.input_used || 0) + Number(b.output_used || 0);
          if (maxTokens > 0) {
            budgetByTask.set(String(b.task_id), {
              usedTokens,
              maxTokens,
              windowLabel: `${Math.round(maxTokens / 1000)}k tok`,
            });
          }
        }
      }

      // Map goal -> vision via vision_target_goals
      const goalToVision = new Map<string, { visionId: string; targetLabel: string }>();
      if (linksRes.ok) {
        for (const l of linksRes.rows) {
          goalToVision.set(String(l.goal_id), {
            visionId: String(l.vision_id),
            targetLabel: String(l.target_label || ''),
          });
        }
      }

      // Build tasks first so we can aggregate counts & progress per goal
      const tasksByGoal = new Map<string, TaskGraphNodeData[]>();
      const tasks: TaskGraphNodeData[] = tasksRes.rows.map((r, idx) => {
        const taskId = String(r.id);
        const goalId = r.goal_id ? String(r.goal_id) : null;
        const requiredTools = asArray(r.required_tools).map((t) =>
          typeof t === 'string' ? t : String(asRecord(t).slug || asRecord(t).name || t)
        );
        const requiredCaps = asArray(r.required_capabilities).map((c) => String(c));
        const toolsAvailable = Array.from(new Set([...requiredTools, ...requiredCaps])).filter(Boolean);

        const task: TaskGraphNodeData = {
          id: taskId,
          readableKey: String(r.task_key || taskId),
          goalId,
          title: String(r.task_name || r.task_key || 'Untitled Task'),
          description: r.description ? String(r.description) : undefined,
          taskType: String(r.task_type || 'general'),
          status: String(r.status || 'queued'),
          verificationStatus: String(r.verification_status || 'not_started'),
          evalScript: deriveEvalScript(r),
          inputs: formatContractKeys(r.input_contract),
          outputs: formatContractKeys(r.output_contract),
          toolsAvailable,
          contextLimit: budgetByTask.get(taskId) ?? null,
          checkpoints: parseCheckpoints(r.checkpoints),
          occupancy: deriveOccupancy(r, nowMs),
          blockerNotoriety: Number(r.blocker_notoriety || 0),
          updatedAt: r.updated_at ? String(r.updated_at) : null,
          position: { x: 20 + idx * 360, y: 98 },
        };

        if (goalId) {
          const list = tasksByGoal.get(goalId) ?? [];
          list.push(task);
          tasksByGoal.set(goalId, list);
        }
        return task;
      });

      const goalsCountByVision = new Map<string, number>();
      const goals: GoalGraphNodeData[] = goalsRes.rows.map((g, idx) => {
        const goalId = String(g.id);
        const visionLink = goalToVision.get(goalId);
        const visionId = visionLink?.visionId ?? null;
        if (visionId) {
          goalsCountByVision.set(visionId, (goalsCountByVision.get(visionId) ?? 0) + 1);
        }

        const goalTasks = tasksByGoal.get(goalId) ?? [];
        const verifiedCount = goalTasks.filter(
          (t) =>
            t.status === 'completed' &&
            (t.verificationStatus === 'verified' || t.verificationStatus === 'not_required')
        ).length;
        const progress =
          g.status === 'completed'
            ? 100
            : goalTasks.length > 0
            ? Math.round((verifiedCount / goalTasks.length) * 100)
            : 0;
        const maxNotoriety = goalTasks.reduce((acc, t) => Math.max(acc, t.blockerNotoriety), 0);
        const loopDef = asRecord(g.goal_loop_definition);
        const maxIterations = Number(loopDef.max_iterations || 0);

        return {
          id: goalId,
          readableKey: String(g.goal_key || goalId),
          visionId,
          visionTargetLabel: visionLink?.targetLabel ?? null,
          systemKey: g.system_key ? String(g.system_key) : null,
          title: String(g.name || g.goal_key || 'Untitled Goal'),
          description: g.description ? String(g.description) : undefined,
          goalType: String(g.goal_type || 'general'),
          priority: Number(g.user_priority ?? 0.5),
          status: String(g.status || 'planning'),
          blockerNotoriety: maxNotoriety,
          progress,
          maxIterations,
          currentIteration: Number(g.goal_loop_iteration || 0),
          tasksCount: goalTasks.length,
          position: { x: 24 + idx * 356, y: 112 },
        };
      });

      // Keep vision_targets count available in description/targetLabel if needed
      const targetsCountByVision = new Map<string, number>();
      if (targetsRes.ok) {
        for (const t of targetsRes.rows) {
          const vid = String(t.vision_id);
          targetsCountByVision.set(vid, (targetsCountByVision.get(vid) ?? 0) + 1);
        }
      }

      const visions: VisionGraphNodeData[] = visionsRes.ok
        ? visionsRes.rows.map((v, idx) => {
            const vid = String(v.id);
            const target = asRecord(v.target);
            return {
              id: vid,
              readableKey: String(v.vision_key || vid),
              title: String(v.title || v.vision_key || 'Untitled Vision'),
              description: String(v.description || ''),
              targetType: String(target.type || 'system'),
              targetLabel: String(target.id || ''),
              status: String(v.status || 'planning'),
              goalsCount: goalsCountByVision.get(vid) ?? 0,
              position: { x: 20 + idx * 450, y: 20 },
            };
          })
        : [];

      const edges: VisionGoalTaskEdge[] = [];
      if (goalDepsRes.ok) {
        for (const d of goalDepsRes.rows) {
          edges.push({
            id: `gd-${d.id}`,
            source: String(d.source),
            target: String(d.target),
            edgeKind: 'goal_dependency',
            dependencyType: d.dependency_type === 'advisory' ? 'advisory' : 'blocking',
            label: String(d.dependency_type || 'blocking'),
          });
        }
      }
      if (taskDepsRes.ok) {
        for (const d of taskDepsRes.rows) {
          edges.push({
            id: `td-${d.id}`,
            source: String(d.source),
            target: String(d.target),
            edgeKind: 'task_dependency',
            dependencyType: d.dependency_type === 'advisory' ? 'advisory' : 'blocking',
            label: String(d.dependency_type || 'blocking'),
          });
        }
      }
      if (atomEdgesRes.ok) {
        for (const ae of atomEdgesRes.rows) {
          edges.push({
            id: `ae-${ae.source}-${ae.target}-${ae.target_input}`,
            source: String(ae.source),
            target: String(ae.target),
            edgeKind: 'artifact_flow',
            dependencyType: ae.dependency_type === 'advisory' ? 'advisory' : 'blocking',
            label: `${String(ae.source_output)} -> ${String(ae.target_input)}`,
          });
        }
      }

      return { visions, goals, tasks, edges, fetchedAt };
    }

    // Fallback to canonical goal_ledger_overview(NULL) RPC if direct SELECT is restricted
    const rpcRes = overviewRpc ?? { ok: false as const, error: 'Unavailable' };
    if (rpcRes.ok && rpcRes.rows[0]?.overview) {
      const ov = asRecord(rpcRes.rows[0].overview);
      const rawGoals = asArray(ov.goals).map(asRecord);
      const goals: GoalGraphNodeData[] = [];
      const tasks: TaskGraphNodeData[] = [];
      const edges: VisionGoalTaskEdge[] = [];
      const taskKeyToId = new Map<string, string>();

      rawGoals.forEach((g, gi) => {
        const goalId = String(g.id || g.goal_key || gi);
        const rawTasks = asArray(g.tasks).map(asRecord);
        const taskCounts = asRecord(g.task_counts);
        const total = Number(taskCounts.total ?? rawTasks.length);
        const completed = Number(taskCounts.completed ?? 0);
        const awaiting = Number(taskCounts.awaiting_verification ?? 0);
        const verified = Math.max(0, completed - awaiting);
        const progress = total > 0 ? Math.round((verified / total) * 100) : 0;
        const loopDef = asRecord(g.goal_loop_definition);

        let maxNotoriety = 0;
        rawTasks.forEach((t, ti) => {
          const tKey = String(t.task_key || `${goalId}-t-${ti}`);
          const tId = String(t.id || tKey);
          taskKeyToId.set(tKey, tId);
          const notoriety = Number(t.blocker_notoriety || 0);
          if (notoriety > maxNotoriety) maxNotoriety = notoriety;

          tasks.push({
            id: tId,
            readableKey: tKey,
            goalId,
            title: String(t.name || tKey),
            taskType: String(t.task_type || 'general'),
            status: String(t.status || 'queued'),
            verificationStatus: String(t.verification_status || 'not_started'),
            evalScript: deriveEvalScript(t),
            inputs: formatContractKeys(t.input_contract),
            outputs: formatContractKeys(t.output_contract),
            toolsAvailable: asArray(t.required_tools).map(String),
            contextLimit: null,
            checkpoints: parseCheckpoints(t.checkpoints),
            occupancy: deriveOccupancy(
              {
                ...t,
                claimed_by_agent_id: t.agent_id,
                claimed_by_agent_name: t.agent_name,
              },
              nowMs
            ),
            blockerNotoriety: notoriety,
            position: { x: 20 + ti * 360, y: 98 },
          });
        });

        // Build task dependency edges from overview dependencies
        rawTasks.forEach((t, ti) => {
          const targetId = String(t.id || t.task_key || `${goalId}-t-${ti}`);
          for (const dep of asArray(t.dependencies)) {
            const dr = asRecord(dep);
            const srcKey = String(dr.task_key || '');
            const srcId = taskKeyToId.get(srcKey);
            if (srcId && srcId !== targetId) {
              edges.push({
                id: `td-${srcId}-${targetId}`,
                source: srcId,
                target: targetId,
                edgeKind: 'task_dependency',
                dependencyType: dr.dependency_type === 'advisory' ? 'advisory' : 'blocking',
                label: String(dr.dependency_type || 'blocking'),
              });
            }
          }
        });

        goals.push({
          id: goalId,
          readableKey: String(g.goal_key || goalId),
          visionId: null,
          title: String(g.name || g.goal_key || 'Untitled Goal'),
          description: g.description ? String(g.description) : undefined,
          goalType: String(g.goal_type || 'general'),
          priority: Number(g.user_priority ?? 0.5),
          status: String(g.status || 'planning'),
          blockerNotoriety: maxNotoriety,
          progress,
          maxIterations: Number(loopDef.max_iterations || 0),
          currentIteration: Number(g.goal_loop_iteration || 0),
          tasksCount: rawTasks.length,
          position: { x: 24 + gi * 356, y: 112 },
        });
      });

      return { visions: [], goals, tasks, edges, fetchedAt };
    }

    const errMsg = !goalsRes.ok
      ? goalsRes.error
      : !tasksRes.ok
      ? tasksRes.error
      : 'Unable to read visions & goals from Supabase.';
    throw new Error(errMsg);
  }

  async function getSkillsCatalog(): Promise<SkillsSubstrateResponse> {
    const api = resolveApi();
    const fetchedAt = new Date().toISOString();

    let skillsRes: SafeQueryResult;
    let catalogRpc: SafeQueryResult | null = null;

    const [rawSkills, rawCats, rawVers, rawLinks, rawTools] = await Promise.all([
      api.selectAll(
        'skills?select=id,name,slug,description,status,metadata,category_id,current_version_id&status=in.(active,deprecated)&order=name.asc'
      ),
      api.selectAll('skill_categories?select=id,name'),
      api.selectAll('skill_versions?select=id,version'),
      api.selectAll('skill_tool_links?select=skill_id,tool_id,is_required'),
      api.selectAll('skill_tools?select=id,slug,name,tool_type'),
    ]);

    if (rawSkills.ok) {
      const catById = new Map((rawCats.ok ? rawCats.rows : []).map((c) => [String(c.id), String(c.name || '')]));
      const verById = new Map((rawVers.ok ? rawVers.rows : []).map((v) => [String(v.id), String(v.version || '')]));
      const toolById = new Map((rawTools.ok ? rawTools.rows : []).map((t) => [String(t.id), t]));
      const toolsBySkill = new Map<string, Array<Record<string, unknown>>>();

      if (rawLinks.ok) {
        for (const link of rawLinks.rows) {
          const tool = toolById.get(String(link.tool_id));
          if (!tool) continue;
          const skillId = String(link.skill_id);
          const list = toolsBySkill.get(skillId) ?? [];
          list.push({
            slug: tool.slug,
            name: tool.name,
            type: tool.tool_type,
            required: link.is_required !== false,
          });
          toolsBySkill.set(skillId, list);
        }
        for (const list of toolsBySkill.values()) {
          list.sort((a, b) => {
            const reqDiff = Number(b.required !== false) - Number(a.required !== false);
            if (reqDiff !== 0) return reqDiff;
            return String(a.slug || '').localeCompare(String(b.slug || ''));
          });
        }
      }

      skillsRes = {
        ok: true,
        rows: rawSkills.rows.map((k) => ({
          ...k,
          category_name: k.category_id ? catById.get(String(k.category_id)) || 'Uncategorized' : 'Uncategorized',
          version: k.current_version_id ? verById.get(String(k.current_version_id)) || '1.0.0' : '1.0.0',
          tools: toolsBySkill.get(String(k.id)) ?? [],
        })),
      };
    } else {
      skillsRes = rawSkills;
      const rpc = await api.callRpc('atax_mcp_skills_catalog_v1');
      catalogRpc = rpc.ok ? { ok: true, rows: [{ catalog: rpc.rows[0]?.value }] } : rpc;
    }

    if (skillsRes.ok) {
      const skills: SkillRecord[] = skillsRes.rows.map((r) => {
        const meta = asRecord(r.metadata);
        const slug = String(r.slug || '');
        const path = typeof meta.path === 'string' && meta.path
          ? meta.path
          : `skills/${slug}/SKILL.md`;
        const tools = asArray(r.tools).map((t) => {
          const tr = asRecord(t);
          return {
            slug: String(tr.slug || ''),
            name: tr.name ? String(tr.name) : undefined,
            type: String(tr.type || 'other'),
            required: tr.required !== false,
          };
        });

        return {
          id: Number(r.id),
          name: String(r.name || ''),
          slug,
          path,
          description: r.description ? String(r.description) : undefined,
          category: String(r.category_name || 'Uncategorized'),
          version: String(r.version || '1.0.0'),
          status: String(r.status || 'active'),
          tools,
        };
      });

      const categories = Array.from(new Set(skills.map((s) => s.category))).sort();
      return { skills, categories, fetchedAt };
    }

    // Fallback to canonical RPC atax_mcp_skills_catalog_v1()
    const rpcRes = catalogRpc ?? { ok: false as const, error: 'Unavailable' };
    if (rpcRes.ok) {
      const raw = asArray(rpcRes.rows[0]?.catalog).map(asRecord);
      const skills: SkillRecord[] = raw.map((r) => {
        const slug = String(r.slug || '');
        return {
          id: Number(r.id || 0),
          name: String(r.name || ''),
          slug,
          path: `skills/${slug}/SKILL.md`,
          description: r.description ? String(r.description) : undefined,
          category: 'Canonical',
          version: 'published',
          status: String(r.status || 'active'),
          tools: [],
        };
      });
      const categories = Array.from(new Set(skills.map((s) => s.category))).sort();
      return { skills, categories, fetchedAt };
    }

    throw new Error(skillsRes.error || 'Unable to read skills catalog from Supabase.');
  }

  return {
    getSystemsGraph,
    getVisionsGoalsGraph,
    getSkillsCatalog,
  };
}
