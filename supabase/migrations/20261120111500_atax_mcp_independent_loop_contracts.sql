-- Enable independent loop-authoring before any MCP task execution, and gate goal-scoped claims.
CREATE OR REPLACE FUNCTION public.atax_goal_create_system_bounded(system_key_in text, title_in text, description_in text, context_in jsonb, instructions_in text, acceptance_criteria_in jsonb, tags_in text[], goal_loop_definition_in jsonb, task_definitions_in jsonb, created_by_agent_id_in text, metadata_in jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb; link jsonb;
begin
  if not exists(select 1 from public.systems where system_key=system_key_in and status in ('active','ready')) then
    raise exception 'active System not found';
  end if;
  result := public.goal_ledger_create_hierarchical(
    title_in,description_in,coalesce(context_in,'{}'::jsonb),instructions_in,
    acceptance_criteria_in,tags_in,goal_loop_definition_in,task_definitions_in,
    created_by_agent_id_in,null,coalesce(metadata_in,'{}'::jsonb)
  );
  link := public.atax_goal_attach_system(result->>'goal_key',system_key_in,created_by_agent_id_in);
  -- Newly planned MCP tasks need an independent loop-authoring worker first.
  update public.tasks set task_role='loop_authoring',loop_script_status='missing',updated_at=now()
  where goal_id=(result->'goal'->>'id')::uuid and status='queued';
  return result||jsonb_build_object('system_id',link->'system_id');
end $function$;

CREATE OR REPLACE FUNCTION public.atax_goal_create_system_omni(system_key_in text, title_in text, description_in text, context_in jsonb, instructions_in text, acceptance_criteria_in jsonb, tags_in text[], goal_type_in text, target_in jsonb, behavior_inputs_in jsonb, expected_outputs_in jsonb, goal_loop_definition_in jsonb, task_definitions_in jsonb, created_by_agent_id_in text, metadata_in jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb; link jsonb;
begin
  if not exists(select 1 from public.systems where system_key=system_key_in and status in ('active','ready')) then
    raise exception 'active System not found';
  end if;
  result := public.goal_ledger_create_omni_hierarchical(
    title_in,description_in,coalesce(context_in,'{}'::jsonb),instructions_in,
    acceptance_criteria_in,tags_in,goal_type_in,target_in,
    behavior_inputs_in,expected_outputs_in,goal_loop_definition_in,
    task_definitions_in,created_by_agent_id_in,null,coalesce(metadata_in,'{}'::jsonb)
  );
  link := public.atax_goal_attach_system(result->>'goal_key',system_key_in,created_by_agent_id_in);
  -- Newly planned MCP tasks need an independent loop-authoring worker first.
  update public.tasks set task_role='loop_authoring',loop_script_status='missing',updated_at=now()
  where goal_id=(result->'goal'->>'id')::uuid and status='queued';
  return result||jsonb_build_object('system_id',link->'system_id');
end $function$;


create or replace function public.atax_goal_claim_safe(
  goal_key_in text, agent_id_in text, agent_name_in text,
  agent_type_in text default 'mcp-external',
  capabilities_in text[] default '{}'::text[],
  session_id_in text default null,
  lease_seconds_in integer default 900
) returns setof public.tasks
language plpgsql security invoker set search_path to 'public','pg_temp'
as $$
declare goal_uuid uuid;
begin
  select id into goal_uuid from public.goals where goal_key=goal_key_in;
  if goal_uuid is null then raise exception 'goal not found'; end if;
  if exists(
    select 1 from public.tasks t where t.goal_id=goal_uuid
      and t.status in ('queued','running')
      and t.required_capabilities <@ coalesce(capabilities_in,'{}'::text[])
      and (
        t.task_role not in ('execution','loop_authoring')
        or (t.task_role='execution' and (t.loop_script_status <> 'ready'
          or t.loop_author_agent_id=agent_id_in))
      )
  ) then raise exception 'goal task requires independent loop authoring or a different executor'; end if;
  return query select * from public.goal_ledger_claim_task_by_key(
    goal_key_in,agent_id_in,agent_name_in,agent_type_in,capabilities_in,session_id_in,lease_seconds_in);
end $$;


revoke all on function public.atax_goal_create_system_bounded(text,text,text,jsonb,text,jsonb,text[],jsonb,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.atax_goal_create_system_omni(text,text,text,jsonb,text,jsonb,text[],text,jsonb,jsonb,jsonb,jsonb,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.atax_goal_claim_safe(text,text,text,text,text[],text,integer) from public,anon,authenticated;
grant execute on function public.atax_goal_create_system_bounded(text,text,text,jsonb,text,jsonb,text[],jsonb,jsonb,text,jsonb) to service_role;
grant execute on function public.atax_goal_create_system_omni(text,text,text,jsonb,text,jsonb,text[],text,jsonb,jsonb,jsonb,jsonb,jsonb,text,jsonb) to service_role;
grant execute on function public.atax_goal_claim_safe(text,text,text,text,text[],text,integer) to service_role;
notify pgrst,'reload schema';
