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
        $old$and t.claimed_by_agent_id is distinct from verifier_agent_id_in $old$,
        $new$$new$
      ),
      (
        to_regprocedure('public.task_ledger_claim_verification_for_task(uuid,text,integer)'),
        $old$AND t.claimed_by_agent_id IS DISTINCT FROM verifier_agent_id_in$new$,
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
        to_regprocedure('public.task_ledger_claim_verification_for_task(uuid,text,integer)'),
        $old$Task ID and independent verifier identity are required$old$,
        $new$Task ID and verification caller identity are required$new$
      ),
      (
        to_regprocedure('public.task_ledger_verify_result(uuid,text,boolean,jsonb)'),
        $old$declare task_out public.tasks;$old$,
        $new$declare task_out public.tasks; task_in public.tasks; latest_iteration public.task_iterations;$new$
      ),
      (
        to_regprocedure('public.task_ledger_verify_result(uuid,text,boolean,jsonb)'),
        $old$  ) then raise exception 'independent verifier is not authorized for this workspace'; end if;$old$,
        $new$  ) then raise exception 'verification caller is not authorized for this workspace'; end if;
  IF verified_in THEN
    IF jsonb_typeof(verification_report_in) IS DISTINCT FROM 'object'
       OR jsonb_typeof(verification_report_in->'evidence') IS DISTINCT FROM 'array'
       OR jsonb_array_length(coalesce(verification_report_in->'evidence','[]'::jsonb))=0 THEN
      RAISE EXCEPTION 'verified result requires nonempty verification evidence';
    END IF;
    SELECT * INTO task_in FROM public.tasks WHERE id=task_id_in FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'task not found'; END IF;
    IF jsonb_typeof(task_in.evidence) IS DISTINCT FROM 'array'
       OR jsonb_array_length(task_in.evidence)=0 THEN
      RAISE EXCEPTION 'verified result requires persisted task evidence';
    END IF;
    IF task_in.loop_definition->>'enabled'='true' THEN
      SELECT * INTO latest_iteration FROM public.task_iterations
      WHERE task_id=task_id_in ORDER BY iteration_no DESC LIMIT 1;
      IF latest_iteration.id IS NULL
         OR coalesce(latest_iteration.decision,'') NOT LIKE 'pass%'
         OR jsonb_typeof(latest_iteration.evidence) IS DISTINCT FROM 'array'
         OR jsonb_array_length(latest_iteration.evidence)=0
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(
             coalesce(latest_iteration.observation->'criterionResults','[]'::jsonb)
           ) criterion WHERE criterion->>'status' IS DISTINCT FROM 'satisfied'
         ) THEN
        RAISE EXCEPTION 'verified result requires a passing loop iteration with evidence and satisfied criteria';
      END IF;
    END IF;
    IF task_in.execution_model='bounded-v2' THEN
      IF jsonb_typeof(task_in.checkpoints) IS DISTINCT FROM 'array'
         OR jsonb_array_length(task_in.checkpoints)=0 THEN
        RAISE EXCEPTION 'bounded-v2 verification requires completed checkpoints';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(task_in.checkpoints) WITH ORDINALITY checkpoint(value,ordinality)
        LEFT JOIN public.predicate_executions predicate
          ON predicate.id=nullif(checkpoint.value->>'predicate_execution_id','')::uuid
         AND predicate.task_id=task_id_in
         AND predicate.checkpoint_index=(checkpoint.ordinality-1)::smallint
        WHERE checkpoint.value->>'status' IS DISTINCT FROM 'succeeded'
           OR predicate.id IS NULL
           OR predicate.passed IS DISTINCT FROM true
           OR predicate.predicate_key IS DISTINCT FROM checkpoint.value->>'predicate_key'
           OR predicate.predicate_version IS DISTINCT FROM
                (checkpoint.value->>'predicate_version')::integer
           OR jsonb_typeof(predicate.evidence) IS DISTINCT FROM 'array'
           OR jsonb_array_length(predicate.evidence)=0
           OR jsonb_typeof(checkpoint.value->'evidence') IS DISTINCT FROM 'array'
           OR jsonb_array_length(checkpoint.value->'evidence')=0
      ) THEN
        RAISE EXCEPTION 'bounded-v2 verification requires passing evidence for every registered checkpoint predicate';
      END IF;
    END IF;
  END IF;$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old$declare t public.tasks; c jsonb; expected_key text; expected_version integer;$old$,
        $new$declare t public.tasks; v_pred public.completion_predicates%rowtype;
  c jsonb; expected_key text; expected_version integer;
  updated_checkpoints jsonb; run_id uuid; v_result jsonb; v_computed_pass boolean;$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old$  if not exists (
    select 1 from public.completion_predicates
    where predicate_key=predicate_key_in and version=predicate_version_in
  ) then raise exception 'predicate is not registered'; end if;

  if passed_in is true and coalesce(jsonb_typeof(evidence_in),'null') <> 'array' then
    raise exception 'successful predicate execution requires evidence array'; end if;$old$,
        $new$  SELECT * INTO v_pred FROM public.completion_predicates
  WHERE predicate_key=predicate_key_in AND version=predicate_version_in FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'predicate is not registered'; END IF;
  IF v_pred.predicate_type<>'builtin' THEN
    RAISE EXCEPTION 'no trusted evaluator is registered for predicate type %',v_pred.predicate_type;
  END IF;
  IF jsonb_typeof(coalesce(inputs_in,'{}'::jsonb)) IS DISTINCT FROM 'object'
     OR jsonb_typeof(coalesce(evidence_in,'[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'predicate inputs/evidence have invalid JSON types';
  END IF;
  CASE v_pred.definition->>'operation'
    WHEN 'evidence_present' THEN
      v_result:=to_jsonb(
        jsonb_typeof(inputs_in->'evidence')='array'
        AND jsonb_array_length(coalesce(inputs_in->'evidence','[]'::jsonb))>0
        AND jsonb_array_length(coalesce(evidence_in,'[]'::jsonb))>0
      );
    WHEN 'legacy_checkpoint_success' THEN
      v_result:=to_jsonb(
        result_in IS NOT DISTINCT FROM v_pred.expected_result
        AND jsonb_array_length(coalesce(evidence_in,'[]'::jsonb))>0
      );
    ELSE
      RAISE EXCEPTION 'unsupported builtin predicate operation %',v_pred.definition->>'operation';
  END CASE;
  v_computed_pass:=v_result IS NOT DISTINCT FROM v_pred.expected_result;
  IF passed_in IS DISTINCT FROM v_computed_pass THEN
    RAISE EXCEPTION 'caller predicate verdict differs from the registered server evaluation';
  END IF;$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old$coalesce(inputs_in,'{}'::jsonb),result_in,passed_in,coalesce(evidence_in,'[]'::jsonb),$old$,
        $new$coalesce(inputs_in,'{}'::jsonb),v_result,v_computed_pass,coalesce(evidence_in,'[]'::jsonb),$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old$if passed_in then$old$,
        $new$if v_computed_pass then$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old
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
        to_regprocedure('public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'),
        $old$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in
       OR v_old.authored_by_invocation<>invocation_in THEN$old$,
        $new$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in THEN$new$
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
        $old$Independent verification needs nonempty evidence$new$,
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
        $old$Child verification may not reuse atomiser/executor identity$new$,
        $new$Child verification requires an approved evidence grant$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$Parent completion needs independent authenticated finalizer$new$,
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

result',result_in,$old$,
        $new
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
        to_regprocedure('public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'),
        $old$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in
       OR v_old.authored_by_invocation<>invocation_in THEN$old$,
        $new$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in THEN$new$
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
        $old$Independent verification needs nonempty evidence$new$,
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
        $old$Child verification may not reuse atomiser/executor identity$new$,
        $new$Child verification requires an approved evidence grant$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$Parent completion needs independent authenticated finalizer$new$,
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

result',v_result,$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old
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
        to_regprocedure('public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'),
        $old$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in
       OR v_old.authored_by_invocation<>invocation_in THEN$old$,
        $new$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in THEN$new$
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
        $old$Independent verification needs nonempty evidence$new$,
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
        $old$Child verification may not reuse atomiser/executor identity$new$,
        $new$Child verification requires an approved evidence grant$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$Parent completion needs independent authenticated finalizer$new$,
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

passed',passed_in$old$,
        $new
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
        to_regprocedure('public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'),
        $old$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in
       OR v_old.authored_by_invocation<>invocation_in THEN$old$,
        $new$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in THEN$new$
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
        $old$Independent verification needs nonempty evidence$new$,
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
        $old$Child verification may not reuse atomiser/executor identity$new$,
        $new$Child verification requires an approved evidence grant$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$Parent completion needs independent authenticated finalizer$new$,
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

passed',v_computed_pass$new$
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
        to_regprocedure('public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)'),
        $old$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in
       OR v_old.authored_by_invocation<>invocation_in THEN$old$,
        $new$IF v_old.split_key<>split_key_in OR v_old.definition<>children_in THEN$new$
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
        $old$Independent verification needs nonempty evidence$new$,
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
        $old$Child verification may not reuse atomiser/executor identity$new$,
        $new$Child verification requires an approved evidence grant$new$
      ),
      (
        to_regprocedure('public.socket_guard_task_transition()'),
        $old$Parent completion needs independent authenticated finalizer$new$,
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

