-- Materialize task claim generations and bind MCP capability grants to the
-- generation they were issued for. Enforce task-level write/verify tool scopes
-- in the database, independently of UI/MCP presentation.
BEGIN;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS claim_generation bigint NOT NULL DEFAULT 0
  CHECK (claim_generation>=0);
UPDATE public.tasks
SET claim_generation=greatest(claim_generation,CASE WHEN claim_token IS NOT NULL THEN greatest(attempt_count,1) ELSE attempt_count END);

ALTER TABLE public.socket_gateway_capabilities
  ADD COLUMN IF NOT EXISTS claim_generation bigint NOT NULL DEFAULT 0;
UPDATE public.socket_gateway_capabilities grant_row
SET claim_generation=task.claim_generation
FROM public.tasks task
WHERE task.id=grant_row.task_id;
ALTER TABLE public.socket_gateway_capabilities
  ALTER COLUMN claim_generation SET DEFAULT 0,
  ALTER COLUMN claim_generation SET NOT NULL;

CREATE OR REPLACE FUNCTION public.bump_task_claim_generation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $trigger$
BEGIN
  IF NEW.claim_token IS NOT NULL
     AND NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
    NEW.claim_generation:=OLD.claim_generation+1;
  ELSE
    NEW.claim_generation:=OLD.claim_generation;
  END IF;
  RETURN NEW;
END
$trigger$;
DROP TRIGGER IF EXISTS tasks_bump_claim_generation ON public.tasks;
CREATE TRIGGER tasks_bump_claim_generation
BEFORE UPDATE OF claim_token ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.bump_task_claim_generation();

CREATE OR REPLACE FUNCTION public.enforce_socket_task_tool_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $trigger$
DECLARE
  authority public.socket_task_authority%ROWTYPE;
  write_required boolean:=false;
  verify_required boolean:=false;
BEGIN
  write_required:=
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.claimed_by_agent_id IS DISTINCT FROM OLD.claimed_by_agent_id
    OR NEW.claimed_session_id IS DISTINCT FROM OLD.claimed_session_id
    OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at
    OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
    OR NEW.heartbeat_context IS DISTINCT FROM OLD.heartbeat_context
    OR NEW.current_step IS DISTINCT FROM OLD.current_step
    OR NEW.loop_script_status IS DISTINCT FROM OLD.loop_script_status
    OR NEW.loop_definition IS DISTINCT FROM OLD.loop_definition
    OR NEW.checkpoints IS DISTINCT FROM OLD.checkpoints
    OR NEW.task_definition IS DISTINCT FROM OLD.task_definition
    OR NEW.result IS DISTINCT FROM OLD.result
    OR NEW.result_summary IS DISTINCT FROM OLD.result_summary
    OR NEW.evidence IS DISTINCT FROM OLD.evidence
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at;

  verify_required:=
    NEW.verification_status IS DISTINCT FROM OLD.verification_status
    OR NEW.verification_report IS DISTINCT FROM OLD.verification_report
    OR NEW.verified_by_agent_id IS DISTINCT FROM OLD.verified_by_agent_id
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    OR NEW.verification_claimed_by_agent_id IS DISTINCT FROM OLD.verification_claimed_by_agent_id
    OR NEW.verification_claim_token IS DISTINCT FROM OLD.verification_claim_token
    OR NEW.verification_claim_expires_at IS DISTINCT FROM OLD.verification_claim_expires_at;

  IF NOT write_required AND NOT verify_required THEN RETURN NEW; END IF;

  SELECT * INTO authority FROM public.socket_task_authority WHERE task_id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task authority envelope is missing'; END IF;

  IF write_required AND NOT ('atax:write'=ANY(authority.allowed_tool_scopes)) THEN
    RAISE EXCEPTION 'Task authority denies atax:write for this task';
  END IF;
  IF verify_required AND NOT ('atax:verify'=ANY(authority.allowed_tool_scopes)) THEN
    RAISE EXCEPTION 'Task authority denies atax:verify for this task';
  END IF;
  RETURN NEW;
END
$trigger$;
DROP TRIGGER IF EXISTS tasks_enforce_socket_tool_scope ON public.tasks;
CREATE TRIGGER tasks_enforce_socket_tool_scope
BEFORE UPDATE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_socket_task_tool_scope();

CREATE OR REPLACE FUNCTION public.socket_json_scope_is_subset(
  allowed_scope jsonb,
  requested_scope jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path=public,pg_temp
AS $scope$
DECLARE
  item record;
  allowed_value jsonb;
BEGIN
  IF requested_scope IS NULL OR requested_scope='null'::jsonb THEN
    RETURN true;
  END IF;
  IF allowed_scope IS NULL OR jsonb_typeof(allowed_scope) IS DISTINCT FROM jsonb_typeof(requested_scope) THEN
    RETURN false;
  END IF;
  CASE jsonb_typeof(requested_scope)
    WHEN 'object' THEN
      FOR item IN SELECT key,value FROM jsonb_each(requested_scope) LOOP
        IF NOT (allowed_scope ? item.key) THEN RETURN false; END IF;
        allowed_value:=allowed_scope->item.key;
        IF NOT public.socket_json_scope_is_subset(allowed_value,item.value) THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    WHEN 'array' THEN
      RETURN allowed_scope @> requested_scope;
    WHEN 'number' THEN
      RETURN (requested_scope#>>'{}')::numeric <= (allowed_scope#>>'{}')::numeric;
    ELSE
      RETURN allowed_scope IS NOT DISTINCT FROM requested_scope;
  END CASE;
END
$scope$;

DO $migration$
DECLARE
  fn regprocedure:=to_regprocedure('public.atax_socket_execute_v1(jsonb)');
  source_definition text;
  old_fragment text;
  new_fragment text;
  matches integer;
BEGIN
  IF fn IS NULL THEN RAISE EXCEPTION 'Canonical socket execution RPC is missing'; END IF;
  SELECT pg_get_functiondef(fn) INTO source_definition;

  old_fragment:=$old$INSERT INTO public.socket_gateway_capabilities
      (invocation_id,task_id,capability,enabled,expires_at)
    VALUES
      (v_inv.id,v_task_id,v_capability,true,
       least(v_inv.expires_at,v_task.claim_expires_at))
    ON CONFLICT(invocation_id,task_id,capability) DO UPDATE
      SET enabled=true,expires_at=EXCLUDED.expires_at;$old$;
  new_fragment:=$new$INSERT INTO public.socket_gateway_capabilities
      (invocation_id,task_id,capability,enabled,expires_at,claim_generation)
    VALUES
      (v_inv.id,v_task_id,v_capability,true,
       least(v_inv.expires_at,v_task.claim_expires_at),v_task.claim_generation)
    ON CONFLICT(invocation_id,task_id,capability) DO UPDATE
      SET enabled=true,expires_at=EXCLUDED.expires_at,
          claim_generation=EXCLUDED.claim_generation;$new$;
  matches:=(length(source_definition)-length(replace(source_definition,old_fragment,'')))/
    greatest(length(old_fragment),1);
  IF matches<>1 THEN
    RAISE EXCEPTION 'Claim generation migration drift in invocation capability grant: % matches',matches;
  END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);

  old_fragment:=$old$  ELSIF v_operation='workflow_request' THEN
     v_dispatch:=public.socket_dispatch_submit(v_task_id,v_inv.agent_id,v_inv.session_id,v_claim,
       v_corr,v_key,v_workflow.operation,v_workflow.target_repository,
       v_workflow.runner_repository,v_workflow.target_sha,v_workflow.workflow_file,
       v_workflow.mode,v_payload->'inputs',v_workflow.expected_output);$old$;
  new_fragment:=$new$  ELSIF v_operation='workflow_request' THEN
     IF NOT EXISTS (
       SELECT 1 FROM public.socket_task_authority authority
       WHERE authority.task_id=v_task_id
         AND v_workflow.target_repository=ANY(authority.repository_scope)
     ) THEN
       RETURN jsonb_build_object('status','denied','code','CAPABILITY_REVOKED');
     END IF;
     IF v_payload->'inputs' ? 'resources' AND NOT public.socket_json_scope_is_subset(
       (SELECT authority.resource_scope FROM public.socket_task_authority authority
         WHERE authority.task_id=v_task_id),
       v_payload->'inputs'->'resources'
     ) THEN
       RETURN jsonb_build_object('status','denied','code','CAPABILITY_REVOKED');
     END IF;
     v_dispatch:=public.socket_dispatch_submit(v_task_id,v_inv.agent_id,v_inv.session_id,v_claim,
       v_corr,v_key,v_workflow.operation,v_workflow.target_repository,
       v_workflow.runner_repository,v_workflow.target_sha,v_workflow.workflow_file,
       v_workflow.mode,v_payload->'inputs',v_workflow.expected_output);$new$;
  matches:=(length(source_definition)-length(replace(source_definition,old_fragment,'')))/
    greatest(length(old_fragment),1);
  IF matches<>1 THEN
    RAISE EXCEPTION 'Task authority migration drift in workflow dispatch: % matches',matches;
  END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);
  EXECUTE source_definition;
END
$migration$;

COMMENT ON COLUMN public.tasks.claim_generation IS
'Monotonic fencing generation incremented whenever a new non-null claim token replaces the preceding task claim.';
COMMENT ON COLUMN public.socket_gateway_capabilities.claim_generation IS
'Optional task claim generation bound to a socket capability grant. MCP-created grants always bind the current generation; legacy external grants also remain guarded by the claim token.';

COMMIT;
