-- Rollback-only integration fixture: real System-bound creation and role handoff.
BEGIN;
DO $test$
DECLARE
  created jsonb;
  goal_uuid uuid;
  target_system_id uuid;
  invalid_task_rejected boolean := false;
  unknown_system_rejected boolean := false;
BEGIN
  SELECT id INTO target_system_id FROM public.systems WHERE system_key='atax';
  IF target_system_id IS NULL THEN
    -- Isolated CI migrations may not seed a named System. Build one in this transaction
    -- with canonical required fields; production already has the ATAX System.
    INSERT INTO public.systems (system_key,name,system_type,status,description)
    VALUES ('atax','ATAX Test System','service','active','Rollback-only System-bound integration fixture')
    RETURNING id INTO target_system_id;
  END IF;
  created := public.atax_goal_create_system_bounded(
    'atax',
    'ATAX System Goal Root Regression ' || replace(gen_random_uuid()::text,'-',''),
    'Isolated, rollback-only MCP system-bound goal creation',
    '{}'::jsonb,
    'Create exactly one real valid direct task; preserve independent authoring.',
    jsonb_build_array('System, goal and task relationships remain valid'),
    ARRAY['atax','mcp','integration']::text[],
    jsonb_build_object('enabled',true,'objective','Prove bound goal creation','max_iterations',2),
    jsonb_build_array(
      jsonb_build_object(
        'name','Bounded goal direct task',
        'description','Validate the actual direct task action contract',
        'actions',jsonb_build_array(jsonb_build_object('description','Verify bound goal, task, and authoring status')),
        'general_pattern','inspect → validate → verify',
        'acceptance_criteria',jsonb_build_array('Task is linked to the correct System'),
        'loop',jsonb_build_object('enabled',true,'objective','Verify isolated task','max_iterations',2)
      )
    ),
    'atax-system-bound-test-orchestrator',
    '{}'::jsonb
  );
  goal_uuid := (created->'goal'->>'id')::uuid;
  IF goal_uuid IS NULL THEN RAISE EXCEPTION 'Bounded wrapper returned no goal UUID'; END IF;
  IF (SELECT system_id FROM public.goals WHERE id=goal_uuid) IS DISTINCT FROM target_system_id THEN
    RAISE EXCEPTION 'System-bound goal did not link to ATAX';
  END IF;
  IF (SELECT count(*) FROM public.tasks WHERE goal_id=goal_uuid
      AND system_id=target_system_id AND parent_task_id IS NULL
      AND task_role='loop_authoring' AND loop_script_status='missing') <> 1 THEN
    RAISE EXCEPTION 'Direct task was not linked and prepared for independent loop authoring';
  END IF;
  BEGIN
    PERFORM public.atax_goal_create_system_bounded(
      'atax','ATAX Invalid Task ' || gen_random_uuid()::text,
      'Malformed direct task must fail','{}'::jsonb,
      'Reject zero actions',jsonb_build_array('Invalid task rejected'),ARRAY['atax']::text[],
      jsonb_build_object('enabled',true,'objective','Reject invalid task','max_iterations',2),
      jsonb_build_array(jsonb_build_object(
        'name','Invalid direct task','description','Zero actions cannot be permitted',
        'actions','[]'::jsonb,'general_pattern','reject',
        'acceptance_criteria',jsonb_build_array('Must not create'),
        'loop',jsonb_build_object('enabled',true,'objective','Reject','max_iterations',2)
      )),'atax-system-bound-test-orchestrator','{}'::jsonb
    );
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM ILIKE '%action%' THEN invalid_task_rejected:=true; ELSE RAISE; END IF;
  END;
  IF NOT invalid_task_rejected THEN RAISE EXCEPTION 'Malformed direct task incorrectly accepted'; END IF;
  BEGIN
    PERFORM public.atax_goal_create_system_bounded(
      'nonexistent-atax-integration-system','Wrong System Test','Reject unknown System',
      '{}'::jsonb,'Do not allow unrecognised System',jsonb_build_array('Wrong System denied'),
      ARRAY['atax']::text[],jsonb_build_object('enabled',true,'objective','Reject wrong System','max_iterations',2),
      jsonb_build_array(jsonb_build_object(
        'name','Wrong System task','description','Never created',
        'actions',jsonb_build_array(jsonb_build_object('description','Never execute')),
        'general_pattern','reject',
        'acceptance_criteria',jsonb_build_array('Wrong System rejected'),
        'loop',jsonb_build_object('enabled',true,'objective','Reject','max_iterations',2)
      )),'atax-system-bound-test-orchestrator','{}'::jsonb
    );
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM ILIKE '%System not found%' THEN unknown_system_rejected:=true; ELSE RAISE; END IF;
  END;
  IF NOT unknown_system_rejected THEN RAISE EXCEPTION 'Unknown System incorrectly accepted'; END IF;
  RAISE NOTICE 'PASS: bounded goal, system link, loop authoring, invalid task denial and missing System denial';
END
$test$;
ROLLBACK;
