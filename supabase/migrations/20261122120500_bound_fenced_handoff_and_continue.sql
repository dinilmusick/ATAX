-- Forfeited-socket handoff: preserve progress without reviving or mutating a task.
-- A claimant that loses or expires its fencing token may record exactly one
-- append-only handoff note, then explicitly look for another eligible task.
-- No resident ATAX process creates/schedules agents or chooses their next work.
CREATE OR REPLACE FUNCTION public.task_ledger_record_handoff(
  task_id_in uuid,
  previous_agent_id_in text,
  previous_claim_token_in uuid,
  handoff_note_in text,
  context_in jsonb DEFAULT '{}'::jsonb
)
RETURNS public.task_events
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  event_out public.task_events;
  task_out public.tasks;
  recognized_prior_lease boolean := false;
BEGIN
  IF NULLIF(btrim(previous_agent_id_in),'') IS NULL
     OR previous_claim_token_in IS NULL
     OR NULLIF(btrim(handoff_note_in),'') IS NULL
     OR length(handoff_note_in)>3000 THEN
    RAISE EXCEPTION 'Previous holder, fencing token and bounded handoff note are required';
  END IF;
  IF jsonb_typeof(coalesce(context_in,'{}'::jsonb))<>'object'
     OR pg_column_size(coalesce(context_in,'{}'::jsonb))>16384 THEN
    RAISE EXCEPTION 'Handoff context must be a bounded JSON object';
  END IF;

  -- Snapshot under the same row lock used by atomic claims/reclaims, to
  -- prevent a forged handoff during an ownership transition.
  SELECT * INTO task_out FROM public.tasks
  WHERE id=task_id_in FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task socket not found'; END IF;

  -- An active occupant must checkpoint normally, not forfeit its socket.
  IF public.task_ledger_check_claim(task_id_in,previous_agent_id_in,previous_claim_token_in) THEN
    RAISE EXCEPTION 'Task socket is still owned; checkpoint or release it normally';
  END IF;

  -- If the prior token is still on the expired row, the holder can record
  -- its note before a replacement has claimed the socket.
  recognized_prior_lease :=
    task_out.claimed_by_agent_id=previous_agent_id_in
    AND task_out.claim_token=previous_claim_token_in
    AND task_out.claim_expires_at<=statement_timestamp();

  -- If a replacement has already claimed it, validate the exact prior
  -- token/holder pair against the immutable recovery event. Do not trust
  -- a caller-supplied agent name, unverified token or client/application name.
  IF NOT recognized_prior_lease THEN
    SELECT EXISTS (
      SELECT 1 FROM public.task_events e
      WHERE e.task_id=task_id_in
        AND e.event_type='lease_recovered'
        AND e.payload->>'previous_agent_id'=previous_agent_id_in
        AND e.payload->>'previous_claim_token'=previous_claim_token_in::text
    ) INTO recognized_prior_lease;
  END IF;
  IF NOT recognized_prior_lease THEN
    RAISE EXCEPTION 'Unrecognized or still-owned former socket claim';
  END IF;

  -- At most one note per lost lease; retries safely return prior evidence.
  SELECT * INTO event_out FROM public.task_events e
  WHERE e.task_id=task_id_in AND e.event_type='handoff'
    AND e.agent_id=previous_agent_id_in
    AND e.payload->>'previous_claim_token'=previous_claim_token_in::text
  ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1;
  IF FOUND THEN RETURN event_out; END IF;

  INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
  VALUES(task_id_in,'handoff',previous_agent_id_in,handoff_note_in,
    jsonb_build_object(
      'previous_claim_token',previous_claim_token_in,
      'handoff_context',coalesce(context_in,'{}'::jsonb),
      'ownership_check',false,
      'reason','lease_lost',
      'next_action','Discover and atomically claim another available task socket'
    )
  ) RETURNING * INTO event_out;

  RETURN event_out;
END;
$function$;
