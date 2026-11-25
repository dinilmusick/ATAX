-- Rollback-only regression test for five-minute heartbeat recovery and fencing.
begin;
do $test$
declare
  registered public.tasks;
  fixture_goal_id uuid;
  first_claim public.tasks;
  early_claim public.tasks;
  premature_claim public.tasks;
  recovered public.tasks;
  handoff public.task_events;
  handoff_retry public.task_events;
  next_task public.tasks;
  next_claim public.tasks;
  forged_note_rejected boolean := false;
  active_note_rejected boolean := false;
  old_token uuid;
  expired_heartbeat_rejected boolean := false;
begin
  insert into public.goals(name,created_by_agent_id,status)
  values ('Fixture heartbeat-hardening ' || replace(gen_random_uuid()::text,'-',''),'heartbeat-hardening-orchestrator','ready')
  returning id into fixture_goal_id;
  select * into registered from public.task_ledger_register(
    'heartbeat-hardening-test','Heartbeat Hardening Test','5-minute recovery leaf',
    'Disposable integration-test task',array['heartbeat-hardening']::text[],
    'heartbeat-hardening-session','worker',3::smallint,'Testing five-minute recovery','{}'::jsonb,null
  );
  update public.tasks
  set status='waiting'
  where id<>registered.id and status in ('queued','running');

  update public.tasks
  set goal_id=fixture_goal_id, target=(select target from public.goals where id=fixture_goal_id), required_capabilities=array['heartbeat-hardening']::text[], task_role='loop_authoring'
  where id=registered.id;

  select * into first_claim from public.task_ledger_claim_next(
    'heartbeat-hardening-old','Old Worker','worker',array['heartbeat-hardening']::text[],600
  );
  if first_claim.id is distinct from registered.id then
    raise exception 'Initial worker did not claim the test task';
  end if;
  if first_claim.claim_expires_at>now()+interval '2 minutes 2 seconds' then raise exception 'Claim lease exceeds two-minute cap'; end if;
  old_token:=first_claim.claim_token;

  perform public.task_ledger_heartbeat_claim(
    first_claim.id,'heartbeat-hardening-old',old_token,
    'Implementing lease hardening',600,
    jsonb_build_object(
      'activity','writing recovery migration',
      'progress','Claim path and heartbeat path audited',
      'discoveries',jsonb_build_array('claim token is the fencing token'),
      'next_action','run stale recovery test'
    )
  );

  if not public.task_ledger_check_claim(first_claim.id,'heartbeat-hardening-old',old_token) then
    raise exception 'Active worker failed its ownership check';
  end if;

  -- Expiration fences even the prior holder: it cannot silently revive a lost lease.
  update public.tasks set claim_expires_at=now()-interval '1 second'
  where id=first_claim.id;
  begin
    perform public.task_ledger_heartbeat_claim(
      first_claim.id,'heartbeat-hardening-old',old_token,'Illegal renewal',600,
      '{}'::jsonb
    );
  exception when others then expired_heartbeat_rejected:=true;
  end;
  if not expired_heartbeat_rejected then
    raise exception 'Expired claim holder renewed its socket lease';
  end if;
  update public.tasks set claim_expires_at=now()+interval '10 minutes'
  where id=first_claim.id;

  update public.tasks
  set heartbeat_at=now()-interval '4 minutes 59 seconds'
  where id=first_claim.id;

  select * into early_claim from public.task_ledger_claim_next(
    'heartbeat-hardening-early','Early Worker','worker',array['heartbeat-hardening']::text[],600
  );
  if early_claim.id is not null then
    raise exception 'Task was reclaimed before the five-minute heartbeat threshold';
  end if;

  update public.tasks
  set heartbeat_at=now()-interval '5 minutes 1 second'
  where id=first_claim.id;

  -- A stale heartbeat must NOT defeat an unexpired lease.
  select * into premature_claim from public.task_ledger_claim_next(
    'heartbeat-hardening-premature','Premature Worker','worker',array['heartbeat-hardening']::text[],600
  );
  if premature_claim.id is not null then
    raise exception 'Stale heartbeat bypassed a still-valid socket lease';
  end if;
  update public.tasks set claim_expires_at=now()-interval '1 second'
  where id=first_claim.id;

  select * into recovered from public.task_ledger_claim_next(
    'heartbeat-hardening-new','Recovery Worker','worker',array['heartbeat-hardening']::text[],600
  );
  if recovered.id is distinct from first_claim.id then
    raise exception 'Stale heartbeat did not allow reassignment after five minutes';
  end if;
  if recovered.claimed_by_agent_id<>'heartbeat-hardening-new' then
    raise exception 'Recovered task owner was not replaced';
  end if;
  if recovered.claim_token=old_token then
    raise exception 'Recovery did not rotate the fencing token';
  end if;
  if not exists(
    select 1 from public.task_events e
    where e.task_id=recovered.id
      and e.event_type='lease_recovered'
      and e.payload->>'previous_agent_id'='heartbeat-hardening-old'
      and e.payload->>'recovery_reason'='heartbeat_timeout'
      and e.payload->>'recovery_threshold_minutes'='5'
      and (e.payload->'previous_heartbeat_context'->>'activity')='writing recovery migration'
  ) then
    raise exception 'Recovery did not preserve the last heartbeat context';
  end if;

  if public.task_ledger_check_claim(first_claim.id,'heartbeat-hardening-old',old_token) then
    raise exception 'Old worker retained ownership after fencing-token rotation';
  end if;

  select * into handoff from public.task_ledger_record_handoff(
    recovered.id,'heartbeat-hardening-old',old_token,
    'Lost ownership while implementing lease hardening; next worker should continue from the last heartbeat checkpoint.',
    jsonb_build_object('last_known_step','Implementing lease hardening')
  );
  if handoff.event_type<>'handoff' then
    raise exception 'Handoff event was not recorded';
  end if;

  -- One former holder may append its completion note but cannot modify the new occupant.
  select * into handoff_retry from public.task_ledger_record_handoff(
    recovered.id,'heartbeat-hardening-old',old_token,
    'Duplicate retry should not create another handoff event.',
    jsonb_build_object('reason','lost lease')
  );
  if handoff_retry.id is distinct from handoff.id then
    raise exception 'Repeated forfeiture note was not idempotent';
  end if;
  begin
    perform public.task_ledger_record_handoff(
      recovered.id,'heartbeat-hardening-impostor',gen_random_uuid(),
      'Unauthorized forged completion note', '{}'::jsonb
    );
  exception when others then forged_note_rejected:=true;
  end;
  if not forged_note_rejected then
    raise exception 'Unknown claim token was permitted to append a task handoff';
  end if;
  begin
    perform public.task_ledger_record_handoff(
      recovered.id,'heartbeat-hardening-new',recovered.claim_token,
      'Still active; not a forfeited claim', '{}'::jsonb
    );
  exception when others then active_note_rejected:=true;
  end;
  if not active_note_rejected then
    raise exception 'An active socket holder fabricated its own forfeiture';
  end if;

  -- The displaced external agent CONTINUES its session and claims other work.
  select * into next_task from public.task_ledger_register(
    'heartbeat-hardening-next','Fresh Task For Former Agent',
    'Another free work socket','Do different work after recorded forfeiture',
    array['heartbeat-hardening']::text[],'heartbeat-hardening-session',
    'worker',3::smallint,'Verify continuation','{}'::jsonb,null
  );
  update public.tasks set goal_id=fixture_goal_id,
    target=(select target from public.goals where id=fixture_goal_id),
    required_capabilities=array['heartbeat-hardening']::text[],
    task_role='loop_authoring' where id=next_task.id;

  select * into next_claim from public.task_ledger_claim_next(
    'heartbeat-hardening-old','Continuing Worker','worker',
    array['heartbeat-hardening']::text[],120
  );
  if next_claim.id is distinct from next_task.id then
    raise exception 'Displaced worker could not claim another available socket';
  end if;
  if next_claim.id=recovered.id or next_claim.claim_token=old_token then
    raise exception 'Displaced worker reused forbidden socket/fencing token';
  end if;

  raise notice 'PASS: stale heartbeat plus expired lease recovery, durable checkpoint context, fencing and handoff evidence';
end;
$test$;
rollback;
