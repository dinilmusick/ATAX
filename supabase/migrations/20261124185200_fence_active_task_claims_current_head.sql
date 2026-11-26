-- ATAX fenced task-claim recovery hardening.
DO $migration$
DECLARE
  fn record;
  definition text;
  old_heartbeat_predicate text := 'coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''2 minutes''';
  new_recovery_predicate text := 't.claim_expires_at is not null and t.claim_expires_at<=now() and t.claim_token is not null and coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''5 minutes''';
BEGIN
  FOR fn IN
    SELECT p.oid, p.oid::regprocedure::text AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('task_ledger_claim_next','task_ledger_claim_goal_next','goal_ledger_claim_task')
  LOOP
    SELECT pg_get_functiondef(fn.oid) INTO definition;
    IF position(old_heartbeat_predicate IN definition)=0 THEN
      RAISE EXCEPTION 'Expected two-minute heartbeat predicate not found in %', fn.signature;
    END IF;
    definition := replace(definition, old_heartbeat_predicate, new_recovery_predicate);
    definition := replace(definition,'after at least 2 minutes without a heartbeat','after at least 5 minutes without a heartbeat');
    definition := replace(definition,'''recovery_threshold_minutes'',2','''recovery_threshold_minutes'',5');
    EXECUTE definition;
  END LOOP;
END
$migration$;

CREATE OR REPLACE FUNCTION public.atax_enforce_active_task_lease()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $lease$
BEGIN
  IF current_user='postgres' THEN RETURN NEW; END IF;
  IF OLD.status='running' AND NEW.status='running' THEN
    IF OLD.claim_expires_at IS NOT NULL AND OLD.claim_expires_at>clock_timestamp()
       AND (NEW.claim_expires_at IS NULL OR NEW.claim_expires_at<OLD.claim_expires_at) THEN
      RAISE EXCEPTION 'active task lease cannot be shortened' USING ERRCODE='55000';
    END IF;
    IF NEW.claimed_by_agent_id IS DISTINCT FROM OLD.claimed_by_agent_id OR NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
      IF OLD.claim_expires_at IS NULL OR OLD.claim_expires_at>clock_timestamp() OR OLD.claim_token IS NULL
         OR coalesce(OLD.heartbeat_at,'-infinity'::timestamptz)>clock_timestamp()-interval '5 minutes' THEN
        RAISE EXCEPTION 'active task claim cannot be replaced before expired lease and stale heartbeat' USING ERRCODE='55000';
      END IF;
      IF NEW.claimed_by_agent_id IS NULL OR NEW.claim_token IS NULL OR NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token THEN
        RAISE EXCEPTION 'task takeover requires a new owner and a rotated fencing token' USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$lease$;

DROP TRIGGER IF EXISTS tasks_enforce_active_lease_on_update ON public.tasks;
CREATE TRIGGER tasks_enforce_active_lease_on_update
BEFORE UPDATE OF status,claimed_by_agent_id,claim_token,claim_expires_at
ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.atax_enforce_active_task_lease();
REVOKE ALL ON FUNCTION public.atax_enforce_active_task_lease() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.task_ledger_heartbeat_policy()
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public'
AS $policy$
SELECT jsonb_build_object('heartbeat_interval_seconds',60,'ownership_check_interval_seconds',60,'stale_heartbeat_timeout_seconds',300,'recovery_threshold_minutes',5,'lease_expiry_is_recovery_gate',true,'recovery_requires_both_lease_expiry_and_stale_heartbeat',true,'fencing_token','claim_token','checkpoint_required',true);
$policy$;