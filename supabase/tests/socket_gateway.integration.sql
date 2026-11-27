-- Disposable integration: exercise the real canonical socket RPC against the
-- migrated PostgreSQL schema. Never apply fixtures to production.
BEGIN;
DO $test$
DECLARE
  t uuid; fence uuid:=gen_random_uuid(); inv public.socket_invocations;
  mcp_task uuid; mcp_principal text:='test-mcp-principal-'||left(gen_random_uuid()::text,8);
  mcp_session text:='test-mcp-session-'||left(gen_random_uuid()::text,8);
  mcp_fence uuid:=gen_random_uuid(); mcp_command jsonb; mcp_result jsonb;
  mcp_inv public.socket_invocations; mcp_grants integer;
  collision_task uuid; collision_principal text:='test-mcp-collision-'||left(gen_random_uuid()::text,8);
  collision_fence uuid:=gen_random_uuid();
  cursor_task uuid; cursor_fence uuid:=gen_random_uuid(); cursor_command jsonb;
  cursor_result jsonb; cursor_resumed jsonb; cursor_stale jsonb; cursor_used bigint;
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

  -- No separate worker identity or out-of-band invocation registration is
  -- needed for an authenticated MCP caller. The server-bound adapter marker
  -- bootstraps one invocation from the existing live claim and grants only the
  -- exact operation capability for that task.
  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,task_role,
    claimed_by_agent_id,claimed_by_agent_name,claimed_session_id,claim_token,
    claim_expires_at,task_definition)
  VALUES('test-rpc-origin','test-rpc-origin','MCP invocation bootstrap test','running','execution',
    mcp_principal,mcp_principal,mcp_principal,mcp_fence,now()+interval '1 hour',
    jsonb_build_object('name','MCP invocation bootstrap','general_pattern','claim → invoke → audit',
      'actions',jsonb_build_array(jsonb_build_object('description','Use one authenticated principal'))))
  RETURNING id INTO mcp_task;
  INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
    VALUES(mcp_task,1000,800,2000);

  mcp_command:=jsonb_build_object('transport','mcp',
    'profileSource','atax-mcp-pinned-fallback',
    'operation','task_status','capability','socket:task:status',
    'principalId',mcp_principal,'sessionId',mcp_session,'taskId',mcp_task::text,
    'claimToken',mcp_fence::text,'requestWire',input,'replyId',1,
    'inboundTokens',octet_length(input)+8,'payload','{}'::jsonb,'budgetProfile',budget);
  mcp_result:=public.atax_socket_execute_v1(mcp_command);
  IF mcp_result->>'status'<>'ok' THEN
    RAISE EXCEPTION 'FAIL: same-principal MCP invocation was not bootstrapped: %',mcp_result;
  END IF;
  SELECT * INTO mcp_inv FROM public.socket_invocations WHERE session_id=mcp_session;
  IF mcp_inv.id IS NULL OR mcp_inv.agent_id IS DISTINCT FROM mcp_principal
     OR mcp_inv.authenticated_subject IS DISTINCT FROM mcp_principal
     OR mcp_inv.role IS DISTINCT FROM 'worker'
     OR mcp_inv.transport IS DISTINCT FROM 'mcp'
     OR mcp_inv.model_id IS DISTINCT FROM 'unknown'
     OR mcp_inv.model_profile_version IS DISTINCT FROM '2026-11-22.2'
     OR mcp_inv.expires_at> (SELECT claim_expires_at FROM public.tasks WHERE id=mcp_task) THEN
    RAISE EXCEPTION 'FAIL: MCP invocation did not bind exact authenticated principal/session/claim: %',mcp_inv;
  END IF;
  SELECT count(*) INTO mcp_grants FROM public.socket_gateway_capabilities
  WHERE invocation_id=mcp_inv.id AND task_id=mcp_task AND enabled;
  IF mcp_grants<>1 OR NOT EXISTS(
      SELECT 1 FROM public.socket_gateway_capabilities
      WHERE invocation_id=mcp_inv.id AND task_id=mcp_task
        AND capability='socket:task:status' AND enabled)
     OR EXISTS(
      SELECT 1 FROM public.socket_gateway_capabilities
      WHERE invocation_id=mcp_inv.id AND task_id=mcp_task
        AND capability<>'socket:task:status') THEN
    RAISE EXCEPTION 'FAIL: MCP invocation received capabilities beyond the exact operation';
  END IF;

  -- A request from the same principal reuses the same invocation row, while
  -- another operation can add only its own task-bound capability.
  mcp_command:=jsonb_set(mcp_command,'{operation}','"context_pull"'::jsonb);
  mcp_command:=jsonb_set(mcp_command,'{capability}','"socket:context:read"'::jsonb);
  mcp_command:=jsonb_set(mcp_command,'{payload}','{"limit":1}'::jsonb);
  mcp_result:=public.atax_socket_execute_v1(mcp_command);
  IF mcp_result->>'status'<>'ok'
     OR (SELECT count(*) FROM public.socket_invocations WHERE session_id=mcp_session)<>1
     OR (SELECT count(*) FROM public.socket_gateway_capabilities
         WHERE invocation_id=mcp_inv.id AND task_id=mcp_task AND enabled)<>2 THEN
    RAISE EXCEPTION 'FAIL: same principal did not safely reuse MCP invocation for its second task capability: %',mcp_result;
  END IF;

  -- An authenticated actor may not take over another principal's logical
  -- session, even if the second principal owns a different valid task claim.
  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,task_role,
    claimed_by_agent_id,claimed_by_agent_name,claimed_session_id,claim_token,
    claim_expires_at,task_definition)
  VALUES('test-rpc-origin','test-rpc-origin','MCP session collision test','running','execution',
    collision_principal,collision_principal,mcp_session,collision_fence,now()+interval '1 hour',
    jsonb_build_object('name','Collision test','general_pattern','claim → reject rebind',
      'actions',jsonb_build_array(jsonb_build_object('description','Attempt another principal'))))
  RETURNING id INTO collision_task;
  INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
    VALUES(collision_task,1000,800,2000);
  mcp_command:=jsonb_set(mcp_command,'{principalId}',to_jsonb(collision_principal));
  mcp_command:=jsonb_set(mcp_command,'{taskId}',to_jsonb(collision_task::text));
  mcp_command:=jsonb_set(mcp_command,'{claimToken}',to_jsonb(collision_fence::text));
  mcp_result:=public.atax_socket_execute_v1(mcp_command);
  IF mcp_result->>'code'<>'UNAUTHORIZED'
     OR (SELECT agent_id FROM public.socket_invocations WHERE session_id=mcp_session)
        IS DISTINCT FROM mcp_principal THEN
    RAISE EXCEPTION 'FAIL: MCP session was rebound to a different authenticated principal: %',mcp_result;
  END IF;

  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,
     model_id,model_profile_version,expires_at)
  VALUES(principal,session_key,principal,'executor','unknown','2026-11-22.2',
    now()+interval '1 hour') RETURNING * INTO inv;

  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,task_role,
    claimed_by_agent_id,claimed_by_agent_name,claimed_session_id,claim_token,
    claim_expires_at,task_definition)
  VALUES('test-rpc-origin','test-rpc-origin','Canonical socket RPC test','running','execution',
    principal,principal,session_key,fence,now()+interval '1 hour',
    jsonb_build_object('name','Socket RPC test','general_pattern','hydrate → execute → verify','actions',
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
  SELECT input_used INTO used1 FROM public.socket_task_budgets WHERE task_id=t;
  result1:=public.atax_socket_execute_v1(command);
  result2:=public.atax_socket_execute_v1(command);
  SELECT input_used INTO used2 FROM public.socket_task_budgets WHERE task_id=t;
  IF result1->>'code'<>'CAPABILITY_REVOKED'
     OR result2->>'code'<>'CAPABILITY_REVOKED'
     OR used2-used1<>2*(octet_length(input)+8)
  THEN RAISE EXCEPTION 'FAIL: denied authenticated retries must be charged cumulatively: %, %, %',result1,result2,used2-used1; END IF;

  -- A separate task proves monotonic paging and resume without resetting or
  -- fabricating the earlier task's usage counters.
  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,task_role,
    claimed_by_agent_id,claimed_by_agent_name,claimed_session_id,claim_token,
    claim_expires_at,task_definition)
  VALUES('test-rpc-origin','test-rpc-origin','Context cursor RPC test','running','execution',
    principal,principal,session_key,cursor_fence,now()+interval '1 hour',
    jsonb_build_object('name','Context cursor test','general_pattern','page → observe → continue',
      'actions',jsonb_build_array(jsonb_build_object('description','Pull bounded context'))))
  RETURNING id INTO cursor_task;
  INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
    VALUES(cursor_task,1000,800,2000);
  INSERT INTO public.socket_gateway_capabilities(invocation_id,task_id,capability,enabled,expires_at)
    VALUES(inv.id,cursor_task,'socket:context:read',true,now()+interval '1 hour');
  input:='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"atax_socket_context_pull"}}';
  cursor_command:=jsonb_build_object('operation','context_pull',
    'capability','socket:context:read','principalId',principal,'sessionId',session_key,
    'taskId',cursor_task::text,'claimToken',cursor_fence::text,
    'requestWire',input,'replyId',2,'inboundTokens',octet_length(input)+8,
    'payload',jsonb_build_object('limit',1,'cursor','0'),'budgetProfile',budget);
  cursor_result:=public.atax_socket_execute_v1(cursor_command);
  IF cursor_result->>'status'<>'ok'
     OR cursor_result->'data'->>'next_cursor'<>'1' THEN
    RAISE EXCEPTION 'FAIL: first context page did not advance cursor: %',cursor_result;
  END IF;
  cursor_stale:=public.atax_socket_execute_v1(cursor_command);
  IF cursor_stale->>'code'<>'STALE_CURSOR' THEN
    RAISE EXCEPTION 'FAIL: repeated context page cursor was accepted: %',cursor_stale;
  END IF;
  cursor_command:=jsonb_set(cursor_command,'{payload}','{"limit":1}'::jsonb);
  cursor_resumed:=public.atax_socket_execute_v1(cursor_command);
  IF cursor_resumed->>'status'<>'ok'
     OR cursor_resumed->'data'->>'next_cursor'<>'2' THEN
    RAISE EXCEPTION 'FAIL: omitted context cursor did not resume from canonical next offset: %',cursor_resumed;
  END IF;
  cursor_command:=jsonb_set(cursor_command,'{payload}','{"limit":1,"cursor":"invalid"}'::jsonb);
  cursor_stale:=public.atax_socket_execute_v1(cursor_command);
  IF cursor_stale->>'code'<>'INVALID_ARGUMENTS' THEN
    RAISE EXCEPTION 'FAIL: malformed context cursor was accepted: %',cursor_stale;
  END IF;
  SELECT next_offset INTO cursor_used FROM public.socket_context_cursors WHERE task_id=cursor_task;
  IF cursor_used<>2 THEN
    RAISE EXCEPTION 'FAIL: stale/malformed context cursor mutated the cursor: %',cursor_used;
  END IF;

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

  -- A task-bound output must be durable and metered, but cannot implicitly
  -- bypass the independently evaluated bounded-v2 checkpoint and loop gates.
  INSERT INTO public.socket_gateway_capabilities
    (invocation_id,task_id,capability,enabled,expires_at)
    VALUES(inv.id,t,'socket:output:submit',true,now()+interval '1 hour');
  input:='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"atax_socket_output_submit"}}';
  command:=jsonb_build_object('operation','output_submit',
    'capability','socket:output:submit',
    'principalId',principal,'sessionId',session_key,'taskId',t::text,
    'claimToken',fence::text,'requestWire',input,'replyId',1,
    'inboundTokens',octet_length(input)+8,
    'payload',jsonb_build_object('partial',false,'output',
       jsonb_build_object('summary','Unverified artifact','evidence',
          jsonb_build_array('fixture output; not a verified checkpoint'))),
    'budgetProfile',budget);
  result1:=public.atax_socket_execute_v1(command);
  IF result1->>'status'<>'ok'
     OR (result1->'data'->>'accepted')::boolean IS DISTINCT FROM true
     OR (result1->'data'->>'pending_evaluation')::boolean IS DISTINCT FROM true
     OR (result1->'data'->>'completed')::boolean IS DISTINCT FROM false
     OR NOT EXISTS (
       SELECT 1 FROM public.socket_output_submissions s
       WHERE s.id=(result1->'data'->>'submission_id')::uuid
         AND s.task_id=t AND s.invocation_id=inv.id
         AND s.claim_token=fence AND s.partial=false
         AND s.payload->>'summary'='Unverified artifact')
     OR (SELECT status FROM public.tasks WHERE id=t)<>'running'
     OR (SELECT verification_status FROM public.tasks WHERE id=t)<>'not_started'
  THEN RAISE EXCEPTION 'FAIL: unverified output must persist without task completion: %', result1; END IF;

  RAISE NOTICE 'PASS: canonical service-only socket RPC, exact wire, replay charging, fence, capability, notification, status';
END $test$;
ROLLBACK;
