-- Claim generation is monotonic across claim replacement and socket
-- capabilities tied to an older generation are rejected, even if actor,
-- invocation, task and capability strings still match.
BEGIN;
DO $test$
DECLARE
  task_out public.tasks;
  first_token uuid:=gen_random_uuid();
  second_token uuid:=gen_random_uuid();
  invocation public.socket_invocations;
  stale_result jsonb;
  command jsonb;
  wire text:='{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"atax_socket_task_status"}}';
  generation_before bigint;
  generation_after bigint;
BEGIN
  SELECT * INTO task_out FROM public.task_ledger_register(
    'worksocket-generation-test','WorkSocket Generation Fixture',
    'Monotonic claim generation test','Rollback-only generation fencing test',
    ARRAY[]::text[],'worksocket-generation-session','worker',3::smallint,
    'Test claim generation and capability invalidation','{}'::jsonb,NULL
  );
  IF task_out.id IS NULL THEN RAISE EXCEPTION 'Generation fixture task was not created'; END IF;

  INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
  VALUES(task_out.id,1000,800,2000);

  UPDATE public.tasks
  SET status='running',claimed_by_agent_id='worksocket-generation-actor',
      claimed_by_agent_name='worksocket-generation-actor',
      claimed_session_id='worksocket-generation-actor',
      claimed_at=statement_timestamp(),claim_token=first_token,
      claim_expires_at=statement_timestamp()+interval '2 minutes',
      heartbeat_at=statement_timestamp()
  WHERE id=task_out.id
  RETURNING * INTO task_out;

  generation_before:=task_out.claim_generation;
  IF generation_before<>1 THEN
    RAISE EXCEPTION 'First live claim generation should be 1, got %',generation_before;
  END IF;

  -- Make the first lease stale, then replace its token. The replacement is a
  -- genuine new generation; the previous token can no longer mutate the task.
  UPDATE public.tasks
  SET heartbeat_at=statement_timestamp()-interval '3 minutes',
      claim_expires_at=statement_timestamp()-interval '1 second'
  WHERE id=task_out.id;

  UPDATE public.tasks
  SET claimed_by_agent_id='worksocket-generation-actor',
      claimed_by_agent_name='worksocket-generation-actor',
      claimed_session_id='worksocket-generation-actor',
      claimed_at=statement_timestamp(),claim_token=second_token,
      claim_expires_at=statement_timestamp()+interval '2 minutes',
      heartbeat_at=statement_timestamp()
  WHERE id=task_out.id
  RETURNING * INTO task_out;

  generation_after:=task_out.claim_generation;
  IF generation_after<>generation_before+1 THEN
    RAISE EXCEPTION 'Claim replacement did not increment generation: % → %',generation_before,generation_after;
  END IF;
  IF public.task_ledger_check_claim(task_out.id,'worksocket-generation-actor',first_token) THEN
    RAISE EXCEPTION 'Replaced claim token still passes fencing';
  END IF;
  IF NOT public.task_ledger_check_claim(task_out.id,'worksocket-generation-actor',second_token) THEN
    RAISE EXCEPTION 'New claim token failed fencing validation';
  END IF;

  INSERT INTO public.socket_invocations(
    agent_id,session_id,authenticated_subject,role,expires_at,
    model_id,model_profile_version,transport
  ) VALUES (
    'worksocket-generation-actor','worksocket-generation-actor',
    'worksocket-generation-actor','worker',
    statement_timestamp()+interval '2 minutes','unknown','2026-11-22.2','external-jwt'
  ) RETURNING * INTO invocation;

  -- The invocation and task identity match, but the operation grant belongs to
  -- the prior claim generation. It must not authorize the replacement claim.
  INSERT INTO public.socket_gateway_capabilities(
    invocation_id,task_id,capability,enabled,expires_at,claim_generation
  ) VALUES(
    invocation.id,task_out.id,'socket:task:status',true,
    statement_timestamp()+interval '2 minutes',generation_before
  );

  command:=jsonb_build_object(
    'operation','task_status','capability','socket:task:status',
    'principalId','worksocket-generation-actor',
    'sessionId','worksocket-generation-actor',
    'taskId',task_out.id::text,'claimToken',second_token::text,
    'requestWire',wire,'replyId',7,
    'inboundTokens',octet_length(wire)+8,
    'payload','{}'::jsonb,
    'budgetProfile',jsonb_build_object(
      'modelId','unknown','tokenizerId','utf8-byte-upper-bound-v1',
      'profileSetVersion','2026-11-22.2','overhead',8,
      'inputLimit',2457,'outputLimit',819,'maxUsableTokens',3276
    )
  );
  stale_result:=public.atax_socket_execute_v1(command);
  IF stale_result->>'code' IS DISTINCT FROM 'CAPABILITY_REVOKED' THEN
    RAISE EXCEPTION 'Old claim generation socket grant was not revoked: %',stale_result;
  END IF;
END
$test$;
ROLLBACK;
