-- WorkSocket completion is evidence/predicate based, not actor-identity based.
-- Supported builtin predicates are evaluated in the database. Caller-supplied
-- verdicts must match the evaluator, and verified completion requires durable
-- evidence, passing loop iterations and predicate-backed checkpoints.

DO $migration$
DECLARE
  patch record;
  source_definition text;
  patched_definition text;
  matches integer;
BEGIN
  FOR patch IN
    SELECT signature, old_fragment, new_fragment
    FROM (VALUES
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
       OR jsonb_array_length(CASE
            WHEN jsonb_typeof(verification_report_in->'evidence')='array'
              THEN verification_report_in->'evidence'
            ELSE '[]'::jsonb END)=0 THEN
      RAISE EXCEPTION 'verified result requires nonempty verification evidence';
    END IF;

    SELECT * INTO task_in FROM public.tasks WHERE id=task_id_in FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'task not found'; END IF;
    IF jsonb_typeof(task_in.evidence) IS DISTINCT FROM 'array'
       OR jsonb_array_length(CASE
            WHEN jsonb_typeof(task_in.evidence)='array' THEN task_in.evidence
            ELSE '[]'::jsonb END)=0 THEN
      RAISE EXCEPTION 'verified result requires persisted task evidence';
    END IF;

    IF task_in.loop_definition->>'enabled'='true' THEN
      SELECT * INTO latest_iteration FROM public.task_iterations
      WHERE task_id=task_id_in ORDER BY iteration_no DESC LIMIT 1;
      IF latest_iteration.id IS NULL
         OR coalesce(latest_iteration.decision,'') NOT LIKE 'pass%'
         OR jsonb_array_length(CASE
              WHEN jsonb_typeof(latest_iteration.evidence)='array'
                THEN latest_iteration.evidence ELSE '[]'::jsonb END)=0
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(CASE
             WHEN jsonb_typeof(latest_iteration.observation->'criterionResults')='array'
               THEN latest_iteration.observation->'criterionResults'
             ELSE '[]'::jsonb END) criterion
           WHERE criterion->>'status' IS DISTINCT FROM 'satisfied'
         ) THEN
        RAISE EXCEPTION 'verified result requires a passing loop iteration with evidence and satisfied criteria';
      END IF;
    END IF;

    IF task_in.execution_model='bounded-v2' THEN
      IF jsonb_typeof(task_in.checkpoints) IS DISTINCT FROM 'array'
         OR jsonb_array_length(CASE
              WHEN jsonb_typeof(task_in.checkpoints)='array' THEN task_in.checkpoints
              ELSE '[]'::jsonb END)=0 THEN
        RAISE EXCEPTION 'bounded-v2 verification requires completed checkpoints';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(task_in.checkpoints)
          WITH ORDINALITY AS checkpoint(value,ordinality)
        LEFT JOIN public.predicate_executions predicate
          ON predicate.id=CASE
               WHEN checkpoint.value->>'predicate_execution_id'
                    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN (checkpoint.value->>'predicate_execution_id')::uuid
               ELSE NULL END
         AND predicate.task_id=task_id_in
         AND predicate.checkpoint_index=(checkpoint.ordinality-1)::smallint
        WHERE checkpoint.value->>'status' IS DISTINCT FROM 'succeeded'
           OR predicate.id IS NULL
           OR predicate.passed IS DISTINCT FROM true
           OR predicate.predicate_key IS DISTINCT FROM checkpoint.value->>'predicate_key'
           OR predicate.predicate_version IS DISTINCT FROM
                CASE WHEN coalesce(checkpoint.value->>'predicate_version','') ~ '^[0-9]+$'
                  THEN (checkpoint.value->>'predicate_version')::integer ELSE NULL END
           OR jsonb_array_length(CASE
                WHEN jsonb_typeof(predicate.evidence)='array' THEN predicate.evidence
                ELSE '[]'::jsonb END)=0
           OR jsonb_array_length(CASE
                WHEN jsonb_typeof(checkpoint.value->'evidence')='array'
                  THEN checkpoint.value->'evidence' ELSE '[]'::jsonb END)=0
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
  v_result jsonb; v_computed_pass boolean;$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old$if t.status='running' and (t.claim_token is null or t.claim_expires_at<=statement_timestamp() or t.claimed_by_agent_id is distinct from executor_id_in or t.claim_token::text is distinct from fencing_token_in) then raise exception 'Active task socket requires valid checkpoint predicate fencing'; end if;$old$,
        $new$if t.status<>'running' or t.claim_token is null or t.claim_expires_at<=statement_timestamp() or t.claimed_by_agent_id is distinct from executor_id_in or t.claim_token::text is distinct from fencing_token_in then raise exception 'Active task claim required to record a checkpoint predicate'; end if;$new$
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
        CASE WHEN jsonb_typeof(inputs_in->'evidence')='array'
          THEN jsonb_array_length(inputs_in->'evidence')>0
          ELSE false END
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
        $old$'status','succeeded',
        'result',result_in,$old$,
        $new$'status','succeeded',
        'result',v_result$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old$'status','failed','result',result_in,$old$,
        $new$'status','failed','result',v_result$new$
      ),
      (
        to_regprocedure('public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text)'),
        $old$'passed',passed_in$old$,
        $new$'passed',v_computed_pass$new$
      )
    ) AS changes(signature,old_fragment,new_fragment)
  LOOP
    IF patch.signature IS NULL THEN
      RAISE EXCEPTION 'WorkSocket evidence migration: required function is missing';
    END IF;
    SELECT pg_get_functiondef(patch.signature) INTO source_definition;
    IF source_definition IS NULL THEN
      RAISE EXCEPTION 'WorkSocket evidence migration: function definition unavailable for %',patch.signature;
    END IF;
    matches := (length(source_definition) -
      length(replace(source_definition,patch.old_fragment,''))) /
      greatest(length(patch.old_fragment),1);
    IF matches <> 1 THEN
      RAISE EXCEPTION 'WorkSocket evidence migration drift: expected one match in %, found %',patch.signature,matches;
    END IF;
    patched_definition := replace(source_definition,patch.old_fragment,patch.new_fragment);
    EXECUTE patched_definition;
  END LOOP;
END
$migration$;

COMMENT ON FUNCTION public.record_checkpoint_predicate_result(uuid,smallint,text,integer,jsonb,jsonb,boolean,jsonb,text,text) IS
'Records a checkpoint predicate execution. Supported builtin operations are evaluated by the database; caller-supplied verdicts must match the computed result, and every success requires durable evidence.';

COMMENT ON FUNCTION public.task_ledger_verify_result(uuid,text,boolean,jsonb) IS
'Verification is available to any authorized principal and accepts only persisted result evidence, passing loop iterations and passing registered checkpoint predicates.';
