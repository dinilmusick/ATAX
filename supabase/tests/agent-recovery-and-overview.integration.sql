-- Rollback-only integration test: bounded-v2 goal recovery and canonical overview.
-- A single direct task replaces the retired nested parent/leaf fixture.
begin;
do $test$
declare
  created jsonb;
  goal_key_value text;
  goal_id_value uuid;
  first_claim public.tasks;
  early_claim public.tasks;
  recovered public.tasks;
  overview jsonb;
  goal_row jsonb;
begin
  created := public.goal_ledger_create_with_tasks(
    'Recovery Smoke ' || replace(gen_random_uuid()::text,'-',''),
    'Rollback-only five-minute stale-heartbeat recovery test',
    jsonb_build_object('purpose','bounded-v2 recovery integration fixture'),
    'Check claim fencing and overview visibility.',
    jsonb_build_array('A stale direct task can be atomically reclaimed after five minutes'),
    'recovery-test-orchestrator',
    jsonb_build_object(
      'name','Recovery test leaf',
      'description','Single direct task; no nested tasks',
      'actions',jsonb_build_array(
        jsonb_build_object('description','Claim the direct task'),
        jsonb_build_object('description','Simulate stale heartbeat'),
        jsonb_build_object('description','Verify fencing and overview evidence')
      ),
      'general_pattern','claim → simulate stale heartbeat → verify ownership and overview',
      'acceptance_criteria',jsonb_build_array('Second worker obtains a new fencing token'),
      'required_capabilities',jsonb_build_array('recovery-test'),
      'loop',jsonb_build_object('enabled',true,'objective','Verify recovery','max_iterations',2)
    ),
    null,
    jsonb_build_object('integration_test',true)
  );
  goal_id_value := (created->'goal'->>'id')::uuid;
  goal_key_value := created->'goal'->>'goal_key';
  if goal_id_value is null or goal_key_value is null then
    raise exception 'Goal creation returned no ID or readable key';
  end if;

  select * into first_claim
  from public.goal_ledger_claim_task_by_key(
    goal_key_value,'recovery-worker-old','Old Worker','worker',
    array['recovery-test']::text[],'recovery-session-old',900
  );
  if first_claim.id is distinct from (created->>'root_task_id')::uuid
     or first_claim.task_name<>'Recovery test leaf'
     or first_claim.execution_model<>'bounded-v2' then
    raise exception 'Initial claim did not select the bounded-v2 direct task';
  end if;
  if jsonb_array_length(first_claim.completion_parameters)<>3 then
    raise exception 'Action objects did not produce three completion parameters';
  end if;

  update public.tasks
  set heartbeat_at=now()-interval '4 minutes 59 seconds',
      claim_expires_at=now()-interval '1 minute',
      current_step='Recent heartbeat despite expired lease'
  where id=first_claim.id;

  select * into early_claim
  from public.task_ledger_claim_goal_next(
    goal_id_value,'recovery-worker-early','Early Worker','worker',
    array['recovery-test']::text[],900
  );
  if early_claim.id is not null then
    raise exception 'Task was reclaimed before five-minute heartbeat threshold';
  end if;

  update public.tasks
  set heartbeat_at=now()-interval '5 minutes 1 second',
      claim_expires_at=now()+interval '15 minutes',
      current_step='Stale heartbeat for recovery'
  where id=first_claim.id;

  select * into recovered
  from public.task_ledger_claim_goal_next(
    goal_id_value,'recovery-worker-new','Recovery Worker','worker',
    array['recovery-test']::text[],900
  );
  if recovered.id is distinct from first_claim.id then
    raise exception 'Stale task was not reclaimed';
  end if;
  if recovered.claimed_by_agent_id<>'recovery-worker-new'
     or recovered.claim_token=first_claim.claim_token
     or recovered.attempt_count<>first_claim.attempt_count+1 then
    raise exception 'Recovery did not replace owner, token and attempt';
  end if;
  if not exists(
    select 1 from public.task_events e
    where e.task_id=recovered.id and e.event_type='lease_recovered'
      and e.payload->>'previous_agent_id'='recovery-worker-old'
      and e.payload->>'recovery_reason'='heartbeat_timeout'
  ) then
    raise exception 'Recovery event did not preserve prior worker evidence';
  end if;

  if public.task_ledger_check_claim(first_claim.id,'recovery-worker-old',first_claim.claim_token) then
    raise exception 'Prior worker retained fencing authority';
  end if;

  overview := public.goal_ledger_overview(null);
  select item into goal_row from jsonb_array_elements(overview->'goals') item
    where item->>'id'=goal_id_value::text;
  if goal_row is null then raise exception 'Overview omitted the active goal'; end if;
  if not exists(
    select 1 from jsonb_array_elements(goal_row->'tasks') item
    where item->>'agent_id'='recovery-worker-new'
      and item->>'task_key'=recovered.task_key
  ) then
    raise exception 'Overview omitted current direct-task ownership';
  end if;
  if (goal_row->'task_counts'->>'running')::int<1 then
    raise exception 'Overview did not aggregate running task';
  end if;

  raise notice 'PASS: bounded-v2 direct task, five-minute heartbeat recovery, fencing and complete overview';
end;
$test$;
rollback;
