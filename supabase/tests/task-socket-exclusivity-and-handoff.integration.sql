-- Rollback-only isolation: a task socket cannot be stolen while its lease
-- is active, and a displaced agent may leave exactly one safe handoff note.
BEGIN;
DO $test$
DECLARE
  fixture_goal_id uuid;
  registered public.tasks;
  first_claim public.tasks;
  after_takeover public.tasks;
  note public.task_events;
  retry_note public.task_events;
  denied_live_takeover boolean := false;
  denied_old_heartbeat boolean := false;
BEGIN
  INSERT INTO public.goals(name,created_by_agent_id,status)
  VALUES('Socket trigger fixture '||replace(gen_random_uuid()::text,'-',''),
         'fixture-orchestrator','ready')
  RETURNING id INTO fixture_goal_id;

  SELECT * INTO registered FROM public.task_ledger_register(
    'socket-trigger-test','Socket Trigger Fixture','Fenced direct task',
    'Rollback-only transition test',ARRAY['socket-trigger-only']::text[],
    'socket-fixture-session','worker',3::smallint,
    'Validate socket exclusivity','{}'::jsonb,null
  );
  UPDATE public.tasks
  SET goal_id=fixture_goal_id,
      target=(SELECT target FROM public.goals WHERE id=fixture_goal_id),
      required_capabilities=ARRAY['socket-trigger-only']::text[],
      task_role='loop_authoring'
  WHERE id=registered.id;

  SELECT * INTO first_claim FROM public.task_ledger_claim_goal_next(
    fixture_goal_id,'fixture-old-holder','First Worker','worker',
    ARRAY['socket-trigger-only']::text[],120
  );
  IF first_claim.id IS DISTINCT FROM registered.id THEN
    RAISE EXCEPTION 'Fixture was not atomically claimed';
  END IF;

  -- Database-level guard prevents even a direct owner update from replacing
  -- a valid running lease; the exception rolls back only the attempted update.
  BEGIN
    UPDATE public.tasks
    SET claimed_by_agent_id='intruder',claim_token=gen_random_uuid()
    WHERE id=registered.id;
  EXCEPTION WHEN OTHERS THEN
    denied_live_takeover := true;
  END;
  IF NOT denied_live_takeover THEN
    RAISE EXCEPTION 'Valid socket lease was stolen through direct SQL';
  END IF;
  IF (SELECT claim_token FROM public.tasks WHERE id=registered.id)
       IS DISTINCT FROM first_claim.claim_token THEN
    RAISE EXCEPTION 'Denied takeover still mutated the task token';
  END IF;

  -- Simulate the same transition that any canonical claim RPC performs after
  -- both recovery gates are met, but deliberately omit its recovery event.
  UPDATE public.tasks
  SET heartbeat_at=now()-interval '3 minutes',
      claim_expires_at=now()-interval '1 minute'
  WHERE id=registered.id;
  UPDATE public.tasks
  SET claimed_by_agent_id='fixture-new-holder',
      claim_token=gen_random_uuid(),
      claim_expires_at=now()+interval '2 minutes',
      heartbeat_at=now()
  WHERE id=registered.id RETURNING * INTO after_takeover;

  IF after_takeover.claim_token=first_claim.claim_token THEN
    RAISE EXCEPTION 'Replacement did not rotate fencing token';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.task_events e
    WHERE e.task_id=registered.id AND e.event_type='lease_recovered'
      AND e.payload->>'previous_claim_token'=first_claim.claim_token::text
      AND e.payload->>'previous_agent_id'='fixture-old-holder'
  ) THEN
    RAISE EXCEPTION 'Cross-transport claim replacement lacked prior token evidence';
  END IF;

  SELECT * INTO note FROM public.task_ledger_record_handoff(
    registered.id,'fixture-old-holder',first_claim.claim_token,
    'Lease lost: partial result saved; new holder should verify work.',
    jsonb_build_object('progress','partial','evidence',jsonb_build_array('fixture'),
                       'next_action','Continue independently')
  );
  IF note.event_type<>'handoff' THEN
    RAISE EXCEPTION 'Forfeiture completion note was not appended';
  END IF;
  SELECT * INTO retry_note FROM public.task_ledger_record_handoff(
    registered.id,'fixture-old-holder',first_claim.claim_token,
    'Retried note, must be idempotent','{}'::jsonb
  );
  IF retry_note.id IS DISTINCT FROM note.id THEN
    RAISE EXCEPTION 'Duplicate handoff was not idempotent';
  END IF;
  IF (SELECT claim_token FROM public.tasks WHERE id=registered.id)
       IS DISTINCT FROM after_takeover.claim_token THEN
    RAISE EXCEPTION 'Stale handoff overwrote new holder';
  END IF;
  BEGIN
    PERFORM public.task_ledger_heartbeat_claim(
      registered.id,'fixture-old-holder',first_claim.claim_token,
      'Invalid heartbeat after forfeiture',120
    );
  EXCEPTION WHEN OTHERS THEN
    denied_old_heartbeat:=true;
  END;
  IF NOT denied_old_heartbeat THEN
    RAISE EXCEPTION 'Old task holder extended a forfeited lease';
  END IF;

  RAISE NOTICE 'PASS: active-lease guard, universal recovery audit, append-only idempotent handoff and stale-write denial';
END;
$test$;
ROLLBACK;
