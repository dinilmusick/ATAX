-- Disposable integration: exercise the real canonical socket RPC against the
-- migrated PostgreSQL schema. Never apply fixtures to production.
BEGIN;
DO $test$
DECLARE
  t uuid; fence uuid:=gen_random_uuid(); inv public.socket_invocations;
  principal text:='test-socket-rpc-'||left(gen_random_uuid()::text,8);
  session_key text:='test-rpc-session-'||left(gen_random_uuid()::text,8);
  budget jsonb:=jsonb_build_object('modelId','unknown',
    'profileSetVersion','2026-11-22.2','tokenizerId',('utf8-byte-'||'upper-bound-v1'),
    'overhead',8,'inputLimit',2457,'outputLimit',819,'maxUsableTokens',3276);
  command jsonb; result1 jsonb; result2 jsonb; notification jsonb;
  wire text:='{"jsonrpc":"2.0","id":1,"result":{}}';
  input text:='{"jsonrpc":"2.0","method":"ping","id":1}';
  used1 bigint; used2 bigint; old_output bigint;
BEGIN
  IF NOT has_function_privilege('service_role','public.atax_socket_execute_v1(jsonb)','EXECUTE')
     OR has_function_privilege('anon','public.atax_socket_execute_v1(jsonb)','EXECUTE')
     OR has_table_privilege('authenticated','public.socket_gateway_capabilities','SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.socket_gateway_workflows'::regclass)
  THEN RAISE EXCEPTION 'FAIL: socket gateway privileges not isolated'; END IF;

  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,
     model_id,model_profile_version,expires_at)
  VALUES(principal,session_key,principal,'executor','unknown','2026-11-22.2',
    now()+interval '1 hour') RETURNING * INTO inv;

  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,task_role,
    claimed_by_agent_id,claimed_by_agent_name,claimed_session_id,claim_token,
    claim_expires_at,task_definition)
  VALUES('test-rpc-origin','test-rpc-origin','Canonical socket RPC test','running','execution',
    principal,principal,session_key,fence,now()+interval '1 hour',
    jsonb_build_object('name','Socket RPC test','actions',
      jsonb_build_array(jsonb_build_object('description','One finite action'))))
  RETURNING id INTO t;
  INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
    VALUES(t,1000,800,2000);
  INSERT INTO public.socket_gateway_capabilities(invocation_id,task_id,capability,enabled,expires_at)
    VALUES(inv.id,t,'socket:protocol',true,now()+interval '1 hour'),
      (inv.id,t,'socket:task:status',true,now()+interval '1 hour');

  command:=jsonb_build_object('operation','protocol','capability','socket:protocol',
    'principalId',principal,'sessionId',session_key,'taskId',t::text,
    'claimToken',fence::text,'requestWire',input,'replyId',1,
    'replyFrame',wire,'inboundTokens',octet_length(input)+8,
    'payload',jsonb_build_object('method','ping'),'budgetProfile',budget);
  result1:=public.atax_socket_execute_v1(command);
  IF result1->>'status'<>'ok' OR result1->>'replyFrame'<>wire
     OR (result1->'receipt'->>'outputTokens')::integer<>octet_length(wire)+8
  THEN RAISE EXCEPTION 'FAIL: exact charged protocol wire: %',result1; END IF;
  SELECT input_used INTO used1 FROM public.socket_task_budgets WHERE task_id=t;
  result2:=public.atax_socket_execute_v1(command);
  SELECT input_used INTO used2 FROM public.socket_task_budgets WHERE task_id=t;
  IF result2->>'status'<>'ok' OR used2-used1<>octet_length(input)+8
  THEN RAISE EXCEPTION 'FAIL: repeated request not charged again: %',result2; END IF;

  command:=jsonb_set(command,'{claimToken}',to_jsonb(gen_random_uuid()::text));
  result1:=public.atax_socket_execute_v1(command);
  IF result1->>'code'<>'STALE_FENCE'
  THEN RAISE EXCEPTION 'FAIL: wrong fence accepted: %',result1; END IF;

  command:=jsonb_set(command,'{claimToken}',to_jsonb(fence::text));
  command:=jsonb_set(command,'{operation}','"context_pull"'::jsonb);
  command:=jsonb_set(command,'{capability}','"socket:context:read"'::jsonb);
  result1:=public.atax_socket_execute_v1(command);
  IF result1->>'code'<>'CAPABILITY_REVOKED'
  THEN RAISE EXCEPTION 'FAIL: missing capability accepted: %',result1; END IF;

  command:=jsonb_set(command,'{operation}','"protocol"'::jsonb);
  command:=jsonb_set(command,'{capability}','"socket:protocol"'::jsonb);
  notification:=jsonb_set(command,'{replyFrame}','""'::jsonb);
  notification:=jsonb_set(notification,'{replyId}','null'::jsonb);
  notification:=jsonb_set(notification,'{payload}','{"method":"notifications/initialized"}'::jsonb);
  SELECT output_used INTO old_output FROM public.socket_task_budgets WHERE task_id=t;
  result1:=public.atax_socket_execute_v1(notification);
  IF result1->>'status'<>'ok' OR result1->>'replyFrame'<>''
     OR (SELECT output_used FROM public.socket_task_budgets WHERE task_id=t)<>old_output
  THEN RAISE EXCEPTION 'FAIL: notification output was not correctly suppressed: %',result1; END IF;

  command:=jsonb_build_object('operation','task_status','capability','socket:task:status',
    'principalId',principal,'sessionId',session_key,'taskId',t::text,
    'claimToken',fence::text,'requestWire',input,'replyId',1,
    'inboundTokens',octet_length(input)+8,'payload','{}'::jsonb,
    'budgetProfile',budget);
  result1:=public.atax_socket_execute_v1(command);
  IF result1->>'status'<>'ok'
     OR (result1->'replyFrame') IS NULL
     OR (result1->'receipt'->>'outputTokens')::integer
       <>octet_length(result1->>'replyFrame')+8
  THEN RAISE EXCEPTION 'FAIL: status response not precharged: %',result1; END IF;

  RAISE NOTICE 'PASS: canonical service-only socket RPC, exact wire, replay charging, fence, capability, notification, status';
END $test$;
ROLLBACK;
