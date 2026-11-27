-- Keep the MCP principal/session binding coherent when tasks are claimed
-- through the global task ledger rather than the goal-scoped socket claim path.
-- The same authenticated principal is used for both fields; this is not a
-- second worker identity. Release/submit clear the claim's session binding.
DO $migration$
DECLARE
  patch record;
  source_definition text;
  patched_definition text;
  matches integer;
BEGIN
  FOR patch IN
    SELECT signature,old_fragment,new_fragment
    FROM (VALUES
      (
        to_regprocedure('public.task_ledger_claim_next(text,text,text,text[],integer)'),
        $old$set status='running',claimed_by_agent_id=agent_id_in,claimed_by_agent_name=agent_name_in,claim_token=gen_random_uuid()$old$,
        $new$set status='running',claimed_by_agent_id=agent_id_in,claimed_by_agent_name=agent_name_in,claimed_session_id=agent_id_in,claim_token=gen_random_uuid()$new$
      ),
      (
        to_regprocedure('public.task_ledger_claim_next(text,text,text,text[],integer)'),
        $old$Author and validate loop contract; do not execute task.$old$,
        $new$Author and validate the loop contract; after it is ready, any eligible caller may execute.$new$
      ),
      (
        to_regprocedure('public.task_ledger_release_claim(uuid,text,uuid,text,text)'),
        $old$status=release_status_in, claimed_by_agent_id=null, claimed_by_agent_name=null,
      claim_token=null$old$,
        $new$status=release_status_in, claimed_by_agent_id=null, claimed_by_agent_name=null,
      claimed_session_id=null, claim_token=null$new$
      ),
      (
        to_regprocedure('public.task_ledger_submit_result(uuid,text,uuid,jsonb,text,jsonb,jsonb,text)'),
        $old$claim_expires_at=NULL,claim_token=NULL$old$,
        $new$claimed_session_id=NULL,claim_expires_at=NULL,claim_token=NULL$new$
      )
    ) AS changes(signature,old_fragment,new_fragment)
  LOOP
    IF patch.signature IS NULL THEN
      RAISE EXCEPTION 'WorkSocket MCP session migration: required function is missing';
    END IF;
    SELECT pg_get_functiondef(patch.signature) INTO source_definition;
    IF source_definition IS NULL THEN
      RAISE EXCEPTION 'WorkSocket MCP session migration: function definition unavailable for %',patch.signature;
    END IF;
    matches := (length(source_definition) -
      length(replace(source_definition,patch.old_fragment,''))) /
      greatest(length(patch.old_fragment),1);
    IF matches<>1 THEN
      RAISE EXCEPTION 'WorkSocket MCP session migration drift: expected one match in %, found %',patch.signature,matches;
    END IF;
    patched_definition:=replace(source_definition,patch.old_fragment,patch.new_fragment);
    EXECUTE patched_definition;
  END LOOP;
END
$migration$;

COMMENT ON FUNCTION public.task_ledger_claim_next(text,text,text,text[],integer) IS
'Atomic global task claim for authenticated ATAX callers. claimed_session_id is bound to the authenticated principal used by the MCP socket gateway; no separate worker identity is required.';
