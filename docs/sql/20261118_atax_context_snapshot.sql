-- ATAX bounded, consistent snapshot for incoming transient agents.
-- SECURE: invoker rights, existing RLS, and service_role-only EXECUTE.
create or replace function public.atax_context_snapshot(system_key_in text default 'atax')
returns jsonb
language plpgsql stable security invoker
set search_path=public,pg_temp
as $fn$
declare target_system public.systems%rowtype; atax_system public.systems%rowtype;
        snapshot jsonb;
begin
  select * into target_system from public.systems where system_key=system_key_in;
  if target_system.id is null then raise exception 'atax_unknown_system'; end if;
  select * into atax_system from public.systems where system_key='atax';
  if atax_system.id is null then raise exception 'atax_substrate_system_missing'; end if;

  select jsonb_build_object(
    'schema_version', 1,
    'generated_at', now(),
    'source', 'supabase_canonical',
    'security', 'service-role-only-read-only',
    'scope', jsonb_build_object(
      'requested_system_key',target_system.system_key,
      'system_id',target_system.id,'context_version',target_system.context_version,
      'work_priority',target_system.work_priority,
      'universe_id',target_system.universe_id,
      'self_improvement_enabled',atax_system.improvement_enabled,
      'atax_system_id',atax_system.id),
    'skills', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug',s.slug,'name',s.name,'version',v.version,'version_id',v.id,
        'status',s.status) order by s.slug)
      from public.skills s left join public.skill_versions v on v.id=s.current_version_id
      where s.status='active'
    ),'[]'::jsonb),
    'work_modalities', coalesce((
      select jsonb_agg(jsonb_build_object(
         'slug',m.slug,'work_type',m.work_type,'planning_contract',m.planning_contract)
         order by m.slug)
      from public.work_modalities m where m.active
    ),'[]'::jsonb),
    'systems', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',s.id,'system_key',s.system_key,'name',s.name,
        'parent_system_id',s.parent_system_id,'context_version',s.context_version,
        'work_priority',s.work_priority,'governance_policy',s.governance_policy,
        'work_policy',s.work_policy))
      from public.systems s where s.id in (target_system.id,atax_system.id)
    ),'[]'::jsonb),
    'memories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',m.id,'system_id',m.system_id,'memory_key',m.memory_key,
        'title',m.title,'content',m.content,'memory_type',m.memory_type,
        'importance',m.importance,'source_type',m.source_type,
        'source_id',m.source_id,'observed_at',m.occurred_at,
        'updated_at',m.updated_at) order by m.importance desc,m.updated_at desc)
      from (select * from public.system_memories
            where status='active' and system_id in (target_system.id,atax_system.id)
            order by importance desc,updated_at desc limit 100) m
    ),'[]'::jsonb),
    'constraints', coalesce((
      select jsonb_agg(jsonb_build_object(
         'id',c.id,'system_id',c.system_id,'constraint_key',c.constraint_key,
         'name',c.name,'severity',c.severity,'priority',c.priority,
         'invariant',c.invariant,'detection',c.detection,
         'verification',c.verification,'next_check_at',c.next_check_at,
         'due',c.next_check_at <= now()) order by c.priority desc,c.severity desc)
      from public.system_constraints c
      where c.active and c.status='active'
        and c.system_id in (target_system.id,atax_system.id)
    ),'[]'::jsonb),
    'goals', coalesce((
      select jsonb_agg(jsonb_build_object(
         'id',g.id,'goal_key',g.goal_key,'name',g.name,'status',g.status,
         'context_version',g.context_version,'acceptance_criteria',g.acceptance_criteria,
         'user_priority',g.user_priority,'updated_at',g.updated_at,
         'dependencies',(select coalesce(jsonb_agg(jsonb_build_object(
            'goal_id',d.depends_on_goal_id,'type',d.dependency_type)),'[]'::jsonb)
            from public.goal_dependencies d where d.goal_id=g.id))
        order by g.user_priority desc,g.updated_at desc)
      from (select * from public.goals where system_id in (target_system.id,atax_system.id)
            and status in ('planning','ready','active','blocked')
            order by user_priority desc,updated_at desc limit 80) g
    ),'[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',t.id,'task_key',t.task_key,'name',t.task_name,'status',t.status,
        'goal_id',t.goal_id,'system_id',t.system_id,
        'goal_context_version',t.goal_context_version,
        'priority',t.priority,'current_step',t.current_step,
        'verification_status',t.verification_status,
        'heartbeat_at',t.heartbeat_at,'claimed_by_agent_id',t.claimed_by_agent_id,
        'claim_expires_at',t.claim_expires_at,
        'acceptance_criteria',t.acceptance_criteria,
        'verification_plan',t.verification_plan,
        'dependencies',(select coalesce(jsonb_agg(jsonb_build_object(
           'task_id',d.depends_on_task_id,'type',d.dependency_type)),'[]'::jsonb)
           from public.task_dependencies d where d.task_id=t.id))
         order by t.priority,t.updated_at desc)
      from (select t.* from public.tasks t
        left join public.goals g on g.id=t.goal_id
        where (t.system_id in (target_system.id,atax_system.id)
          or g.system_id in (target_system.id,atax_system.id))
          and t.status in ('queued','running','blocked','failed')
        order by t.priority,t.updated_at desc limit 100) t
    ),'[]'::jsonb),
    'github_repositories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'repository',r.repository_full_name,
        'sync_status',r.sync_status,
        'last_successful_sync_at',r.last_successful_sync_at,
        'last_observed_sha',r.last_observed_default_branch_sha,
        'sync_error',r.sync_error,
        'current_sha_checks',coalesce((
          select jsonb_agg(jsonb_build_object(
            'name',c.name,'status',c.status,'conclusion',c.conclusion,
            'sha',c.sha,'url',c.url,'synced_at',c.synced_at))
          from public.github_check_runs c where c.system_id=r.system_id
          and c.sha=r.last_observed_default_branch_sha
        ),'[]'::jsonb))
       order by r.repository_full_name)
      from public.system_github_repositories r
      where r.system_id in (target_system.id,atax_system.id)
    ),'[]'::jsonb),
    'improvement_candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',c.id,'title',c.title,'status',c.status,'priority',c.priority,
        'confidence',c.confidence,'goal_id',c.goal_id) order by c.priority desc)
      from public.system_improvement_candidates c
      where c.system_id=atax_system.id and c.status in ('candidate','selected')
    ),'[]'::jsonb),
    'consistency', jsonb_build_object(
      'global_orphan_goal_count',(select count(*) from public.goals where system_id is null),
      'global_running_without_claim_count',(select count(*) from public.tasks where status='running' and claim_token is null),
      'global_unverified_completed_count',(select count(*) from public.tasks where status='completed' and verification_status<>'verified')),
    'note','Full skill bodies and any truncated goal/task/memory records must be loaded by ID from canonical Supabase before execution. No claimed healthy status from missing evidence.'
  ) into snapshot;
  return snapshot;
end;
$fn$;

revoke all on function public.atax_context_snapshot(text) from public,anon,authenticated;
grant execute on function public.atax_context_snapshot(text) to service_role;
comment on function public.atax_context_snapshot(text) is
  'Service-role-only bounded canonical hydration for transient external agents. No agent spawning and no state mutation.';
