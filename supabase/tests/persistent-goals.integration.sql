-- Rollback-only integration test of the current flat bounded-v2 goal lifecycle.
-- Preserve exclusive claiming, loop evidence, independent verification, finalization and resume.
begin;
do $test$
declare
  goal_name text := 'Goal Smoke ' || replace(gen_random_uuid()::text,'-','');
  created jsonb;
  goal_id_value uuid;
  direct_task_id uuid;
  claimed public.tasks;
  second_claim public.tasks;
  verifier public.tasks;
  final_goal public.goals;
  resumed jsonb;
begin
  created := public.goal_ledger_create_with_tasks(
    goal_name,'Rollback-only end-to-end direct-task goal test',
    jsonb_build_object('purpose','validate resumable bounded-v2 goal flow'),
    'Execute only the persisted direct-task contract.',
    jsonb_build_array('One direct task is independently verified'),
    'smoke-orchestrator',
    jsonb_build_object(
      'name','Smoke direct task',
      'description','One independently claimable bounded-v2 task',
      'actions',jsonb_build_array(
        jsonb_build_object('description','Run the smoke check'),
        jsonb_build_object('description','Capture reproducible test evidence')
      ),
      'general_pattern','claim → run → observe → submit → independently verify',
      'acceptance_criteria',jsonb_build_array('Smoke check passes'),
      'verification',jsonb_build_object('required',true,'method','independent'),
      'loop',jsonb_build_object(
        'enabled',true,
        'objective','Pass the smoke check',
        'max_iterations',3,
        'initial_input',jsonb_build_object('task_name','Smoke direct task')
      )
    ),
    null,
    jsonb_build_object('integration_test',true)
  );
  goal_id_value := (created->'goal'->>'id')::uuid;
  direct_task_id := (created->>'root_task_id')::uuid;
  if goal_id_value is null or direct_task_id is null then
    raise exception 'Goal/direct task creation returned incomplete IDs';
  end if;
  if (select execution_model from public.tasks where id=direct_task_id)<>'bounded-v2' then
    raise exception 'Direct task did not use bounded-v2';
  end if;

  select * into claimed from public.goal_ledger_claim_task(
    goal_name,'smoke-worker','Smoke Worker','worker',array[]::text[],
    'session-smoke',900
  );
  if claimed.id is distinct from direct_task_id
     or claimed.claimed_session_id<>'session-smoke' then
    raise exception 'Worker did not claim the expected direct task';
  end if;

  select * into second_claim from public.goal_ledger_claim_task(
    goal_name,'smoke-worker-2','Smoke Worker 2','worker',array[]::text[],
    'session-smoke-2',900
  );
  if second_claim.id is not null then
    raise exception 'Second worker duplicated an active claim';
  end if;

  perform public.task_ledger_record_loop_iteration(
    claimed.id,'smoke-worker',claimed.claim_token,1,
    jsonb_build_object('task_name','Smoke direct task'),
    jsonb_build_object('ok',true),
    jsonb_build_object('observed','pass'),
    jsonb_build_array(jsonb_build_object('criterion','Smoke check passes','status','satisfied')),
    jsonb_build_object('iteration',1),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('type','test','result','passed')),
    'pass','Smoke check passed'
  );
  perform public.task_ledger_submit_result(
    claimed.id,'smoke-worker',claimed.claim_token,
    jsonb_build_object('ok',true),'Smoke direct task completed',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('type','test','result','passed')),
    'completed'
  );

  select * into verifier from public.task_ledger_claim_verification('smoke-independent-verifier',900);
  if verifier.id is distinct from claimed.id then
    raise exception 'Independent verifier did not claim submitted direct task';
  end if;
  perform public.task_ledger_verify_result_claimed(
    verifier.id,'smoke-independent-verifier',verifier.verification_claim_token,
    true,jsonb_build_object('independent',true,'method','SQL integration assertion')
  );
  if not exists(select 1 from public.tasks where id=direct_task_id
                and status='completed' and verification_status='verified') then
    raise exception 'Independent verification did not persist';
  end if;

  final_goal := public.goal_ledger_finalize(
    goal_name,'smoke-orchestrator',jsonb_build_object('verified',true)
  );
  if final_goal.status<>'completed' then raise exception 'Goal did not finalize'; end if;
  resumed := public.goal_ledger_resume(goal_name);
  if resumed->'summary'->'tasks'->>'completed'<>'1' then
    raise exception 'Resume summary incorrect: %',resumed;
  end if;
  raise notice 'PASS: bounded-v2 goal, exclusive claim, passing loop, submission, independent verifier and finalization';
end;
$test$;
rollback;
