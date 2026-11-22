-- Socket V1 integration: restricted, metered transactional control surface.
-- Apply strictly after atomisation (170000) and dispatch (170100).
-- This migration does not provision credentials or enable any workflow.
ALTER TABLE public.socket_invocations ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE public.socket_invocations ADD COLUMN IF NOT EXISTS model_profile_version text;

CREATE TABLE IF NOT EXISTS public.socket_gateway_capabilities (
  invocation_id uuid NOT NULL REFERENCES public.socket_invocations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN (
    'socket:protocol','socket:context:read','socket:output:submit',
    'socket:atomise:request','socket:workflow:request','socket:task:status')),
  enabled boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(invocation_id,task_id,capability)
);
CREATE TABLE IF NOT EXISTS public.socket_gateway_workflows (
  workflow_key text PRIMARY KEY CHECK(workflow_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
  operation text NOT NULL CHECK(operation IN ('test','build','automation','change_request')),
  target_repository text NOT NULL,
  runner_repository text NOT NULL,
  workflow_file text NOT NULL,
  target_sha text NOT NULL CHECK(target_sha ~ '^[a-f0-9]{40}$'),
  mode text NOT NULL CHECK(mode IN ('target','fmrl')),
  expected_output jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  FOREIGN KEY(target_repository,runner_repository,workflow_file,operation,mode)
    REFERENCES public.socket_dispatch_allowed_targets(target_repository,runner_repository,workflow_file,operation,mode)
);
DO $$
DECLARE tab text;
BEGIN
 FOR tab IN SELECT unnest(ARRAY['socket_gateway_capabilities','socket_gateway_workflows']) LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM public,anon,authenticated',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO service_role',tab);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.atax_socket_execute_v1(command_in jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $socket$
DECLARE
  v_task public.tasks%ROWTYPE;
  v_inv public.socket_invocations%ROWTYPE;
  v_budget public.socket_task_budgets%ROWTYPE;
  v_grant public.socket_gateway_capabilities%ROWTYPE;
  v_workflow public.socket_gateway_workflows%ROWTYPE;
  v_principal text; v_session text; v_operation text; v_capability text;
  v_claim uuid; v_task_id uuid;
  v_wire_in text; v_wire_out text; v_output jsonb; v_payload jsonb;
  v_model jsonb; v_reply_id jsonb;
  v_in bigint; v_out bigint;
  v_usage jsonb; v_data jsonb; v_submit jsonb;
  v_corr uuid; v_key text; v_dispatch uuid;
  v_page integer; v_limit integer; v_idx text;
BEGIN
  -- Only the secured worker's service-role REST call may invoke this function.
  IF current_user NOT IN ('service_role','postgres') THEN
    RETURN jsonb_build_object('status','denied','code','UNAUTHORIZED');
  END IF;
  IF command_in IS NULL OR jsonb_typeof(command_in)<>'object'
     OR octet_length(command_in::text)>50000 THEN
    RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS');
  END IF;
  v_principal:=command_in->>'principalId';
  v_session:=command_in->>'sessionId';
  v_operation:=command_in->>'operation';
  v_capability:=command_in->>'capability';
  v_wire_in:=command_in->>'requestWire';
  v_payload:=command_in->'payload';
  v_model:=command_in->'budgetProfile';
  v_reply_id:=command_in->'replyId';
  IF v_principal IS NULL OR length(v_principal) NOT BETWEEN 3 AND 120
     OR v_session IS NULL OR length(v_session) NOT BETWEEN 3 AND 160
     OR v_operation IS NULL OR v_capability IS NULL
     OR v_wire_in IS NULL OR octet_length(v_wire_in)>32768
     OR v_payload IS NULL OR jsonb_typeof(v_payload)<>'object'
     OR v_model IS NULL OR jsonb_typeof(v_model)<>'object'
     OR NOT (command_in->>'taskId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR NOT (command_in->>'claimToken' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     THEN RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS');
  END IF;
  v_task_id:=(command_in->>'taskId')::uuid;
  v_claim:=(command_in->>'claimToken')::uuid;
  v_in:=octet_length(v_wire_in)+coalesce((v_model->>'overhead')::integer,0);
  IF (command_in->>'inboundTokens')::bigint IS DISTINCT FROM v_in
    OR v_in<1 OR v_in>40000
    OR v_model->>'tokenizerId'<>'utf8-byte-upper-bound-v1'
    OR v_model->>'profileSetVersion'<>'2026-11-22.2'
    OR coalesce((v_model->>'overhead')::integer,-1)<>8
    THEN RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS');
  END IF;
  IF (v_operation,v_capability) NOT IN (
   ('protocol','socket:protocol'),('context_pull','socket:context:read'),
   ('output_submit','socket:output:submit'),
   ('atomisation_request','socket:atomise:request'),
   ('workflow_request','socket:workflow:request'),
   ('task_status','socket:task:status')
  ) THEN RETURN jsonb_build_object('status','denied','code','TOOL_FORBIDDEN'); END IF;
  SELECT * INTO v_task FROM public.tasks WHERE id=v_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status<>'running' OR v_task.task_role IS DISTINCT FROM 'execution'
     OR v_task.claim_token IS DISTINCT FROM v_claim
     OR v_task.claimed_by_agent_id IS DISTINCT FROM v_principal
     OR v_task.claimed_session_id IS DISTINCT FROM v_session
     OR v_task.claim_expires_at<=statement_timestamp()
  THEN RETURN jsonb_build_object('status','denied','code','STALE_FENCE'); END IF;
  SELECT * INTO v_inv FROM public.socket_invocations
   WHERE agent_id=v_principal AND authenticated_subject=v_principal
     AND session_id=v_session AND role IN ('worker','executor')
     AND expires_at>statement_timestamp()
     AND model_id=v_model->>'modelId'
     AND model_profile_version=v_model->>'profileSetVersion';
  IF NOT FOUND THEN RETURN jsonb_build_object('status','denied','code','UNAUTHORIZED'); END IF;
  SELECT * INTO v_budget FROM public.socket_task_budgets WHERE task_id=v_task_id FOR UPDATE;
  IF NOT FOUND OR v_budget.max_input>(v_model->>'inputLimit')::bigint
     OR v_budget.max_output>(v_model->>'outputLimit')::bigint
     OR v_budget.max_total>(v_model->>'maxUsableTokens')::bigint
  THEN RETURN jsonb_build_object('status','denied','code','BUDGET_EXHAUSTED'); END IF;
  SELECT * INTO v_grant FROM public.socket_gateway_capabilities
   WHERE invocation_id=v_inv.id AND task_id=v_task_id AND capability=v_capability
     AND enabled AND expires_at>statement_timestamp();
  IF NOT FOUND THEN RETURN jsonb_build_object('status','denied','code','CAPABILITY_REVOKED'); END IF;

  -- Both charges and the requested operation are in this single database transaction.
  -- Every repeated invocation creates a new consumption event, never a free replay.
  v_usage:=public.socket_record_usage(v_task_id,v_inv.id,v_inv.secret,v_claim,
    gen_random_uuid(),'input',v_in,'socket-mcp:request', '{}'::jsonb);
  IF (v_usage->>'needs_atomization')::boolean THEN
    RETURN jsonb_build_object('status','denied','code','BUDGET_EXHAUSTED');
  END IF;

  IF v_operation='protocol' THEN
    v_wire_out:=command_in->>'replyFrame';
    IF v_wire_out IS NULL OR octet_length(v_wire_out)>8192 THEN
      RETURN jsonb_build_object('status','denied','code','OUTPUT_TOO_LARGE');
    END IF;
    IF v_wire_out='' THEN
      -- MCP initialized notification has no response: the request is charged,
      -- no output is emitted or reserved.
      IF v_payload->>'method'<>'notifications/initialized'
      THEN RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS'); END IF;
    ELSE
      BEGIN
        v_output:=v_wire_out::jsonb;
      EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS');
      END;
      IF jsonb_typeof(v_output)<>'object' OR v_output->>'jsonrpc'<>'2.0'
         OR v_output->'id' IS DISTINCT FROM v_reply_id
      THEN RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS'); END IF;
    END IF;
  ELSE
    IF v_operation='task_status' THEN
      v_data:=jsonb_build_object('task_id',v_task.id,'status',v_task.status,
        'verification_status',v_task.verification_status,'claim_expires_at',v_task.claim_expires_at,
        'budget',jsonb_build_object('input_used',v_budget.input_used+v_in,
          'output_used',v_budget.output_used,'max_input',v_budget.max_input,
          'max_output',v_budget.max_output,'max_total',v_budget.max_total));
    ELSIF v_operation='context_pull' THEN
      v_limit:=least(greatest(coalesce((v_payload->>'limit')::integer,4),1),16);
      v_idx:=coalesce(v_payload->>'cursor','0');
      IF v_idx !~ '^[0-9]{1,4}$' THEN
        RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS');
      END IF;
      v_page:=v_idx::integer;
      v_data:=jsonb_build_object('task',jsonb_build_object('task_id',v_task.id,
        'name',left(coalesce(v_task.task_name,''),160),
        'description',left(coalesce(v_task.description,''),2048),
        'acceptance',v_task.acceptance_criteria,
        'definition',v_task.task_definition,
        'status',v_task.status),
        'events',coalesce((SELECT jsonb_agg(e.data ORDER BY e.occurred_at) FROM (
          SELECT jsonb_build_object('type',event_type,'message',left(coalesce(message,''),200),
            'at',occurred_at) AS data,occurred_at
          FROM public.task_events WHERE task_id=v_task_id ORDER BY occurred_at,id
          OFFSET v_page LIMIT v_limit
        ) e),'[]'::jsonb),'next_cursor',(v_page+v_limit)::text);
    ELSIF v_operation='output_submit' THEN
      IF jsonb_typeof(v_payload->'output')<>'object'
         OR octet_length((v_payload->'output')::text)>12288
      THEN RETURN jsonb_build_object('status','denied','code','OUTPUT_TOO_LARGE'); END IF;
      v_data:=jsonb_build_object('task_id',v_task_id,
        'accepted',true,'partial',coalesce((v_payload->>'partial')::boolean,false));
    ELSIF v_operation='atomisation_request' THEN
      IF length(coalesce(v_payload->>'reason','')) NOT BETWEEN 1 AND 512
      THEN RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS'); END IF;
      v_data:=jsonb_build_object('task_id',v_task_id,'atomisation_required',true);
    ELSIF v_operation='workflow_request' THEN
      SELECT * INTO v_workflow FROM public.socket_gateway_workflows
       WHERE workflow_key=v_payload->>'workflow_key' AND enabled;
      IF NOT FOUND OR jsonb_typeof(v_payload->'inputs')<>'object'
      THEN RETURN jsonb_build_object('status','denied','code','CAPABILITY_REVOKED'); END IF;
      v_key:='socket-'||md5(v_task_id::text||v_claim::text||v_workflow.workflow_key||
        (v_payload->'inputs')::text);
      v_corr:=md5(v_key)::uuid;
      v_data:=jsonb_build_object('task_id',v_task_id,'queued',true,'correlation_id',v_corr);
    ELSE
      RETURN jsonb_build_object('status','denied','code','TOOL_FORBIDDEN');
    END IF;
    v_wire_out:=json_build_object('jsonrpc','2.0','id',v_reply_id,
      'result',json_build_object('content',json_build_array(
        json_build_object('type','text','text',v_data::text))))::text;
  END IF;

  IF octet_length(v_wire_out)>8192
  THEN RETURN jsonb_build_object('status','denied','code','OUTPUT_TOO_LARGE'); END IF;
  v_out:=CASE WHEN v_wire_out='' THEN 0 ELSE octet_length(v_wire_out)+8 END;
  IF v_out>0 THEN
    v_usage:=public.socket_record_usage(v_task_id,v_inv.id,v_inv.secret,v_claim,
      gen_random_uuid(),'output',v_out,'socket-mcp:response','{}'::jsonb);
    IF (v_usage->>'needs_atomization')::boolean THEN
      RETURN jsonb_build_object('status','denied','code','BUDGET_EXHAUSTED');
    END IF;
  END IF;
  -- Side effects are performed only after the exact wire response is reserved.
  IF v_operation='atomisation_request' THEN
    PERFORM public.socket_stop_for_atomization(v_task_id,v_inv.id,v_inv.secret,v_claim,
      'socket-'||gen_random_uuid()::text,
      jsonb_build_object('reason',v_payload->>'reason',
        'partial_progress',left(coalesce(v_payload->>'partial_progress',''),3000)));
  ELSIF v_operation='output_submit' THEN
    IF coalesce((v_payload->>'partial')::boolean,false) THEN
      UPDATE public.tasks SET heartbeat_context=jsonb_build_object(
        'activity','socket_partial_output','summary',
        left(coalesce(v_payload->'output'->>'summary',''),3000)),
        heartbeat_at=now(),updated_at=now() WHERE id=v_task_id;
    ELSE
      PERFORM public.task_ledger_submit_result(v_task_id,v_inv.agent_id,v_claim,
        v_payload->'output',left(coalesce(v_payload->'output'->>'summary',''),500),
        '[]'::jsonb,coalesce(v_payload->'output'->'evidence','[]'::jsonb),'completed');
    END IF;
  ELSIF v_operation='workflow_request' THEN
    v_dispatch:=public.socket_dispatch_submit(v_task_id,v_inv.agent_id,v_inv.session_id,v_claim,
      v_corr,v_key,v_workflow.operation,v_workflow.target_repository,
      v_workflow.runner_repository,v_workflow.target_sha,v_workflow.workflow_file,
      v_workflow.mode,v_payload->'inputs',v_workflow.expected_output);
  END IF;
  RETURN jsonb_build_object('status','ok','receipt',
    jsonb_build_object('inputTokens',v_in,'outputTokens',v_out),
    'replyFrame',v_wire_out,'data',coalesce(v_data,'{}'::jsonb));
END $socket$;

REVOKE ALL ON FUNCTION public.atax_socket_execute_v1(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atax_socket_execute_v1(jsonb) TO service_role;
