-- The caller may be the same principal that authored/executed the task, but
-- cannot choose a successful predicate verdict independently of its evidence.
BEGIN;
DO $test$
DECLARE
  test_task_id uuid;
  rejected_missing_evidence boolean := false;
  rejected_contradictory_verdict boolean := false;
  error_text text;
BEGIN
  SELECT public.task_ledger_create_tree(
    'worksocket-evidence-test',
    'worksocket-evidence-test',
    jsonb_build_object(
      'name','worksocket-evidence-gate-test',
      'description','Rollback-only built-in predicate evaluator regression',
      'general_pattern','input → evaluate evidence → persist predicate receipt',
      'actions',jsonb_build_array(jsonb_build_object('description','Evaluate evidence presence')),
      'completion_parameters',jsonb_build_array(
        jsonb_build_object('id','evidence','description','Nonempty evidence receipt')
      )
    ),
    NULL,
    'worksocket-evidence-test',
    'worker'
  ) INTO test_task_id;
  IF test_task_id IS NULL THEN
    RAISE EXCEPTION 'Evidence-gate fixture task was not created';
  END IF;

  -- Valid evidence is accepted when the caller-supplied verdict agrees with
  -- the server-computed builtin.evidence_present result.
  PERFORM public.record_checkpoint_predicate_result(
    test_task_id,0,'builtin.evidence_present',1,
    jsonb_build_object('evidence',jsonb_build_array('observed-check')),
    'true'::jsonb,true,
    jsonb_build_array(jsonb_build_object('type','fixture','receipt','evidence-present')),
    'worksocket-evidence-test',NULL
  );

  -- The same actor cannot force true with empty evidence.
  BEGIN
    PERFORM public.record_checkpoint_predicate_result(
      test_task_id,0,'builtin.evidence_present',1,
      jsonb_build_object('evidence','[]'::jsonb),
      'true'::jsonb,true,'[]'::jsonb,
      'worksocket-evidence-test',NULL
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS error_text=MESSAGE_TEXT;
    rejected_missing_evidence :=
      position('caller predicate verdict differs from the registered server evaluation' IN error_text)>0;
  END;
  IF NOT rejected_missing_evidence THEN
    RAISE EXCEPTION 'Caller forced a passing predicate with empty evidence';
  END IF;

  -- The caller also cannot report false when the registered evaluator
  -- computes true from valid evidence.
  BEGIN
    PERFORM public.record_checkpoint_predicate_result(
      test_task_id,0,'builtin.evidence_present',1,
      jsonb_build_object('evidence',jsonb_build_array('observed-check')),
      'false'::jsonb,false,
      jsonb_build_array(jsonb_build_object('type','fixture','receipt','evidence-present')),
      'worksocket-evidence-test',NULL
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS error_text=MESSAGE_TEXT;
    rejected_contradictory_verdict :=
      position('caller predicate verdict differs from the registered server evaluation' IN error_text)>0;
  END;
  IF NOT rejected_contradictory_verdict THEN
    RAISE EXCEPTION 'Caller overrode a passing server-evaluated predicate';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tasks t
    WHERE t.id=test_task_id
      AND t.checkpoints->0->>'status'='succeeded'
      AND jsonb_array_length(t.checkpoints->0->'evidence')>0
      AND EXISTS (
        SELECT 1 FROM public.predicate_executions p
        WHERE p.task_id=t.id AND p.checkpoint_index=0
          AND p.predicate_key='builtin.evidence_present'
          AND p.passed=true AND jsonb_array_length(p.evidence)>0
      )
  ) THEN
    RAISE EXCEPTION 'Rejected forged verdict changed the successful predicate receipt';
  END IF;
END
$test$;
ROLLBACK;
