-- ATAX MCP: governed system-linked goals. Applied 2026-11-20 to canonical Supabase project.
-- No additional agent runtime, scheduling or target execution.

CREATE OR REPLACE FUNCTION public.atax_goal_attach_system(goal_key_in text, system_key_in text, agent_id_in text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare g public.goals%rowtype; s public.systems%rowtype;
begin
  if nullif(btrim(agent_id_in),'') is null then raise exception 'agent identity required'; end if;
  select * into s from public.systems where system_key=system_key_in;
  if s.id is null or s.status not in ('active','ready') then raise exception 'active System not found'; end if;
  select * into g from public.goals where goal_key=goal_key_in for update;
  if g.id is null then raise exception 'goal not found'; end if;
  if g.system_id is not null and g.system_id <> s.id then raise exception 'goal belongs to another System'; end if;
  if g.system_id = s.id then
    return jsonb_build_object('goal_key',g.goal_key,'system_id',s.id,'already_linked',true);
  end if;
  if g.status not in ('planning','ready') or exists(
    select 1 from public.tasks t where t.goal_id=g.id and t.status='running'
  ) then raise exception 'cannot link an active or already running goal to a System'; end if;
  update public.goals set system_id=s.id,
    metadata=metadata||jsonb_build_object('system_id',s.id,'system_key',s.system_key),
    updated_at=now()
  where id=g.id;
  update public.tasks set system_id=s.id,updated_at=now() where goal_id=g.id;
  insert into public.goal_events(goal_id,event_type,agent_id,message,payload)
  values(g.id,'note',agent_id_in,'Linked goal and tasks to canonical ATAX System',
    jsonb_build_object('system_id',s.id,'system_key',s.system_key));
  return jsonb_build_object('goal_key',g.goal_key,'system_id',s.id,'already_linked',false);
end $function$;

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
  return result||jsonb_build_object('system_id',link->'system_id');
end $function$;


revoke all on function public.atax_goal_attach_system(text,text,text) from public,anon,authenticated;
revoke all on function public.atax_goal_create_system_bounded(text,text,text,jsonb,text,jsonb,text[],jsonb,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.atax_goal_create_system_omni(text,text,text,jsonb,text,jsonb,text[],text,jsonb,jsonb,jsonb,jsonb,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.atax_goal_attach_system(text,text,text) to service_role;
grant execute on function public.atax_goal_create_system_bounded(text,text,text,jsonb,text,jsonb,text[],jsonb,jsonb,text,jsonb) to service_role;
grant execute on function public.atax_goal_create_system_omni(text,text,text,jsonb,text,jsonb,text[],text,jsonb,jsonb,jsonb,jsonb,jsonb,text,jsonb) to service_role;
notify pgrst,'reload schema';
