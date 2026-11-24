-- Rollback-only regression for fenced task-claim recovery.
BEGIN;

DO $fixture$
DECLARE
  goal_id uuid;
  task_row public.tasks;
  first_claim public.tasks;
  second_claim public.tasks;
BEGIN
  INSERT INTO public.goals(name,created_by_agent_id,status)
  VALUES ('Fenced claim regression ' || replace(gen_random_uuid()::text,'-',''),
          'fenced-claim-test','ready')
  RETURNING id INTO goal_id;

  SELECT * INTO task_row FROM public.task_ledger_register(
    'fenced-claim-test','Fenced Claim Test','Lease fencing regression',
    'Disposable task',ARRAY['fenced-claim-test']::text[],
    'fenced-claim-session','worker',3::smallint,
    'Verify fenced task recovery','{}'::jsonb,NULL
  );

  UPDATE public.tasks
  SET goal_id=goal_id,
      target=(SELECT target FROM public.goals WHERE id=goal_id),
      required_capabilities=ARRAY['fenced-claim-test']::text[],
      task_role='loop_authoring'
  WHERE id=task_row.id;

  SELECT * INTO first_claim
  FROM public.task_ledger_claim_next(
    'fenced-claim-original','Original Worker','worker',
    ARRAY['fenced-claim-test']::text[],120
  );

  IF first_claim.id IS DISTINCT FROM task_row.id THEN
    RAISE EXCEPTION 'fixture task was not claimed';
  END IF;

  -- Stale heartbeat alone must not permit takeover while the lease is valid.
  UPDATE public.tasks
  SET heartbeat_at=now()-interval '6 minutes'
  WHERE id=first_claim.id;

  SELECT * INTO second_claim
  FROM public.task_ledger_claim_next(
    'fenced-claim-preexpiry','Pre-expiry Worker','worker',
    ARRAY['fenced-claim-test']::text[],120
  );

  IF second_claim.id IS NOT NULL THEN
    RAISE EXCEPTION 'stale heartbeat stole an unexpired lease';
  END IF;

  -- Generic SQL cannot replace or shorten a live claim through service_role.
  SET LOCAL ROLE service_role;

  BEGIN
    UPDATE public.tasks
    SET claimed_by_agent_id='fenced-intruder', claim_token=gen_random_uuid()
    WHERE id=first_claim.id;
    RAISE EXCEPTION 'pre-expiry owner replacement unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE public.tasks
    SET claim_expires_at=now()-interval '1 minute'
    WHERE id=first_claim.id;
    RAISE EXCEPTION 'pre-expiry lease shortening unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  RESET ROLE;

  -- Expire the lease while retaining a stale heartbeat and recover atomically.
  UPDATE public.tasks
  SET claim_expires_at=now()-interval '1 second',
      heartbeat_at=now()-interval '6 minutes'
  WHERE id=first_claim.id;

  SELECT * INTO second_claim
  FROM public.task_ledger_claim_next(
    'fenced-claim-recovery','Recovery Worker','worker',
    ARRAY['fenced-claim-test']::text[],120
  );

  IF second_claim.id IS DISTINCT FROM first_claim.id
     OR second_claim.claim_token IS NULL
     OR second_claim.claim_token IS NOT DISTINCT FROM first_claim.claim_token
     OR second_claim.claimed_by_agent_id<>'fenced-claim-recovery' THEN
    RAISE EXCEPTION 'expired+stale recovery did not rotate ownership/token';
  END IF;
END;
$fixture$;

ROLLBACK;
