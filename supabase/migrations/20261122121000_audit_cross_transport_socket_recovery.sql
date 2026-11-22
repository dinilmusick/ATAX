-- Every canonical replacement of a live socket must preserve its prior
-- claim token/holder for safe, non-mutating handoff, regardless of which
-- GitHub, direct Supabase, or MCP claim entrypoint performed the takeover.
-- No resident agent, scheduler, background poller, or model identity is used.
CREATE OR REPLACE FUNCTION public.audit_task_socket_recovery_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $audit$
BEGIN
  IF OLD.status='running' AND NEW.status='running'
     AND OLD.claim_token IS NOT NULL AND NEW.claim_token IS NOT NULL
     AND OLD.claim_token IS DISTINCT FROM NEW.claim_token THEN
    -- Some legacy claim RPCs already append recovery events before updating.
    -- Do not duplicate their records.
    IF NOT EXISTS (
      SELECT 1 FROM public.task_events e
      WHERE e.task_id=NEW.id AND e.event_type='lease_recovered'
        AND e.payload->>'previous_claim_token'=OLD.claim_token::text
        AND e.payload->>'previous_agent_id' IS NOT DISTINCT FROM OLD.claimed_by_agent_id
    ) THEN
      INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
      VALUES(
        NEW.id,'lease_recovered',NEW.claimed_by_agent_id,
        'Task socket reassigned after prior lease expiry; previous holder may append a fenced-out handoff note.',
        jsonb_build_object(
          'previous_agent_id',OLD.claimed_by_agent_id,
          'previous_claim_token',OLD.claim_token,
          'previous_heartbeat_at',OLD.heartbeat_at,
          'previous_heartbeat_context',coalesce(OLD.heartbeat_context,'{}'::jsonb),
          'previous_claim_expires_at',OLD.claim_expires_at,
          'new_claim_token',NEW.claim_token,
          'recovery_reason','lease_expiry',
          'handoff_allowed',true
        )
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$audit$;

DROP TRIGGER IF EXISTS tasks_audit_cross_transport_socket_recovery ON public.tasks;
CREATE TRIGGER tasks_audit_cross_transport_socket_recovery
AFTER UPDATE OF claim_token ON public.tasks
FOR EACH ROW
WHEN (OLD.claim_token IS DISTINCT FROM NEW.claim_token)
EXECUTE FUNCTION public.audit_task_socket_recovery_event();
