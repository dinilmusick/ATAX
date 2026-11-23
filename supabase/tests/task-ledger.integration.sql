-- Rollback-only integration of global bounded-v2 claims and independent loop authoring.
-- No nested decomposition: execution is claimable only after a separate author
-- publishes a loop contract. Every checkpoint must pass a registered predicate.
begin;
do $test$
declare
  created jsonb;
  task_id uuid;
  registered public.tasks;
  author_claim public.tasks;
  authored public.tasks;
  claimed public.tasks;
  duplicate_claim public.tasks;
  verifier public.tasks;
  denied_claim public.tasks;
  other_verifier public.tasks;
  denied_wrong_fence boolean := false;
  checkpoint_index integer;
begin
  created := public.goal_ledger_create_with_tasks(
    'Task Ledger Smoke ' || replace(gen_random_uuid()::text,'-',''),
    'Rollback-only bounded-v2 global claim integration fixture',
    jsonb_build_object('purpose','exercise independent loop author and executor'),
    'Run registered task only through fenced claims.',
    jsonb_build_array('A globally claimed task is independently verified'),
    'integration-test-orchestrator',
    jsonb_build_object(
      'name','integration-test-direct-task',
      'description','Flat task with independently authored loop contract',
      'actions',jsonb_build_array(
        jsonb_build_object('description','Run the integration check'),
        jsonb_build_object('description','Capture passing checkpoint evidence')
      ),
      'general_pattern','author loop → independent claim → verify checkpoint predicates → submit → verify',
      'required_capabilities',jsonb_build_array('test-capability'),
      'acceptance_criteria',jsonb_build_array('Every test checkpoint passes'),
      'loop',jsonb_build_object('enabled',true,'objective','Pass the test','max_iterations',3)
    ),
    null,'{}'::jsonb
  );
  task_id := (created->>'root_task_id')::uuid;
  if task_id is null then raise exception 'Missing direct task id'; end if;
  -- The loop-author stage is explicit, not inferred from the task creator.
  update public.tasks
  set task_role='loop_authoring'
  where id=task_id
  returning * into registered;

  select * into author_claim from public.task_ledger_claim_next(
    'integration-test-author','Independent Loop Author','worker',
    array['test-capability']::text[],900
  );
  if author_claim.id is distinct from task_id then
    raise exception 'Global queue did not return the loop-authoring task';
  end if;

  select * into authored from public.task_ledger_finalize_loop_script(
    task_id,'integration-test-author',author_claim.claim_token,
    jsonb_build_object('enabled',true,'objective','Run direct task','max_iterations',3),
    jsonb_build_object('type','object'),
    registered.completion_parameters,
    '{}'::jsonb
  );
  if authored.loop_script_status<>'ready'
     or authored.task_role<>'execution'
     or authored.loop_author_agent_id<>'integration-test-author' then
    raise exception 'Independent loop contract was not published';
  end if;

  select * into claimed from public.task_ledger_claim_next(
    'integration-test-worker','Independent Executor','worker',
    array['test-capability']::text[],900
  );
  if claimed.id is distinct from task_id
     or claimed.loop_author_agent_id=claimed.claimed_by_agent_id then
    raise exception 'Executor did not claim the authorized, independently authored task';
  end if;
  select * into duplicate_claim from public.task_ledger_claim_next(
    'integration-test-worker-2','Second Executor','worker',
    array['test-capability']::text[],900
  );
  if duplicate_claim.id is not null then
    raise exception 'Global task claim duplicated a live lease';
  end if;

  perform public.task_ledger_record_loop_iteration(
    task_id,'integration-test-worker',claimed.claim_token,1,
    jsonb_build_object('phase','run'),
    jsonb_build_object('ok',true),
    jsonb_build_object('observation','pass'),
    jsonb_build_array(jsonb_build_object('criterion','Every test checkpoint passes','status','satisfied')),
    jsonb_build_object('phase','complete','iteration',1),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('type','test','result','passed')),
    'pass','Direct task loop passed'
  );
  for checkpoint_index in 0..jsonb_array_length(claimed.checkpoints)-1 loop
    perform public.record_checkpoint_predicate_result(
      task_id,checkpoint_index::smallint,'builtin.evidence_present',1,
      jsonb_build_object('checkpoint',checkpoint_index),
      jsonb_build_object('ok',true,'checkpoint',checkpoint_index),
      true,
      jsonb_build_array(jsonb_build_object('type','sql-test','result','passed')),
      'integration-test-worker',claimed.claim_token::text
    );
  end loop;
  perform public.task_ledger_submit_result(
    task_id,'integration-test-worker',claimed.claim_token,
    jsonb_build_object('ok',true),'Direct task completed',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('type','sql-test','result','passed')),
    'completed'
  );

  -- Targeted claims must not pull unrelated pending work from the global
  -- verification queue, including tasks owned by other workspaces.
  select * into denied_claim from public.task_ledger_claim_verification_for_task(
    gen_random_uuid(),'integration-test-verifier',900
  );
  if denied_claim.id is not null then
    raise exception 'Targeted verification claimed an unrelated task';
  end if;
  -- Even a service-role caller may not claim its own submitted result.
  select * into denied_claim from public.task_ledger_claim_verification_for_task(
    task_id,'integration-test-worker',900
  );
  if denied_claim.id is not null then
    raise exception 'Executor claimed its own submitted result';
  end if;
  select * into verifier from public.task_ledger_claim_verification_for_task(
    task_id,'integration-test-verifier',900
  );
  if verifier.id is distinct from task_id
     or verifier.verification_claim_token is null
     or verifier.verification_claim_expires_at <= statement_timestamp() then
    raise exception 'Targeted verifier did not acquire a live fenced claim';
  end if;
  select * into other_verifier from public.task_ledger_claim_verification_for_task(
    task_id,'integration-test-verifier-two',900
  );
  if other_verifier.id is not null then
    raise exception 'Another verifier stole a live claim';
  end if;
  begin
    perform public.task_ledger_verify_result_claimed(
      task_id,'integration-test-verifier',gen_random_uuid(),true,'{}'::jsonb
    );
  exception when others then
    denied_wrong_fence := true;
  end;
  if not denied_wrong_fence then
    raise exception 'Incorrect verifier fencing token was accepted';
  end if;
  if has_function_privilege('anon',
       'public.task_ledger_claim_verification_for_task(uuid,text,integer)','EXECUTE')
     or has_function_privilege('authenticated',
       'public.task_ledger_claim_verification_for_task(uuid,text,integer)','EXECUTE')
     or not has_function_privilege('service_role',
       'public.task_ledger_claim_verification_for_task(uuid,text,integer)','EXECUTE') then
    raise exception 'Targeted verifier RPC grants violate the service-role-only boundary';
  end if;
  perform public.task_ledger_verify_result_claimed(
    task_id,'integration-test-verifier',verifier.verification_claim_token,
    true,jsonb_build_object('verified',true,'independent',true)
  );
  select * into denied_claim from public.task_ledger_claim_verification_for_task(
    task_id,'integration-test-verifier-two',900
  );
  if denied_claim.id is not null then
    raise exception 'A verified task was claimable again';
  end if;
  if not exists(
    select 1 from public.tasks
    where id=task_id and status='completed' and verification_status='verified'
      and verified_by_agent_id='integration-test-verifier'
  ) then raise exception 'Verified bounded-v2 completion was not persisted'; end if;
  if not exists(
    select 1 from public.task_events e
    where e.task_id=(created->>'root_task_id')::uuid
      and e.payload->>'event_kind'='loop_contract_ready'
  ) then raise exception 'Independent loop authoring event was not recorded'; end if;
  raise notice 'PASS: independent author/executor, targeted fenced verifier, token/replay denial, scoped ACL and predicate-backed checkpoints';
end;
$test$;
rollback;
