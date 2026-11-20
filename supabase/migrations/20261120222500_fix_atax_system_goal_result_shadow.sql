-- Both System-bound goal wrappers used a local variable named "result",
-- shadowing public.tasks.result inside their UPDATE statements (SQLSTATE 42702).
-- Rebind the exact existing logic with unambiguous PL/pgSQL variable names.
-- Preserve System identity checks, independent loop-authoring and task validation.
CREATE OR REPLACE FUNCTION public.atax_goal_create_system_bounded(system_key_in text, title_in text, description_in text, context_in jsonb, instructions_in text, acceptance_criteria_in jsonb, tags_in text[], goal_loop_definition_in jsonb, task_definitions_in jsonb, created_by_agent_id_in text, metadata_in jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare created_goal jsonb; linked_system jsonb;
begin
  if not exists(select 1 from public.systems where system_key=system_key_in and status in ('active','ready')) then
    raise exception 'active System not found';
  end if;
  created_goal := public.goal_ledger_create_hierarchical(
    title_in,description_in,coalesce(context_in,'{}'::jsonb),instructions_in,
    acceptance_criteria_in,tags_in,goal_loop_definition_in,task_definitions_in,
    created_by_agent_id_in,null,coalesce(metadata_in,'{}'::jsonb)
  );
  linked_system := public.atax_goal_attach_system(created_goal->>'goal_key',system_key_in,created_by_agent_id_in);
  -- Newly planned MCP tasks need an independent loop-authoring worker first.
  update public.tasks set task_role='loop_authoring',loop_script_status='missing',updated_at=now()
  where goal_id=(created_goal->'goal'->>'id')::uuid and status='queued';
  return created_goal||jsonb_build_object('system_id',linked_system->'system_id');
end $function$;

CREATE OR REPLACE FUNCTION public.atax_goal_create_system_omni(system_key_in text, title_in text, description_in text, context_in jsonb, instructions_in text, acceptance_criteria_in jsonb, tags_in text[], goal_type_in text, target_in jsonb, behavior_inputs_in jsonb, expected_outputs_in jsonb, goal_loop_definition_in jsonb, task_definitions_in jsonb, created_by_agent_id_in text, metadata_in jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare created_goal jsonb; linked_system jsonb;
begin
  if not exists(select 1 from public.systems where system_key=system_key_in and status in ('active','ready')) then
    raise exception 'active System not found';
  end if;
  created_goal := public.goal_ledger_create_omni_hierarchical(
    title_in,description_in,coalesce(context_in,'{}'::jsonb),instructions_in,
    acceptance_criteria_in,tags_in,goal_type_in,target_in,
    behavior_inputs_in,expected_outputs_in,goal_loop_definition_in,
    task_definitions_in,created_by_agent_id_in,null,coalesce(metadata_in,'{}'::jsonb)
  );
  linked_system := public.atax_goal_attach_system(created_goal->>'goal_key',system_key_in,created_by_agent_id_in);
  -- Newly planned MCP tasks need an independent loop-authoring worker first.
  update public.tasks set task_role='loop_authoring',loop_script_status='missing',updated_at=now()
  where goal_id=(created_goal->'goal'->>'id')::uuid and status='queued';
  return created_goal||jsonb_build_object('system_id',linked_system->'system_id');
end $function$;

NOTIFY pgrst, 'reload schema';
