-- Atomized children can never receive a larger token budget than their parent.
-- Parent System, Goal, target and required capabilities are copied directly by
-- socket_atomize_task; this migration hardens the only caller-supplied widening
-- field (per-child input/output/combined token budgets).

DO $migration$
DECLARE
  source_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  match_count integer;
  fn regprocedure:=to_regprocedure(
    'public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'
  );
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'WorkSocket child budget migration: socket atomizer is missing';
  END IF;
  SELECT pg_get_functiondef(fn) INTO source_definition;

  old_fragment := $old$        v_budget public.socket_task_budgets; v_from_task public.tasks; v_to_task public.tasks;
        v_progress jsonb;$old$;
  new_fragment := $new$        v_budget public.socket_task_budgets; v_from_task public.tasks; v_to_task public.tasks;
        v_child_budget jsonb; v_child_input bigint; v_child_output bigint; v_child_total bigint;
        v_progress jsonb;$new$;
  match_count := (length(source_definition)-length(replace(source_definition,old_fragment,''))) /
    greatest(length(old_fragment),1);
  IF match_count<>1 THEN
    RAISE EXCEPTION 'WorkSocket child budget migration drift in declaration: % matches',match_count;
  END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);

  old_fragment := $old$       RAISE EXCEPTION 'Child % requires 1-4 actions, one outcome, IO contracts, independent verification and a ready loop',v_i;
     END IF;
     SELECT jsonb_agg(jsonb_build_object('id','cp-'||n,'description',$old$;
  new_fragment := $new$       RAISE EXCEPTION 'Child % requires 1-4 actions, one outcome, IO contracts, independent verification and a ready loop',v_i;
     END IF;
     v_child_budget:=coalesce(v_child->'budget','{}'::jsonb);
     IF jsonb_typeof(v_child_budget)<>'object' THEN
       RAISE EXCEPTION 'Child % budget must be a JSON object',v_i;
     END IF;
     IF (v_child_budget ? 'input' AND coalesce(v_child_budget->>'input','') !~ '^[1-9][0-9]*$')
        OR (v_child_budget ? 'output' AND coalesce(v_child_budget->>'output','') !~ '^[1-9][0-9]*$')
        OR (v_child_budget ? 'total' AND coalesce(v_child_budget->>'total','') !~ '^[1-9][0-9]*$') THEN
       RAISE EXCEPTION 'Child % budget values must be positive integers',v_i;
     END IF;
     v_child_input:=coalesce((v_child_budget->>'input')::bigint,v_budget.max_input);
     v_child_output:=coalesce((v_child_budget->>'output')::bigint,v_budget.max_output);
     v_child_total:=coalesce((v_child_budget->>'total')::bigint,v_budget.max_total);
     IF v_child_input>v_budget.max_input
        OR v_child_output>v_budget.max_output
        OR v_child_total>v_budget.max_total
        OR v_child_input<=0 OR v_child_output<=0 OR v_child_total<=0 THEN
       RAISE EXCEPTION 'Child % budget exceeds or invalidates its parent budget',v_i;
     END IF;
     SELECT jsonb_agg(jsonb_build_object('id','cp-'||n,'description',$new$;
  match_count := (length(source_definition)-length(replace(source_definition,old_fragment,''))) /
    greatest(length(old_fragment),1);
  IF match_count<>1 THEN
    RAISE EXCEPTION 'WorkSocket child budget migration drift in child validation: % matches',match_count;
  END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);

  old_fragment := $old$VALUES(v_id,
       coalesce((v_child->'budget'->>'input')::bigint,v_budget.max_input),
       coalesce((v_child->'budget'->>'output')::bigint,v_budget.max_output),
       coalesce((v_child->'budget'->>'total')::bigint,v_budget.max_total));$old$;
  new_fragment := $new$VALUES(v_id,v_child_input,v_child_output,v_child_total);$new$;
  match_count := (length(source_definition)-length(replace(source_definition,old_fragment,''))) /
    greatest(length(old_fragment),1);
  IF match_count<>1 THEN
    RAISE EXCEPTION 'WorkSocket child budget migration drift in insert: % matches',match_count;
  END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);
  EXECUTE source_definition;
END
$migration$;

COMMENT ON FUNCTION public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb) IS
'Atomizes an authenticated fenced task into bounded children. Children inherit parent target/System/Goal/capabilities; each child input/output/total budget must be positive and no greater than the corresponding parent budget.';
