-- Preserve durable recovery evidence even when a claim RPC variant does not emit it itself.
-- The trigger is idempotent with claim-RPC recovery events: it detects the prior
-- claim token/owner and inserts only when the RPC has not already done so.

CREATE OR REPLACE FUNCTION public.atax_record_fenced_task_recovery()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $recovery$
BEGIN
  IF OLD.status='running'
     AND NEW.status='running'
     AND OLD.claimed_by_agent_id IS NOT NULL
     AND OLD.claim_token IS NOT NULL
     AND NEW.claimed_by_agent_id IS DISTINCT FROM OLD.claimed_by_agent_id
     AND NEW.claim_token IS DISTINCT FROM OLD.claim_token
     AND OLD.claim_expires_at IS NOT NULL
     AND OLD.claim_expires_at<=clock_timestamp()
     AND coalesce(OLD.heartbeat_at,'-infinity'::timestamptz)<=clock_timestamp()-interval '5 minutes'
     AND NEW.claimed_by_agent_id IS NOT NULL
     AND NEW.claim_token IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.task_events e
       WHERE e.task_id=OLD.id
         AND e.event_type='lease_recovered'
         AND e.payload->>'previous_agent_id'=OLD.claimed_by_agent_id
         AND e.payload->>'previous_claim_token'=OLD.claim_token::text
     )
  THEN
    INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
    VALUES (
      OLD.id,
      'lease_recovered',
      NEW.claimed_by_agent_id,
      'Task reclaimed after expired lease and at least 5 minutes without a heartbeat.',
      jsonb_build_object(
        'previous_agent_id',OLD.claimed_by_agent_id,
        'previous_claim_token',OLD.claim_token,
        'previous_heartbeat_at',OLD.heartbeat_at,
        'recovery_reason','heartbeat_timeout',
        'recovery_threshold_minutes',5,
        'evidence_source','atax_record_fenced_task_recovery'
      )
    );
  END IF;
  RETURN NEW;
END;
$recovery$;

DROP TRIGGER IF EXISTS tasks_record_fenced_recovery_evidence ON public.tasks;
CREATE TRIGGER tasks_record_fenced_recovery_evidence
BEFORE UPDATE OF claimed_by_agent_id,claim_token,claim_expires_at,status
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.atax_record_fenced_task_recovery();

REVOKE ALL ON FUNCTION public.atax_record_fenced_task_recovery() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.atax_record_fenced_task_recovery() IS
'Durably records prior owner/token evidence for fenced task recovery; idempotent with claim-RPC recovery events.';
