-- The authenticated MCP adapter is already the worker principal. Bootstrap a
-- task-bound invocation for that principal instead of requiring a second
-- external worker identity or an out-of-band invocation provisioning call.
-- This path is accepted only from the server-controlled MCP adapter marker,
-- only after the live task claim has been checked, and grants one exact
-- operation capability for one task. Secrets remain database-side.

ALTER TABLE public.socket_invocations
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'external-jwt';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.socket_invocations'::regclass
      AND conname='socket_invocations_transport_check'
  ) THEN
    ALTER TABLE public.socket_invocations
      ADD CONSTRAINT socket_invocations_transport_check
      CHECK (transport IN ('external-jwt','mcp'));
  END IF;
END
$constraint$;

DO $migration$
DECLARE
  fn regprocedure:=to_regprocedure('public.atax_socket_execute_v1(jsonb)');
  source_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  matches integer;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'WorkSocket MCP invocation migration: socket gateway is missing';
  END IF;
  SELECT pg_get_functiondef(fn) INTO source_definition;

  old_fragment := $old$v_page integer; v_limit integer; v_idx text;
  v_context_cursor public.socket_context_cursors%ROWTYPE;$old$;
  new_fragment := $new$v_page integer; v_limit integer; v_idx text;
  v_context_cursor public.socket_context_cursors%ROWTYPE;
  v_mcp_transport boolean; v_inv_created boolean:=false;$new$;
  matches := (length(source_definition)-length(replace(source_definition,old_fragment,''))) /
    greatest(length(old_fragment),1);
  IF matches<>1 THEN
    RAISE EXCEPTION 'WorkSocket MCP invocation migration drift in declarations: % matches',matches;
  END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);

  old_fragment := $old$  SELECT * INTO v_inv FROM public.socket_invocations
   WHERE agent_id=v_principal AND authenticated_subject=v_principal
     AND session_id=v_session AND role IN ('worker','atomizer','executor','verifier')
     AND expires_at>statement_timestamp()
     AND model_id=v_model->>'modelId'
     AND model_profile_version=v_model->>'profileSetVersion';
  IF NOT FOUND THEN RETURN jsonb_build_object('status','denied','code','UNAUTHORIZED'); END IF;$old$;

  new_fragment := $new$  v_mcp_transport:=command_in->>'transport'='mcp'
    AND command_in->>'profileSource'='atax-mcp-pinned-fallback';

  -- Serialize first registration for this logical authenticated MCP session.
  -- The unique session row is then locked and can never be rebound to another
  -- principal or transport.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_session,0));
  SELECT * INTO v_inv FROM public.socket_invocations
  WHERE session_id=v_session FOR UPDATE;

  IF FOUND THEN
    IF v_inv.agent_id IS DISTINCT FROM v_principal
       OR v_inv.authenticated_subject IS DISTINCT FROM v_principal
       OR v_inv.session_id IS DISTINCT FROM v_session
       OR (v_mcp_transport AND v_inv.transport IS DISTINCT FROM 'mcp') THEN
      RETURN jsonb_build_object('status','denied','code','UNAUTHORIZED');
    END IF;

    IF v_inv.expires_at<=statement_timestamp() THEN
      IF NOT v_mcp_transport OR v_inv.transport IS DISTINCT FROM 'mcp' THEN
        RETURN jsonb_build_object('status','denied','code','UNAUTHORIZED');
      END IF;
      UPDATE public.socket_invocations
      SET secret=gen_random_uuid(),registered_at=statement_timestamp(),
          expires_at=least(v_task.claim_expires_at,statement_timestamp()+interval '5 minutes'),
          model_id=v_model->>'modelId',
          model_profile_version=v_model->>'profileSetVersion',
          role='worker'
      WHERE id=v_inv.id
      RETURNING * INTO v_inv;
    ELSE
      IF v_inv.model_id IS DISTINCT FROM v_model->>'modelId'
         OR v_inv.model_profile_version IS DISTINCT FROM v_model->>'profileSetVersion'
         OR v_inv.role NOT IN ('worker','atomizer','executor','verifier') THEN
        RETURN jsonb_build_object('status','denied','code','UNAUTHORIZED');
      END IF;
      IF v_mcp_transport THEN
        UPDATE public.socket_invocations
        SET expires_at=least(v_task.claim_expires_at,statement_timestamp()+interval '5 minutes')
        WHERE id=v_inv.id RETURNING * INTO v_inv;
      END IF;
    END IF;
  ELSE
    IF NOT v_mcp_transport THEN
      RETURN jsonb_build_object('status','denied','code','UNAUTHORIZED');
    END IF;
    INSERT INTO public.socket_invocations
      (agent_id,session_id,authenticated_subject,role,expires_at,model_id,model_profile_version,transport)
    VALUES
      (v_principal,v_session,v_principal,'worker',
       least(v_task.claim_expires_at,statement_timestamp()+interval '5 minutes'),
       v_model->>'modelId',v_model->>'profileSetVersion','mcp')
    RETURNING * INTO v_inv;
    v_inv_created:=true;
  END IF;

  -- MCP grants only the single capability corresponding to this already
  -- allowlisted operation, and only for the task that has the live fence.
  IF v_inv.transport='mcp' AND v_mcp_transport THEN
    INSERT INTO public.socket_gateway_capabilities
      (invocation_id,task_id,capability,enabled,expires_at)
    VALUES
      (v_inv.id,v_task_id,v_capability,true,
       least(v_inv.expires_at,v_task.claim_expires_at))
    ON CONFLICT(invocation_id,task_id,capability) DO UPDATE
      SET enabled=true,expires_at=EXCLUDED.expires_at;
  END IF;

  IF v_inv_created THEN
    INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
    VALUES(v_task_id,'note',v_principal,'Authenticated MCP caller opened a fenced WorkSocket invocation',
      jsonb_build_object('transport','mcp','role',v_inv.role,
        'capability',v_capability,'invocation_id',v_inv.id,
        'lease_expires_at',v_task.claim_expires_at));
  END IF;$new$;

  matches := (length(source_definition)-length(replace(source_definition,old_fragment,''))) /
    greatest(length(old_fragment),1);
  IF matches<>1 THEN
    RAISE EXCEPTION 'WorkSocket MCP invocation migration drift in lookup: % matches',matches;
  END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);
  EXECUTE source_definition;
END
$migration$;

COMMENT ON COLUMN public.socket_invocations.transport IS
'Authenticated invocation transport. external-jwt is registered by the signed socket worker; mcp is provisioned transactionally from the server-authenticated ATAX MCP principal and a live fenced task claim.';

