-- Fail-closed promotion of ATAX system improvement into canonical Vision/Omni goals.
-- The former implementation called goal_ledger_create directly, bypassing Vision.
-- Do not invent Vision IDs; a candidate must carry a valid existing Vision target.
create or replace function public.system_improvement_promote_candidate(
  candidate_id_in uuid,agent_id_in text)
returns uuid
language plpgsql
security definer
set search_path=public
as $fn$
declare c public.system_improvement_candidates%rowtype;
        s public.systems%rowtype;
        def jsonb;
        meta jsonb;
        target_value jsonb;
        result_value jsonb;
        new_goal_id uuid;
        tags_value text[];
begin
  select * into c from public.system_improvement_candidates
  where id=candidate_id_in and status in ('candidate','selected') for update;
  if c.id is null then raise exception 'candidate_not_promotable'; end if;
  select * into s from public.systems where id=c.system_id;
  if s.id is null then raise exception 'system_not_found'; end if;

  def := c.goal_definition;
  if def is null or jsonb_typeof(def)<>'object' then
    raise exception 'candidate_missing_omni_goal_definition';
  end if;
  meta := coalesce(def->'metadata','{}'::jsonb);
  if meta->>'vision_id' is null or meta->>'vision_target_id' is null then
    raise exception 'candidate_missing_mandatory_vision_projection';
  end if;
  if c.task_definitions is null or jsonb_typeof(c.task_definitions)<>'array'
     or jsonb_array_length(c.task_definitions)=0 then
    raise exception 'candidate_requires_task_definitions';
  end if;

  target_value := coalesce(def->'target',c.target);
  select coalesce(array_agg(value),'{}'::text[]) into tags_value
  from jsonb_array_elements_text(coalesce(def->'tags','[]'::jsonb)) as value;

  -- This RPC enforces valid Vision, tldraw board, matching target, Omni loop,
  -- acceptance predicates and task definitions before writing any goal/task.
  result_value := public.goal_ledger_create_omni_hierarchical(
    coalesce(def->>'title',c.title),
    coalesce(def->>'description',c.hypothesis),
    jsonb_build_object('system_id',s.id,'system_key',s.system_key,
                       'candidate_id',c.id,'evidence',c.evidence),
    coalesce(def->>'instructions',c.hypothesis),
    coalesce(def->'acceptance_criteria','[]'::jsonb),
    tags_value,
    coalesce(def->>'goal_type','system'),
    target_value,
    coalesce(def->'behavior_inputs','{}'::jsonb),
    coalesce(def->'expected_outputs','{}'::jsonb),
    coalesce(def->'goal_loop_definition','{}'::jsonb),
    c.task_definitions,
    agent_id_in,
    s.owner_user_id,
    meta || jsonb_build_object('self_improvement',true,
      'candidate_id',c.id,'cycle_id',c.cycle_id)
  );

  new_goal_id := nullif(result_value->'goal'->>'id','')::uuid;
  if new_goal_id is null then raise exception 'omni_goal_creation_returned_no_id'; end if;
  update public.goals set system_id=s.id,
    metadata=metadata||jsonb_build_object('improvement_candidate_id',c.id)
  where id=new_goal_id;
  update public.system_improvement_candidates
  set status='promoted',goal_id=new_goal_id,updated_at=now()
  where id=c.id;
  return new_goal_id;
end;
$fn$;
-- Existing service-role-only function grants remain unchanged.
