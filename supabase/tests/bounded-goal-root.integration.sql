-- Verify bounded-v2 goal initialization does not incorrectly require goal-level
-- leaf actions; actual task-level 1..4 action contracts remain mandatory.
-- Roll back all changes; never touch production state in CI.
BEGIN;
DO $test$
DECLARE
  created jsonb;
  rejected boolean := false;
  g_id uuid;
  direct_tasks integer;
BEGIN
  created := public.goal_ledger_create_hierarchical(
    'MCP Root Validation Smoke ' || replace(gen_random_uuid()::text,'-',''),
    'Smoke test for goal versus direct task action validation',
    '{}'::jsonb,
    'Run finite direct tasks and independently verify.',
    jsonb_build_array('Direct task has 1-4 valid action objects'),
    array['atax','integration']::text[],
    jsonb_build_object('enabled',true,'objective','Complete direct tasks','max_iterations',2),
    jsonb_build_array(
      jsonb_build_object(
        'name','MCP root direct task',
        'description','A direct task that has its own actions',
        'actions',jsonb_build_array(jsonb_build_object('description','Validate root action contract')),
        'general_pattern','inspect → validate → verify',
        'acceptance_criteria',jsonb_build_array('Root validation accepts direct action'),
        'loop',jsonb_build_object('enabled',true,'objective','Verify bounded task', 'max_iterations',2)
      )
    ),
    'atax-root-test-orchestrator'
  );
  g_id:=(created->'goal'->>'id')::uuid;
  IF g_id IS NULL THEN RAISE EXCEPTION 'Bounded goal helper returned no goal ID'; END IF;
  SELECT count(*) INTO direct_tasks FROM public.tasks WHERE goal_id=g_id AND parent_task_id IS NULL;
  IF direct_tasks<>1 THEN RAISE EXCEPTION 'Expected one direct bounded task, got %',direct_tasks; END IF;
  IF (SELECT execution_model FROM public.goals WHERE id=g_id)<>'bounded-v2' THEN
    RAISE EXCEPTION 'Expected bounded-v2 goal model';
  END IF;
  BEGIN
    PERFORM public.goal_ledger_create_hierarchical(
      'MCP Malformed Direct Task ' || replace(gen_random_uuid()::text,'-',''),
      'Reject a malformed real direct task',
      '{}'::jsonb,
      'Reject missing action objects.',
      jsonb_build_array('Malformed task is rejected'),
      array['atax']::text[],
      jsonb_build_object('enabled',true,'objective','Reject malformed', 'max_iterations',2),
      jsonb_build_array(jsonb_build_object(
        'name','Malformed direct task',
        'description','Must reject zero actions',
        'actions','[]'::jsonb,
        'general_pattern','reject invalid',
        'acceptance_criteria',jsonb_build_array('This must fail'),
        'loop',jsonb_build_object('enabled',true,'objective','Never execute','max_iterations',2)
      )),
      'atax-root-test-orchestrator'
    );
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%actions%' THEN rejected:=true; ELSE RAISE; END IF;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Malformed direct task with no actions bypassed validation'; END IF;
  RAISE NOTICE 'PASS: root goal creation accepts valid direct tasks; zero-action direct task rejected';
END;
$test$;
ROLLBACK;
