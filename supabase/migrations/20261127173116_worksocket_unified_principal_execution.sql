-- Unified-principal WorkSocket execution.
-- The same authenticated ATAX caller may orchestrate, author loops, execute,
-- atomise descendants, submit evidence and verify. Actor IDs remain audit data;
-- they are not an author/worker/verifier separation policy.
--
-- Authorization continues to use authenticated MCP scope, goal ownership where
-- applicable, task eligibility, live lease, claim/verification fences, invocation
-- secrets, capability grants, bounded context/budgets and evidence predicates.
-- This migration is deliberately a fail-closed patch over known canonical
-- function bodies: unexpected drift aborts the migration instead of weakening
-- an unreviewed implementation.

DO $migration$
DECLARE
  patch record;
  source_definition text;
  patched_definition text;
  matches integer;
BEGIN
  FOR patch IN
    SELECT signature::regprocedure AS signature, old_fragment, new_fragment
    FROM (VALUES
      (
        to_regprocedure('public.goal_ledger_claim_task(text,text,text,text,text[],text,integer)'),
        $old$if agent_id_in=creator_id then raise exception 'worker agent_id must differ from the orchestrator agent_id'; end if;$old$,
        $new$-- Creator and executor may be the same authenticated ATAX caller.$new$
      ),
      (
        to_regprocedure('public.atax_goal_claim_safe(text,text,text,text,text[],text,integer)'),
        $old$or (t.task_role='execution' and (t.loop_script_status <> 'ready'
          or t.loop_author_agent_id=agent_id_in))$old$,
        $new$or (t.task_role='execution' and t.loop_script_status <> 'ready')$new$
      ),
      (
        to_regprocedure('public.atax_goal_claim_safe(text,text,text,text,text[],text,integer)'),
        $old$goal task requires independent loop authoring or a different executor$old$,
        $new$goal task requires a valid ready loop contract before execution$new$
      ),
      (
        to_regprocedure('public.task_ledger_claim_next(text,text,text,text[],integer)'),
        $old$and (t.task_role='loop_authoring' or (t.task_role='execution' and t.loop_script_status='ready' and (t.loop_author_agent_id is null or t.loop_author_agent_id<>agent_id_in)))$old$,
        $new$and (t.task_role='loop_authoring' or (t.task_role='execution' and t.loop_script_status='ready'))$new$
      ),
      (
        to_regprocedure('public.task_ledger_claim_next(text,text,text,text[],integer)'),
        $old$Loop-contract authoring claimed; executor must be a different agent.$old$,
        $new$Loop-contract authoring claimed; any eligible caller may execute after contract readiness.$new$
      ),
      (
        to_regprocedure('public.task_ledger_finalize_loop_script(uuid,text,uuid,jsonb,jsonb,jsonb,jsonb)'),
        $old$A different agent must execute the task.$old$,
        $new$Any eligible caller may execute the task.$new$
      ),
      (
        to_regprocedure('public.task_ledger_finalize_loop_script(uuid,text,uuid,jsonb,jsonb,jsonb,jsonb)'),
        $old$Loop contract ready; awaiting independent executor$old$,
        $new$Loop contract ready; awaiting eligible executor$new$
      ),
      (
        to_regprocedure('public.task_ledger_finalize_loop_script(uuid,text,uuid,jsonb,jsonb,jsonb,jsonb)'),
        $old$'executor_must_differ_from_author',true$old$,
        $new$'executor_must_differ_from_author',false$new$
      ),
      (
        to_regprocedure('public.task_ledger_claim_verification(text,integer)'),
        $old$ and t.claimed_by_agent_id is distinct from verifier_agent_id_in$old$,
        $new$$new$
      ),
      (
        to_regprocedure('public.task_ledger_claim_verification_for_task(uuid,text,integer)'),
        $old$AND t.claimed_by_agent_id IS DISTINCT FROM verifier_agent_id_in$old$,
        $new$$new$
      ),
      (
        to_regprocedure('public.task_ledger_verify_result(uuid,text,boolean,jsonb)'),
        $old$if exists(select 1 from public.tasks t where t.id=task_id_in
    and t.claimed_by_agent_id=verifier_agent_id_in) then
    raise exception 'worker cannot verify its own submitted result';
  end if;$old$,
        $new$-- Verification acceptance is evidence/predicate-based, not identity-separated.$new$
      ),
      (
        to_regprocedure('public.socket_record_usage(uuid,uuid,uuid,uuid,uuid,text,bigint,text,jsonb)'),
        $old$ARRAY['worker','executor']$old$,
        $new$ARRAY['worker','executor','atomizer','verifier']$new$
      ),
      (
        to_regprocedure('public.socket_stop_for_atomization(uuid,uuid,uuid,uuid,text,jsonb)'),
        $old$ARRAY['worker','executor']$old$,
        $new$ARRAY['worker','executor','atomizer','verifier']$new$
      ),
      (
        to_regprocedure('public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'),
        $old$ARRAY['worker','atomizer']$old$,
        $new$ARRAY['worker','atomizer','executor','verifier']$new$
      ),
      (
        to_regprocedure('public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'),
        $old$    IF NOT EXISTS(SELECT 1 FROM public.socket_overflow_reports o
       JOIN public.socket_invocations source_inv ON source_inv.id=o.reported_by
       WHERE o.task_id=parent_in AND o.claim_token=fence_in
       AND (v_inv.role='atomizer' OR source_inv.id=v_inv.id))
       OR v_parent.claim_token IS NOT NULL THEN$old$,
        $new$    IF NOT EXISTS(SELECT 1 FROM public.socket_overflow_reports o
       WHERE o.task_id=parent_in AND o.claim_token=fence_in)
       OR v_parent.claim_token IS NOT NULL THEN$new$
      ),
      (
        to_regprocedure('public.socket_claim_child(uuid,uuid,uuid,integer)'),
        $old$ARRAY['executor','worker']$old$,
        $new$ARRAY['worker','atomizer','executor','verifier']$new$
      ),
      (
        to_regprocedure('public.socket_claim_child(uuid,uuid,uuid,integer)'),
        $old$  IF v_inv.agent_id=v_atom.authored_by_agent
     OR v_inv.id=v_atom.authored_by_invocation
     OR v_inv.session_id=v_atom.authored_in_session THEN
    RAISE EXCEPTION 'Atomiser identity/session cannot execute its child';
  END IF;
$old$,
        $new$  -- The atomiser may also execute descendants; live child fencing and
  -- child-grant checks below remain mandatory.
$new$
      ),
      (
        to_regprocedure('public.socket_claim_child_verification(uuid,uuid,uuid,integer)'),
        $old$ARRAY['verifier']$old$,
        $new$ARRAY['worker','atomizer','executor','verifier']$new$
      ),
      (
        to_regprocedure('public.socket_claim_child_verification(uuid,uuid,uuid,integer)'),
        $old$  IF v_inv.agent_id IN (v_atom.authored_by_agent,v_child.claimed_by_agent_id)
     OR v_inv.id=v_atom.authored_by_invocation
     OR v_inv.session_id=v_atom.authored_in_session
     OR v_inv.session_id=v_child.claimed_session_id THEN
    RAISE EXCEPTION 'Verifier must be independent of atomiser and executor';
  END IF;
$old$,
        $new$  -- The execution actor may also request the evidence-verification stage.
$new$
      ),
      (
        to_regprocedure('public.socket_verify_child(uuid,uuid,uuid,uuid,boolean,jsonb)'),
        $old$ARRAY['verifier']$old$,
        $new$ARRAY['worker','atomizer','executor','verifier']$new$
      ),
      (
        to_regprocedure('public.socket_verify_child(uuid,uuid,uuid,uuid,boolean,jsonb)'),
        $old$Independent verification needs nonempty evidence$old$,
        $new$Verification requires nonempty evidence$new$
      ),
      (
        to_regprocedure('public.socket_finalize_parent(uuid,uuid,uuid,jsonb)'),
        $old$ARRAY['verifier']$old$,
        $new$ARRAY['worker','atomizer','executor','verifier']$new$
      ),
      (
        to_regprocedure('public.socket_finalize_parent(uuid,uuid,uuid,jsonb)'),
        $old$  IF v_inv.agent_id=v_atom.authored_by_agent OR v_inv.id=v_atom.authored_by_invocation
    OR v_inv.session_id=v_atom.authored_in_session
    OR EXISTS(SELECT 1 FROM public.socket_child_claim_grants g
       JOIN public.socket_invocations executor ON executor.id=g.invocation_id
       WHERE g.child_task_id=parent_in AND executor.agent_id=v_inv.agent_id)
    OR EXISTS(SELECT 1 FROM public.socket_overflow_reports o
       JOIN public.socket_invocations origin ON origin.id=o.reported_by
       WHERE o.task_id=parent_in AND origin.agent_id=v_inv.agent_id)
    OR EXISTS(SELECT 1 FROM public.socket_atomization_children c
       JOIN public.tasks child ON child.id=c.child_task_id
       WHERE c.parent_task_id=parent_in AND child.claimed_by_agent_id=v_inv.agent_id) THEN
    RAISE EXCEPTION 'Atomiser or preceding executor may not independently finalize the parent';
  END IF;
$old$,
        $new$  -- The finalizer may be the same caller; every child must still be
  -- completed and evidence-verified below.
$new$
      ),
      (
        to_regprocedure('public.atax_socket_execute_v1(jsonb)'),
        $old$AND session_id=v_session AND role IN ('worker','executor')$old$,
        $new$AND session_id=v_session AND role IN ('worker','atomizer','executor','verifier')$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$IF NOT FOUND OR v_inv.agent_id=v_atom.authored_by_agent
          OR v_inv.session_id=v_atom.authored_in_session THEN$old$,
        $new$IF NOT FOUND THEN$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$IF NOT FOUND OR v_inv.agent_id=v_atom.authored_by_agent
         OR v_inv.agent_id=NEW.claimed_by_agent_id THEN$old$,
        $new$IF NOT FOUND THEN$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$IF NOT FOUND OR v_inv.agent_id=v_atom.authored_by_agent
         OR v_inv.agent_id=NEW.claimed_by_agent_id
         OR EXISTS(SELECT 1 FROM public.socket_child_claim_grants g
            JOIN public.socket_invocations executor ON executor.id=g.invocation_id
            WHERE g.child_task_id=NEW.id AND executor.agent_id=v_inv.agent_id) THEN$old$,
        $new$IF NOT FOUND THEN$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$IF NOT FOUND OR v_inv.agent_id=v_atom.authored_by_agent THEN$old$,
        $new$IF NOT FOUND THEN$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$Child verification may not reuse atomiser/executor identity$old$,
        $new$Child verification requires an approved evidence grant$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$Parent completion needs independent authenticated finalizer$old$,
        $new$Parent completion requires an authenticated finalization grant$new$
      )
    ) AS changes(signature,old_fragment,new_fragment)
  LOOP
    IF patch.signature IS NULL THEN
      RAISE EXCEPTION 'WorkSocket unified-principal migration: required function is missing';
    END IF;
    SELECT pg_get_functiondef(patch.signature) INTO source_definition;
    IF source_definition IS NULL THEN
      RAISE EXCEPTION 'WorkSocket unified-principal migration: function definition unavailable for %',patch.signature;
    END IF;
    matches := (length(source_definition) -
      length(replace(source_definition,patch.old_fragment,''))) /
      greatest(length(patch.old_fragment),1);
    IF matches <> 1 THEN
      RAISE EXCEPTION 'WorkSocket unified-principal migration drift: expected one match in %, found %',patch.signature,matches;
    END IF;
    patched_definition := replace(source_definition,patch.old_fragment,patch.new_fragment);
    EXECUTE patched_definition;
  END LOOP;
END
$migration$;

COMMENT ON FUNCTION public.task_ledger_claim_next(text,text,text,text[],integer) IS
'Atomic task claim. Authenticated caller identity is audit attribution only; loop author and executor may be the same caller. Eligibility, capabilities, dependencies, lease and fencing remain enforced.';

COMMENT ON FUNCTION public.task_ledger_verify_result(uuid,text,boolean,jsonb) IS
'Task verification accepts or rejects only under the existing workspace scope and evidence/predicate gates. Verifier identity need not differ from executor identity.';
