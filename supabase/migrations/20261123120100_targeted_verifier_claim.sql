-- ATAX independent-verification preflight: target exactly one submitted task.
-- This additive RPC does not grant an approval or change global queue ordering.
-- Authoritative identity is established by the trusted service-role caller;
-- a text verifier ID alone is NOT authentication or independent-attestation evidence.
CREATE OR REPLACE FUNCTION public.task_ledger_claim_verification_for_task(
  task_id_in uuid,
  verifier_agent_id_in text,
  lease_seconds_in integer DEFAULT 900
)
RETURNS SETOF public.tasks
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  candidate_id uuid;
  claimed public.tasks;
  lease_value integer := greatest(30, least(coalesce(lease_seconds_in, 900), 86400));
BEGIN
  IF task_id_in IS NULL OR nullif(btrim(verifier_agent_id_in), '') IS NULL THEN
    RAISE EXCEPTION 'Task ID and independent verifier identity are required';
  END IF;

  -- FOR UPDATE SKIP LOCKED serializes competing claims and fails closed when
  -- another verifier currently owns the claim. Do not claim a parent task
  -- before independently reviewing its descendant work.
  SELECT t.id INTO candidate_id
  FROM public.tasks t
  WHERE t.id = task_id_in
    AND t.status = 'completed'
    AND t.verification_status = 'pending'
    AND t.result_submitted_at IS NOT NULL
    AND t.claimed_by_agent_id IS DISTINCT FROM verifier_agent_id_in
    AND (t.verification_claim_expires_at IS NULL
         OR t.verification_claim_expires_at <= statement_timestamp())
    AND NOT EXISTS (
      SELECT 1 FROM public.tasks child WHERE child.parent_task_id = t.id
    )
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF candidate_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.tasks
  SET verification_claimed_by_agent_id = verifier_agent_id_in,
      verification_claim_token = gen_random_uuid(),
      verification_claim_expires_at = statement_timestamp() + make_interval(secs => lease_value),
      updated_at = statement_timestamp()
  WHERE id = candidate_id
  RETURNING * INTO claimed;

  RETURN NEXT claimed;
END;
$function$;

-- Preserve the existing trusted-server boundary. Do not expose a verifier
-- claim or a returned fencing token to unauthenticated/public clients.
REVOKE ALL ON FUNCTION public.task_ledger_claim_verification_for_task(uuid,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.task_ledger_claim_verification_for_task(uuid,text,integer)
  TO service_role;
