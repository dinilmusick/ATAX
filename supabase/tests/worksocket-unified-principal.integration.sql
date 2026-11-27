-- Same authenticated ATAX caller can orchestrate, author, execute and verify.
-- Claim tokens, live leases, task scope, loop readiness and evidence predicates
-- remain authoritative. All fixtures are rolled back.
BEGIN;
DO $test$
DECLARE
  caller_id text := 'same-principal-' || left(gen_random_uuid()::text,8);
  session_id text := 'same-session-' || left(gen_random_uuid()::text,8);
  goal_name text := 'Unified Principal ' || replace(gen_random_uuid()::text,'-','');
  created jsonb;
  task_id uuid;
  authored public.tasks;
  claimed public.tasks;
  verifier public.tasks;
  result_task public.tasks;
  stale_denied boolean := false;
  goal_key_value text;
  i integer;
BEGIN
  created := public.goal_ledger_create_with_tasks(
    goal_name,
    'Rollback-only proof that one authenticated caller can own all WorkSocket roles',
    jsonb_build_object('purpose','same-principal end-to-end execution'),
    'Execute through canonical fenced claims and evidence predicates.',
    jsonb_build_array('Same principal can author, execute and verify the task'),
    caller_id,
    jsonb_build_object(
      'name','same-principal-task',
      'description','A bounded task whose author and executor are intentionally the same caller',
      'actions',jsonb_build_array(
        jsonb_build_object('description','Run the deterministic check'),
        jsonb_build_object('description','Persist reproducible evidence')
      ),
      'general_pattern','claim → author → execute → observe → submit → verify',
      'acceptance_criteria',jsonb_build_array('Deterministic check passes'),
      'loop',jsonb_build_object(
        'enabled',true,'objective','Pass the deterministic check','max_iterations',3
      )
    ),
    null,
    jsonb_build_object('integration_test',true,'identity_separation',false)
  );
  task_id := (created->>'root_task_id')::uuid;
  IF task_id IS NULL THEN RAISE EXCEPTION 'Goal creation returned no root task'; END IF;

  UPDATE public.tasks SET task_role='loop_authoring' WHERE id=task_id;
  SELECT * INTO claimed FROM public.goal_ledger_claim_task(
    goal_name,caller_id,'Same Principal','orchestrator',ARRAY[]::text[],session_id,120
  );
  IF claimed.id IS DISTINCT FROM task_id
     OR claimed.claimed_by_agent_id IS DISTINCT FROM caller_id
     OR claimed.claimed_session_id IS DISTINCT FROM session_id
     OR claimed.claim_token IS NULL THEN
    RAISE EXCEPTION 'Goal creator/orchestrator could not claim its own task';
  END IF;

  -- A wrong token still cannot renew the live claim.
  BEGIN
    PERFORM public.task_ledger_heartbeat_claim(
      task_id,caller_id,gen_random_uuid(),'wrong-fence',120,'{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN stale_denied:=true;
  END;
  IF NOT stale_denied OR public.task_ledger_check_claim(task_id,caller_id,gen_random_uuid()) THEN
    RAISE EXCEPTION 'Stale or wrong claim token was accepted';
  END IF;

  authored := public.task_ledger_finalize_loop_script(
    task_id,caller_id,claimed.claim_token,
    jsonb_build_object('enabled',true,'objective','Pass deterministic check','max_iterations',3),
    jsonb_build_object('type','object','required',jsonb_build_array('evidence')),
    claimed.completion_parameters,
    '{}'::jsonb
  );
  IF authored.loop_script_status<>'ready'
     OR authored.loop_author_agent_id IS DISTINCT FROM caller_id
     OR authored.status<>'queued' THEN
    RAISE EXCEPTION 'Loop authoring did not produce a ready execution contract';
  END IF;

  -- Goal-scoped claims now allow the same caller to execute its authored task.
  SELECT g.goal_key INTO goal_key_value
  FROM public.goals g WHERE g.id=authored.goal_id;
  IF goal_key_value IS NULL THEN RAISE EXCEPTION 'Created goal key not found'; END IF;
  SELECT * INTO claimed FROM public.atax_goal_claim_safe(
    goal_key_value,
    caller_id,'Same Principal','orchestrator',ARRAY[]::text[],session_id,120
  );
  IF claimed.id IS DISTINCT FROM task_id
     OR claimed.claimed_by_agent_id IS DISTINCT FROM caller_id
     OR claimed.claim_token IS NULL THEN
    RAISE EXCEPTION 'Same caller could not execute its ready loop contract';
  END IF;

  PERFORM public.task_ledger_record_loop_iteration(
    task_id,caller_id,claimed.claim_token,1,
    jsonb_build_object('run','same-principal'),
    jsonb_build_object('ok',true),
    jsonb_build_object('observed','pass'),
    jsonb_build_array(jsonb_build_object('criterion','Deterministic check passes','status','satisfied')),
    jsonb_build_object('iteration',1),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('type','sql-test','result','passed')),
    'pass','Same-principal execution passed'
  );

  FOR i IN 0..jsonb_array_length(claimed.checkpoints)-1 LOOP
    PERFORM public.record_checkpoint_predicate_result(
      task_id,i::smallint,'builtin.evidence_present',1,
      jsonb_build_object('task_id',task_id,'checkpoint',i,'evidence',jsonb_build_array('checkpoint passed')),
      jsonb_build_object('ok',true,'checkpoint',i),true,
      jsonb_build_array(jsonb_build_object('type','sql-test','result','passed')),
      caller_id,claimed.claim_token::text
    );
  END LOOP;

  result_task := public.task_ledger_submit_result(
    task_id,caller_id,claimed.claim_token,
    jsonb_build_object('ok',true),'Same-principal result submitted',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('type','sql-test','result','passed')),
    'completed'
  );
  IF result_task.status<>'completed' OR result_task.verification_status<>'pending' THEN
    RAISE EXCEPTION 'Result was not placed into evidence verification';
  END IF;

  -- The same authenticated caller may claim the separate verification stage.
  SELECT * INTO verifier FROM public.task_ledger_claim_verification_for_task(
    task_id,caller_id,120
  );
  IF verifier.id IS DISTINCT FROM task_id OR verifier.verification_claim_token IS NULL THEN
    RAISE EXCEPTION 'Same caller could not claim evidence verification';
  END IF;
  PERFORM public.task_ledger_verify_result_claimed(
    task_id,caller_id,verifier.verification_claim_token,true,
    jsonb_build_object(
      'method','SQL integration evidence',
      'evidence',jsonb_build_array('loop iteration passed','all checkpoint predicates passed'),
      'same_principal',true
    )
  );

  IF NOT EXISTS(SELECT 1 FROM public.tasks
    WHERE id=task_id AND status='completed' AND verification_status='verified'
      AND claimed_by_agent_id=caller_id AND verified_by_agent_id=caller_id) THEN
    RAISE EXCEPTION 'Same-principal verified completion was not persisted';
  END IF;

  RAISE NOTICE 'PASS: creator claim, loop author, executor, evidence submitter and verifier may be one authenticated caller; stale fence rejected';
END
$test$;
ROLLBACK;
