-- ATAX fenced task-claim recovery hardening.
-- Recovery requires an expired lease, a non-null fencing token, and five minutes
-- of stale heartbeat. Existing claim ordering and task contracts are preserved.
--
-- This migration rewrites the currently deployed claim functions from their
-- exact live definitions, changing only the recovery predicate and publishes
-- an active-lease ownership guard. Historical task rows are untouched.

DO $migration$
DECLARE
  fn record;
  definition text;
  old_predicate text :=
    'coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''2 minutes'' and coalesce(t.claim_expires_at,''-infinity''::timestamptz)<=statement_timestamp() and coalesce(t.claim_expires_at,''-infinity''::timestamptz)<=statement_timestamp()';
  new_predicate text :=
    't.claim_expires_at is not null and t.claim_expires_at<=now() and t.claim_token is not null and coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''5 minutes''';
BEGIN
  FOR fn IN
    SELECT p.oid, p.oid::regprocedure::text AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN (
        'task_ledger_claim_next',
        'task_ledger_claim_goal_next',
        'goal_ledger_claim_task'
      )
  LOOP
    SELECT pg_get_functiondef(fn.oid) INTO definition;
    IF position(old_predicate IN definition)=0 THEN
      RAISE EXCEPTION 'Expected two-minute recovery predicate not found in %', fn.signature;
    END IF;
    definition := replace(definition, old_predicate, new_predicate);
    EXECUTE definition;
  END LOOP;
END
$migration$;

-- Generic SQL must not steal or shorten an active task claim. Privileged
-- PostgreSQL recovery remains the explicit audited exception boundary.
CREATE OR REPLACE FUNCTION public.atax_enforce_active_task_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $lease$
BEGIN
  IF current_user='postgres' THEN
    RETURN NEW;
  END IF;

  IF OLD.status='running' AND NEW.status='running' THEN
    IF OLD.claim_expires_at IS NOT NULL
       AND OLD.claim_expires_at>clock_timestamp()
       AND (NEW.claim_expires_at IS NULL OR NEW.claim_expires_at<OLD.claim_expires_at) THEN
      RAISE EXCEPTION 'active task lease cannot be shortened' USING ERRCODE='55000';
    END IF;

    IF NEW.claimed_by_agent_id IS DISTINCT FROM OLD.claimed_by_agent_id
       OR NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
      IF OLD.claim_expires_at IS NULL
         OR OLD.claim_expires_at>clock_timestamp()
         OR OLD.claim_token IS NULL
         OR coalesce(OLD.heartbeat_at,'-infinity'::timestamptz)>clock_timestamp()-interval '5 minutes' THEN
        RAISE EXCEPTION
          'active task claim cannot be replaced before expired lease and stale heartbeat'
          USING ERRCODE='55000';
      END IF;

      IF NEW.claimed_by_agent_id IS NULL
         OR NEW.claim_token IS NULL
         OR NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token THEN
        RAISE EXCEPTION
          'task takeover requires a new owner and a rotated fencing token'
          USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$lease$;

DROP TRIGGER IF EXISTS tasks_enforce_active_lease_on_update ON public.tasks;
CREATE TRIGGER tasks_enforce_active_lease_on_update
BEFORE UPDATE OF status,claimed_by_agent_id,claim_token,claim_expires_at
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.atax_enforce_active_task_lease();

REVOKE ALL ON FUNCTION public.atax_enforce_active_task_lease()
FROM PUBLIC, anon, authenticated;

-- Keep the published policy consistent with the executable recovery contract.
CREATE OR REPLACE FUNCTION public.task_ledger_heartbeat_policy()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $policy$
  SELECT jsonb_build_object(
    'heartbeat_interval_seconds',60,
    'ownership_check_interval_seconds',60,
    'stale_heartbeat_timeout_seconds',300,
    'recovery_threshold_minutes',5,
    'lease_expiry_is_recovery_gate',true,
    'recovery_requires_both_lease_expiry_and_stale_heartbeat',true,
    'fencing_token','claim_token',
    'checkpoint_required',true
  );
$policy$;
