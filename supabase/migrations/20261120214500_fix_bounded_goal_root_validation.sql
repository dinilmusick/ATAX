-- Root goals are not leaf tasks: validate the goal loop as a goal and
-- preserve mandatory 1..4 actions on each actual direct task.
-- Reproduced in production and isolated SQL fixtures: a synthetic goal object
-- without actions triggered the new bounded-v2 task validator and prevented
-- every valid system-bound goal from being created.
CREATE OR REPLACE FUNCTION public.goal_ledger_create_hierarchical(title_in text, description_in text, context_in jsonb, instructions_in text, acceptance_criteria_in jsonb, tags_in text[], goal_loop_definition_in jsonb, task_definitions_in jsonb, created_by_agent_id_in text, owner_user_id_in uuid DEFAULT auth.uid(), metadata_in jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  goal_out public.goals;
  owner_id uuid;
  td jsonb;
  tid uuid;
  ids jsonb := '[]'::jsonb;
  deadline_value timestamptz;
begin
  if nullif(btrim(title_in),'') is null then raise exception 'goal title is required'; end if;
  if nullif(btrim(created_by_agent_id_in),'') is null then raise exception 'creator agent identity is required'; end if;
  if jsonb_typeof(acceptance_criteria_in)<>'array' or jsonb_array_length(coalesce(acceptance_criteria_in,'[]'::jsonb))=0 then raise exception 'goal requires non-empty acceptance criteria'; end if;
  if jsonb_typeof(task_definitions_in)<>'array' or jsonb_array_length(coalesce(task_definitions_in,'[]'::jsonb)) not between 1 and 4 then raise exception 'bounded-v2 goal must contain 1-4 direct tasks; create another goal for additional work'; end if;
  if jsonb_typeof(goal_loop_definition_in->'completion_parameters')='array' and jsonb_array_length(goal_loop_definition_in->'completion_parameters')>4 then raise exception 'goal loop may contain at most 4 completion parameters'; end if;
  if jsonb_typeof(goal_loop_definition_in)<>'object' then raise exception 'bounded-v2 goal loop definition must be a JSON object'; end if;
  for td in select value from jsonb_array_elements(task_definitions_in) loop
    if jsonb_typeof(td->'subtasks')='array' and jsonb_array_length(td->'subtasks')>0 then raise exception 'bounded-v2 tasks cannot contain nested tasks'; end if;
    perform public.goal_ledger_validate_task_loop(td,0);
  end loop;
  owner_id:=coalesce(owner_user_id_in,auth.uid());
  if auth.uid() is not null and owner_id is distinct from auth.uid() then raise exception 'goal owner must be the authenticated user'; end if;
  goal_out:=public.goal_ledger_create(title_in,description_in,context_in,instructions_in,acceptance_criteria_in,created_by_agent_id_in,owner_id,metadata_in);
  deadline_value:=nullif(metadata_in->>'deadline_at','')::timestamptz;
  update public.goals set
    execution_model='bounded-v2',
    tags=coalesce((select array_agg(distinct lower(btrim(tag))) from unnest(coalesce(tags_in,'{}'::text[])) tag where btrim(tag)<>''),'{}'::text[]),
    goal_loop_definition=goal_loop_definition_in,
    goal_loop_state=jsonb_build_object('current_input',goal_loop_definition_in->'initial_input','status','ready'),
    goal_loop_iteration=0,
    completion_parameters='[]'::jsonb,
    request_mode=nullif(metadata_in->>'request_mode',''),
    work_modality=nullif(metadata_in->>'work_modality',''),
    deadline_at=deadline_value,
    status='ready',
    updated_at=now()
  where id=goal_out.id returning * into goal_out;
  for td in select value from jsonb_array_elements(task_definitions_in) loop
    td:=jsonb_set(td,'{goal_id}',to_jsonb(goal_out.id::text),true);
    if goal_out.request_mode='work' then
      td:=jsonb_set(td,'{request_mode}',to_jsonb('work'::text),true);
      if goal_out.work_modality is not null then td:=jsonb_set(td,'{work_modality}',to_jsonb(goal_out.work_modality),true); end if;
    end if;
    tid:=public.task_ledger_create_tree(created_by_agent_id_in,created_by_agent_id_in,td,null,null,'orchestrator');
    ids:=ids||to_jsonb(tid);
  end loop;
  update public.goals g set
    completion_parameters=coalesce((select jsonb_agg(jsonb_build_object('id',t.task_key,'task_id',t.id,'description',coalesce(t.description,t.task_name),'required',true) order by t.created_at,t.id) from public.tasks t where t.goal_id=g.id and t.parent_task_id is null),'[]'::jsonb),
    updated_at=now()
  where g.id=goal_out.id returning * into goal_out;
  insert into public.goal_events(goal_id,event_type,agent_id,message,payload)
  values(goal_out.id,'planned',created_by_agent_id_in,'Bounded-v2 goal created with at most four direct tasks',
    jsonb_build_object('goal_key',goal_out.goal_key,'top_level_task_ids',ids,'completion_parameter_count',jsonb_array_length(goal_out.completion_parameters),'request_mode',goal_out.request_mode,'work_modality',goal_out.work_modality,'deadline_at',goal_out.deadline_at));
  return jsonb_build_object('goal',to_jsonb(goal_out),'goal_key',goal_out.goal_key,'top_level_task_ids',ids);
end;
$function$
