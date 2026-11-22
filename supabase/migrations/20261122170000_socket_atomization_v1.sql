-- Socket V1 Agent B: additive, versioned atomisation ledger.
-- No existing bounded-v2 creator is replaced. Trusted service-role control plane
-- registers one independently authenticated credential per invocation.
-- A credential is scoped to one session/agent/role and is not a user JWT.
CREATE TABLE IF NOT EXISTS public.socket_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id text NOT NULL CHECK (length(btrim(agent_id)) > 0),
  session_id text NOT NULL UNIQUE CHECK (length(btrim(session_id)) > 0),
  authenticated_subject text NOT NULL CHECK (length(btrim(authenticated_subject)) > 0),
  role text NOT NULL CHECK (role IN ('worker','atomizer','executor','verifier')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > registered_at)
);
CREATE TABLE IF NOT EXISTS public.socket_task_budgets (
  task_id uuid PRIMARY KEY REFERENCES public.tasks(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  max_input bigint NOT NULL CHECK (max_input > 0),
  max_output bigint NOT NULL CHECK (max_output > 0),
  max_total bigint NOT NULL CHECK (max_total > 0),
  input_used bigint NOT NULL DEFAULT 0 CHECK (input_used >= 0),
  output_used bigint NOT NULL DEFAULT 0 CHECK (output_used >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.socket_usage_events (
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  event_key uuid NOT NULL,
  invocation_id uuid NOT NULL REFERENCES public.socket_invocations(id),
  claim_token uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('input','output')),
  token_count bigint NOT NULL CHECK (token_count > 0),
  payload_ref text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id,event_key)
);
CREATE TABLE IF NOT EXISTS public.socket_overflow_reports (
  task_id uuid PRIMARY KEY REFERENCES public.tasks(id),
  reported_by uuid NOT NULL REFERENCES public.socket_invocations(id),
  claim_token uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('budget','scope')),
  report_key text NOT NULL CHECK (length(btrim(report_key)) > 0),
  usage_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  partial_progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.socket_atomizations (
  parent_task_id uuid PRIMARY KEY REFERENCES public.tasks(id),
  split_key text NOT NULL CHECK (length(btrim(split_key)) > 0),
  authored_by_invocation uuid NOT NULL REFERENCES public.socket_invocations(id),
  authored_by_agent text NOT NULL,
  authored_in_session text NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'array'),
  partial_progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.socket_atomization_children (
  child_task_id uuid PRIMARY KEY REFERENCES public.tasks(id),
  parent_task_id uuid NOT NULL REFERENCES public.socket_atomizations(parent_task_id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  independent_outcome text NOT NULL CHECK (length(btrim(independent_outcome)) > 0),
  UNIQUE (parent_task_id,ordinal)
);
CREATE TABLE IF NOT EXISTS public.socket_atomization_edges (
  target_task_id uuid NOT NULL REFERENCES public.socket_atomization_children(child_task_id),
  source_task_id uuid NOT NULL REFERENCES public.socket_atomization_children(child_task_id),
  dependency_type text NOT NULL CHECK (dependency_type IN ('blocking','advisory')),
  source_output text NOT NULL CHECK (length(btrim(source_output)) > 0),
  target_input text NOT NULL CHECK (length(btrim(target_input)) > 0),
  PRIMARY KEY (target_task_id,source_task_id,target_input),
  CHECK (target_task_id <> source_task_id)
);
CREATE TABLE IF NOT EXISTS public.socket_child_claim_grants (
  child_task_id uuid PRIMARY KEY REFERENCES public.socket_atomization_children(child_task_id),
  invocation_id uuid NOT NULL REFERENCES public.socket_invocations(id),
  claim_token uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.socket_child_verification_grants (
  child_task_id uuid PRIMARY KEY REFERENCES public.socket_atomization_children(child_task_id),
  invocation_id uuid NOT NULL REFERENCES public.socket_invocations(id),
  claim_token uuid NOT NULL,
  result_approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.socket_parent_finalization_grants (
  parent_task_id uuid PRIMARY KEY REFERENCES public.socket_atomizations(parent_task_id),
  invocation_id uuid NOT NULL REFERENCES public.socket_invocations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- No new tables are publicly accessible; the caller is a trusted authenticated
-- control plane. The opaque invocation secret is not distributed with ledger reads.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY[
    'socket_invocations','socket_task_budgets','socket_usage_events',
    'socket_overflow_reports','socket_atomizations','socket_atomization_children',
    'socket_atomization_edges','socket_child_claim_grants',
    'socket_child_verification_grants','socket_parent_finalization_grants'
  ]) AS name LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',r.name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',r.name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',r.name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.socket_require_invocation(
  invocation_in uuid, secret_in uuid, roles_in text[]
) RETURNS public.socket_invocations
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public,pg_temp
AS $$
DECLARE v public.socket_invocations;
BEGIN
  SELECT * INTO v FROM public.socket_invocations
   WHERE id=invocation_in AND secret=secret_in AND expires_at>statement_timestamp()
     AND role = ANY(roles_in);
  IF NOT FOUND THEN RAISE EXCEPTION 'Socket invocation missing, expired, or unauthorized'; END IF;
  RETURN v;
END $$;

-- Events are fed by any meter; one event_key means one durable chunk occurrence.
-- Replays of the same key are idempotent, but distinct retries accrue new usage.
CREATE OR REPLACE FUNCTION public.socket_record_usage(
  task_in uuid, invocation_in uuid, secret_in uuid, fence_in uuid,
  event_key_in uuid, direction_in text, tokens_in bigint,
  payload_ref_in text DEFAULT NULL, progress_in jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $$
DECLARE v_inv public.socket_invocations; v_task public.tasks;
        v_budget public.socket_task_budgets; v_previous public.socket_usage_events;
        v_over boolean; v_result jsonb;
BEGIN
  v_inv:=public.socket_require_invocation(invocation_in,secret_in,ARRAY['worker','executor']);
  IF event_key_in IS NULL OR direction_in NOT IN ('input','output') OR tokens_in <= 0 THEN
    RAISE EXCEPTION 'Invalid usage event';
  END IF;
  SELECT * INTO v_task FROM public.tasks WHERE id=task_in FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found'; END IF;
  SELECT * INTO v_budget FROM public.socket_task_budgets WHERE task_id=task_in FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task budget not configured'; END IF;
  SELECT * INTO v_previous FROM public.socket_usage_events
   WHERE task_id=task_in AND event_key=event_key_in;
  IF FOUND THEN
    IF v_previous.invocation_id<>invocation_in OR v_previous.claim_token<>fence_in
       OR v_previous.direction<>direction_in OR v_previous.token_count<>tokens_in
       OR v_previous.payload_ref IS DISTINCT FROM payload_ref_in THEN
      RAISE EXCEPTION 'Usage event key reused with conflicting data';
    END IF;
    RETURN jsonb_build_object('duplicate',true,'input_used',v_budget.input_used,
      'output_used',v_budget.output_used,'needs_atomization',
      EXISTS(SELECT 1 FROM public.socket_overflow_reports WHERE task_id=task_in));
  END IF;
  IF v_task.status<>'running' OR v_task.claim_token IS DISTINCT FROM fence_in
     OR v_task.claimed_by_agent_id IS DISTINCT FROM v_inv.agent_id
     OR v_task.claim_expires_at<=statement_timestamp() THEN
    RAISE EXCEPTION 'Stale or foreign socket lease';
  END IF;
  INSERT INTO public.socket_usage_events(task_id,event_key,invocation_id,
    claim_token,direction,token_count,payload_ref)
  VALUES(task_in,event_key_in,invocation_in,fence_in,direction_in,tokens_in,payload_ref_in);
  UPDATE public.socket_task_budgets SET
    input_used=input_used+CASE WHEN direction_in='input' THEN tokens_in ELSE 0 END,
    output_used=output_used+CASE WHEN direction_in='output' THEN tokens_in ELSE 0 END,
    updated_at=now()
  WHERE task_id=task_in RETURNING * INTO v_budget;
  v_over:=v_budget.input_used>v_budget.max_input
    OR v_budget.output_used>v_budget.max_output
    OR (v_budget.input_used+v_budget.output_used)>v_budget.max_total;
  IF v_over THEN
    INSERT INTO public.socket_overflow_reports(task_id,reported_by,claim_token,
      reason,report_key,usage_snapshot,partial_progress)
    VALUES(task_in,invocation_in,fence_in,'budget',event_key_in::text,
      jsonb_build_object('input',v_budget.input_used,'output',v_budget.output_used,
        'limit_input',v_budget.max_input,'limit_output',v_budget.max_output,
        'limit_total',v_budget.max_total),coalesce(progress_in,'{}'::jsonb))
    ON CONFLICT(task_id) DO NOTHING;
    UPDATE public.tasks SET status='waiting',claim_token=NULL,
      claimed_by_agent_id=NULL,claimed_by_agent_name=NULL,
      claimed_session_id=NULL,claimed_at=NULL,claim_expires_at=NULL,
      heartbeat_at=now(),updated_at=now(),current_step='Needs atomisation',
      heartbeat_context=jsonb_build_object('activity','needs_atomization',
        'progress',coalesce(progress_in,'{}'::jsonb),
        'next_action','A separately authenticated invocation must atomise the task')
    WHERE id=task_in;
    INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
    VALUES(task_in,'note',v_inv.agent_id,'Socket budget exceeded; execution stopped',
      jsonb_build_object('reason','needs_atomization','event_key',event_key_in));
  END IF;
  v_result:=jsonb_build_object('duplicate',false,'input_used',v_budget.input_used,
    'output_used',v_budget.output_used,'needs_atomization',v_over);
  RETURN v_result;
END $$;

-- Explicit scope-based stop when a task is too large even without a token overage.
CREATE OR REPLACE FUNCTION public.socket_stop_for_atomization(
  task_in uuid, invocation_in uuid, secret_in uuid, fence_in uuid,
  report_key_in text, partial_in jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $$
DECLARE v_inv public.socket_invocations; v_task public.tasks;
BEGIN
  v_inv:=public.socket_require_invocation(invocation_in,secret_in,ARRAY['worker','executor']);
  SELECT * INTO v_task FROM public.tasks WHERE id=task_in FOR UPDATE;
  IF v_task.status<>'running' OR v_task.claim_token IS DISTINCT FROM fence_in
    OR v_task.claimed_by_agent_id IS DISTINCT FROM v_inv.agent_id
    OR v_task.claim_expires_at<=statement_timestamp() THEN
    RAISE EXCEPTION 'Stale or foreign socket lease';
  END IF;
  INSERT INTO public.socket_overflow_reports(task_id,reported_by,claim_token,
    reason,report_key,partial_progress)
  VALUES(task_in,invocation_in,fence_in,'scope',report_key_in,coalesce(partial_in,'{}'))
  ON CONFLICT(task_id) DO NOTHING;
  UPDATE public.tasks SET status='waiting',claim_token=NULL,
    claimed_by_agent_id=NULL,claimed_by_agent_name=NULL,
    claimed_session_id=NULL,claimed_at=NULL,claim_expires_at=NULL,
    heartbeat_at=now(),updated_at=now(),current_step='Needs atomisation',
    heartbeat_context=jsonb_build_object('activity','needs_atomization',
      'progress',coalesce(partial_in,'{}'),
      'next_action','Decompose into independently verified child sockets')
   WHERE id=task_in;
  INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
   VALUES(task_in,'note',v_inv.agent_id,'Task scope requires atomisation',
    jsonb_build_object('reason','needs_atomization','report_key',report_key_in));
  RETURN jsonb_build_object('task_id',task_in,'needs_atomization',true);
END $$;

-- Split is one PostgreSQL transaction: fence, stop, create nodes/edges, release.
-- If any child or edge fails validation, the entire split (including stop) rolls back.
CREATE OR REPLACE FUNCTION public.socket_atomize_task(
  parent_in uuid, invocation_in uuid, secret_in uuid, fence_in uuid,
  split_key_in text, children_in jsonb, partial_in jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $$
DECLARE v_inv public.socket_invocations; v_parent public.tasks;
        v_old public.socket_atomizations; v_child jsonb; v_deps jsonb;
        v_id uuid; v_ids uuid[]:=ARRAY[]::uuid[]; v_n integer; v_i integer:=0;
        v_dep jsonb; v_source integer; v_kind text; v_from text; v_to text;
        v_actions jsonb; v_parameters jsonb; v_checkpoints jsonb;
        v_input jsonb; v_output jsonb; v_outcome text;
        v_budget public.socket_task_budgets; v_from_task public.tasks; v_to_task public.tasks;
BEGIN
  v_inv:=public.socket_require_invocation(invocation_in,secret_in,ARRAY['worker','atomizer']);
  IF nullif(btrim(split_key_in),'') IS NULL OR jsonb_typeof(children_in)<>'array'
     OR jsonb_array_length(children_in) NOT BETWEEN 2 AND 16 THEN
    RAISE EXCEPTION 'Split requires a stable key and 2-16 independently verifiable children';
  END IF;
  SELECT * INTO v_parent FROM public.tasks WHERE id=parent_in FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parent task missing'; END IF;
  SELECT * INTO v_old FROM public.socket_atomizations WHERE parent_task_id=parent_in;
  IF FOUND THEN
    IF v_old.split_key<>split_key_in OR v_old.definition<>children_in
       OR v_old.authored_by_invocation<>invocation_in THEN
      RAISE EXCEPTION 'Parent already atomised by a different request';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.socket_overflow_reports o
       WHERE o.task_id=parent_in AND o.claim_token=fence_in) THEN
      RAISE EXCEPTION 'Split replay requires its original overflow fence';
    END IF;
    RETURN jsonb_build_object('duplicate',true,'parent_id',parent_in,
      'child_ids',(SELECT jsonb_agg(child_task_id ORDER BY ordinal)
        FROM public.socket_atomization_children WHERE parent_task_id=parent_in));
  END IF;
  IF v_parent.status='running' THEN
    IF v_parent.claim_token IS DISTINCT FROM fence_in
       OR v_parent.claimed_by_agent_id IS DISTINCT FROM v_inv.agent_id
       OR v_parent.claim_expires_at<=statement_timestamp() THEN
      RAISE EXCEPTION 'Stale or foreign split fence';
    END IF;
  ELSIF v_parent.status='waiting' THEN
    IF NOT EXISTS(SELECT 1 FROM public.socket_overflow_reports o
       JOIN public.socket_invocations source_inv ON source_inv.id=o.reported_by
       WHERE o.task_id=parent_in AND o.claim_token=fence_in
       AND (v_inv.role='atomizer' OR source_inv.id=v_inv.id))
       OR v_parent.claim_token IS NOT NULL THEN
      RAISE EXCEPTION 'Waiting split requires the original fenced overflow report and approved atomizer';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only an active fenced socket or stopped overflow can be atomised';
  END IF;
  SELECT * INTO v_budget FROM public.socket_task_budgets WHERE task_id=parent_in;
  IF NOT FOUND THEN RAISE EXCEPTION 'Parent budget missing'; END IF;
  -- Atomisation is a non-terminal waiting state, never an unrecoverable failure.
  IF v_parent.status='running' THEN
    INSERT INTO public.socket_overflow_reports(task_id,reported_by,claim_token,
      reason,report_key,partial_progress)
    VALUES(parent_in,invocation_in,fence_in,'scope',split_key_in,coalesce(partial_in,'{}'));
  END IF;
  UPDATE public.tasks SET status='waiting',claim_token=NULL,
    claimed_by_agent_id=NULL,claimed_by_agent_name=NULL,
    claimed_session_id=NULL,claimed_at=NULL,claim_expires_at=NULL,
    heartbeat_at=now(),updated_at=now(),current_step='Awaiting verified child outcomes',
    heartbeat_context=jsonb_build_object('activity','atomized',
      'progress',coalesce(partial_in,'{}'),
      'next_action','Independent later invocations claim child sockets')
    WHERE id=parent_in;
  INSERT INTO public.socket_atomizations(parent_task_id,split_key,
    authored_by_invocation,authored_by_agent,authored_in_session,definition,partial_progress)
  VALUES(parent_in,split_key_in,invocation_in,v_inv.agent_id,v_inv.session_id,
    children_in,coalesce(partial_in,'{}'));
  FOR v_child IN SELECT value FROM jsonb_array_elements(children_in) LOOP
    v_i:=v_i+1;
    v_actions:=v_child->'actions';
    v_input:=v_child->'inputs'; v_output:=v_child->'outputs';
    v_outcome:=nullif(btrim(v_child->>'outcome'),'');
    IF nullif(btrim(v_child->>'name'),'') IS NULL OR v_outcome IS NULL
       OR jsonb_typeof(v_actions)<>'array'
       OR jsonb_array_length(v_actions) NOT BETWEEN 1 AND 4
       OR jsonb_typeof(v_input)<>'object' OR jsonb_typeof(v_output)<>'object'
       OR jsonb_typeof(v_child->'acceptance_criteria')<>'array'
       OR jsonb_array_length(v_child->'acceptance_criteria')<>1
       OR nullif(btrim(v_child->'verification'->>'method'),'') IS NULL
       OR v_child->'loop'->>'enabled'<>'true'
       OR nullif(btrim(v_child->'loop'->>'objective'),'') IS NULL
       OR coalesce((v_child->'loop'->>'max_iterations')::integer,0)<1 THEN
      RAISE EXCEPTION 'Child % requires 1-4 actions, one outcome, IO contracts, independent verification and a ready loop',v_i;
    END IF;
    SELECT jsonb_agg(jsonb_build_object('id','cp-'||n,'description',
        coalesce(x->>'description',v_outcome),'required',true) ORDER BY n)
      INTO v_parameters FROM jsonb_array_elements(v_actions) WITH ORDINALITY a(x,n);
    SELECT jsonb_agg(jsonb_build_object('parameter_id','cp-'||n,
        'objective',coalesce(x->>'description',v_outcome),
        'status','pending','evidence','[]'::jsonb,'context','{}'::jsonb) ORDER BY n)
      INTO v_checkpoints FROM jsonb_array_elements(v_actions) WITH ORDINALITY a(x,n);
    INSERT INTO public.tasks(goal_id,system_id,agent_id,agent_name,agent_type,
      task_name,description,status,priority,parent_task_id,target,task_type,
      task_definition,input_contract,output_contract,acceptance_criteria,
      verification_plan,loop_definition,required_capabilities,execution_model,
      completion_parameters,checkpoints,loop_script_status,loop_author_agent_id,
      request_mode,work_modality,metadata)
    VALUES(v_parent.goal_id,v_parent.system_id,v_inv.agent_id,v_inv.agent_id,'atomizer',
      v_child->>'name',v_child->>'description','waiting',v_parent.priority,
      parent_in,v_parent.target,v_parent.task_type,
      v_child || jsonb_build_object('general_pattern',
        coalesce(v_child->>'general_pattern','input → execute → observe → verify'),
        'goal_id',v_parent.goal_id),
      v_input,v_output,v_child->'acceptance_criteria',v_child->'verification',
      v_child->'loop',coalesce(v_parent.required_capabilities,'{}'::text[]),
      'bounded-v2',v_parameters,v_checkpoints,'ready',v_inv.agent_id,
      v_parent.request_mode,v_parent.work_modality,
      jsonb_build_object('socket_v1',true,'split_key',split_key_in,
        'parent_task_id',parent_in,'authored_by_invocation',invocation_in))
    RETURNING id INTO v_id;
    v_ids:=array_append(v_ids,v_id);
    INSERT INTO public.socket_atomization_children(child_task_id,parent_task_id,
      ordinal,independent_outcome) VALUES(v_id,parent_in,v_i,v_outcome);
    INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
    VALUES(v_id,
      coalesce((v_child->'budget'->>'input')::bigint,v_budget.max_input),
      coalesce((v_child->'budget'->>'output')::bigint,v_budget.max_output),
      coalesce((v_child->'budget'->>'total')::bigint,v_budget.max_total));
    INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
    VALUES(v_id,'registered',v_inv.agent_id,'Atomised child created',
      jsonb_build_object('parent_id',parent_in,'split_key',split_key_in,
        'author_invocation',invocation_in,'independent_outcome',v_outcome));
  END LOOP;
  v_i:=0;
  FOR v_child IN SELECT value FROM jsonb_array_elements(children_in) LOOP
    v_i:=v_i+1;
    v_deps:=coalesce(v_child->'dependencies','[]'::jsonb);
    IF jsonb_typeof(v_deps)<>'array' THEN
      RAISE EXCEPTION 'Dependencies must be an array';
    END IF;
    FOR v_dep IN SELECT value FROM jsonb_array_elements(v_deps) LOOP
      v_source:=(v_dep->>'child_index')::integer;
      v_kind:=coalesce(v_dep->>'type','blocking');
      v_from:=v_dep->>'from_output'; v_to:=v_dep->>'to_input';
      IF v_source IS NULL OR v_source<1 OR v_source>=v_i
         OR v_kind NOT IN ('blocking','advisory')
         OR nullif(btrim(v_from),'') IS NULL OR nullif(btrim(v_to),'') IS NULL THEN
        RAISE EXCEPTION 'Invalid typed dependency in child %',v_i;
      END IF;
      SELECT * INTO v_from_task FROM public.tasks WHERE id=v_ids[v_source];
      SELECT * INTO v_to_task FROM public.tasks WHERE id=v_ids[v_i];
      IF NOT (v_from_task.output_contract ? v_from)
         OR NOT (v_to_task.input_contract ? v_to)
         OR v_from_task.output_contract->>v_from IS DISTINCT FROM
           v_to_task.input_contract->>v_to THEN
        RAISE EXCEPTION 'Typed dependency input/output mismatch in child %',v_i;
      END IF;
      PERFORM public.task_ledger_add_dependency(v_ids[v_i],v_ids[v_source],
        v_inv.agent_id,v_kind);
      INSERT INTO public.socket_atomization_edges(target_task_id,source_task_id,
        dependency_type,source_output,target_input)
      VALUES(v_ids[v_i],v_ids[v_source],v_kind,v_from,v_to);
    END LOOP;
  END LOOP;
  INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
  VALUES(parent_in,'note',v_inv.agent_id,'Socket atomised; parent awaits verified children',
    jsonb_build_object('split_key',split_key_in,'child_ids',to_jsonb(v_ids),
      'partial_progress',coalesce(partial_in,'{}'::jsonb)));
  RETURN jsonb_build_object('duplicate',false,'parent_id',parent_in,
    'child_ids',to_jsonb(v_ids),'needs_atomization',false);
END $$;

-- A grant is inserted before the guarded task transition, and may be rotated
-- when a former lease has truly expired. Legacy task claims cannot bypass it.
CREATE OR REPLACE FUNCTION public.socket_claim_child(
  child_in uuid, invocation_in uuid, secret_in uuid, lease_seconds_in integer DEFAULT 120
) RETURNS public.tasks LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $$
DECLARE v_inv public.socket_invocations; v_child public.tasks;
        v_atom public.socket_atomizations; v_token uuid:=gen_random_uuid();
BEGIN
  v_inv:=public.socket_require_invocation(invocation_in,secret_in,ARRAY['executor','worker']);
  SELECT * INTO v_child FROM public.tasks WHERE id=child_in FOR UPDATE;
  SELECT a.* INTO v_atom FROM public.socket_atomizations a
    JOIN public.socket_atomization_children c ON c.parent_task_id=a.parent_task_id
    WHERE c.child_task_id=child_in;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not an atomised child'; END IF;
  IF v_inv.agent_id=v_atom.authored_by_agent
     OR v_inv.id=v_atom.authored_by_invocation
     OR v_inv.session_id=v_atom.authored_in_session THEN
    RAISE EXCEPTION 'Atomiser identity/session cannot execute its child';
  END IF;
  IF v_child.task_role<>'execution' OR v_child.loop_script_status<>'ready'
    OR v_child.attempt_count>=v_child.max_attempts
    OR EXISTS(SELECT 1 FROM public.socket_atomizations WHERE parent_task_id=child_in)
    OR NOT (v_child.status='waiting' OR
      (v_child.status='running' AND v_child.claim_expires_at<=statement_timestamp()
        AND v_child.heartbeat_at<=statement_timestamp()-interval '2 minutes')) THEN
    RAISE EXCEPTION 'Child is not available for a fresh claim';
  END IF;
  IF EXISTS(SELECT 1 FROM public.task_dependencies d JOIN public.tasks dep
       ON dep.id=d.depends_on_task_id WHERE d.task_id=child_in
       AND d.dependency_type='blocking'
       AND (dep.status<>'completed' OR dep.verification_status<>'verified')) THEN
    RAISE EXCEPTION 'Child has unverified blocking dependencies';
  END IF;
  INSERT INTO public.socket_child_claim_grants(child_task_id,invocation_id,claim_token)
    VALUES(child_in,invocation_in,v_token)
    ON CONFLICT(child_task_id) DO UPDATE SET invocation_id=EXCLUDED.invocation_id,
      claim_token=EXCLUDED.claim_token,created_at=now();
  UPDATE public.tasks SET status='running',claimed_by_agent_id=v_inv.agent_id,
    claimed_by_agent_name=v_inv.agent_id,claimed_session_id=v_inv.session_id,
    claim_token=v_token,claimed_at=now(),
    claim_expires_at=now()+make_interval(secs=>greatest(30,least(lease_seconds_in,120))),
    attempt_count=attempt_count+1,heartbeat_at=now(),updated_at=now(),
    current_step='Fresh independently authenticated child claim'
    WHERE id=child_in RETURNING * INTO v_child;
  INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
    VALUES(child_in,'claimed',v_inv.agent_id,'Fenced child socket claimed',
      jsonb_build_object('invocation_id',invocation_in,'fence',v_token));
  RETURN v_child;
END $$;

CREATE OR REPLACE FUNCTION public.socket_claim_child_verification(
  child_in uuid, invocation_in uuid, secret_in uuid, lease_seconds_in integer DEFAULT 120
) RETURNS public.tasks LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $$
DECLARE v_inv public.socket_invocations; v_child public.tasks;
        v_atom public.socket_atomizations; v_token uuid:=gen_random_uuid();
BEGIN
  v_inv:=public.socket_require_invocation(invocation_in,secret_in,ARRAY['verifier']);
  SELECT * INTO v_child FROM public.tasks WHERE id=child_in FOR UPDATE;
  SELECT a.* INTO v_atom FROM public.socket_atomizations a
    JOIN public.socket_atomization_children c ON c.parent_task_id=a.parent_task_id
    WHERE c.child_task_id=child_in;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not an atomised child'; END IF;
  IF v_inv.agent_id IN (v_atom.authored_by_agent,v_child.claimed_by_agent_id)
     OR v_inv.id=v_atom.authored_by_invocation
     OR v_inv.session_id=v_atom.authored_in_session
     OR v_inv.session_id=v_child.claimed_session_id THEN
    RAISE EXCEPTION 'Verifier must be independent of atomiser and executor';
  END IF;
  IF v_child.status<>'completed' OR v_child.verification_status<>'pending'
    OR v_child.result_submitted_at IS NULL OR
    (coalesce(v_child.verification_claim_expires_at,'-infinity'::timestamptz)>statement_timestamp()
      AND v_child.verification_claim_expires_at<>'infinity'::timestamptz) THEN
    RAISE EXCEPTION 'Child is not awaiting independent verification';
  END IF;
  INSERT INTO public.socket_child_verification_grants(child_task_id,invocation_id,claim_token,result_approved)
   VALUES(child_in,invocation_in,v_token,false)
   ON CONFLICT(child_task_id) DO UPDATE SET invocation_id=EXCLUDED.invocation_id,
     claim_token=EXCLUDED.claim_token,result_approved=false,created_at=now();
  UPDATE public.tasks SET verification_claimed_by_agent_id=v_inv.agent_id,
    verification_claim_token=v_token,
    verification_claim_expires_at=now()+make_interval(secs=>greatest(30,least(lease_seconds_in,3600))),
    updated_at=now() WHERE id=child_in RETURNING * INTO v_child;
  RETURN v_child;
END $$;

CREATE OR REPLACE FUNCTION public.socket_verify_child(
  child_in uuid, invocation_in uuid, secret_in uuid, verification_fence_in uuid,
  verified_in boolean, report_in jsonb
) RETURNS public.tasks LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $$
DECLARE v_inv public.socket_invocations; v_child public.tasks;
BEGIN
  v_inv:=public.socket_require_invocation(invocation_in,secret_in,ARRAY['verifier']);
  SELECT * INTO v_child FROM public.tasks WHERE id=child_in FOR UPDATE;
  IF v_child.verification_status<>'pending' OR v_child.status<>'completed'
    OR v_child.verification_claim_token IS DISTINCT FROM verification_fence_in
    OR v_child.verification_claimed_by_agent_id IS DISTINCT FROM v_inv.agent_id
    OR v_child.verification_claim_expires_at<=statement_timestamp()
    OR NOT EXISTS(SELECT 1 FROM public.socket_child_verification_grants
      WHERE child_task_id=child_in AND invocation_id=invocation_in
        AND claim_token=verification_fence_in) THEN
    RAISE EXCEPTION 'Verification fence missing, stale, or foreign';
  END IF;
  IF verified_in AND (jsonb_typeof(report_in)<>'object'
    OR coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(report_in->'evidence')='array'
      THEN report_in->'evidence' ELSE '[]'::jsonb END),0)=0) THEN
    RAISE EXCEPTION 'Independent verification needs nonempty evidence';
  END IF;
  UPDATE public.socket_child_verification_grants SET result_approved=verified_in
    WHERE child_task_id=child_in AND invocation_id=invocation_in
      AND claim_token=verification_fence_in;
  UPDATE public.tasks SET
    verification_status=CASE WHEN verified_in THEN 'verified' ELSE 'rejected' END,
    verification_report=coalesce(report_in,'{}'::jsonb),
    verified_by_agent_id=v_inv.agent_id,verified_at=now(),
    verification_claimed_by_agent_id=NULL,verification_claim_token=NULL,
    verification_claim_expires_at=NULL,updated_at=now()
    WHERE id=child_in RETURNING * INTO v_child;
  INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
   VALUES(child_in,'note',v_inv.agent_id,'Independent socket child verification',
     jsonb_build_object('verified',verified_in,'report',coalesce(report_in,'{}')));
  RETURN v_child;
END $$;

CREATE OR REPLACE FUNCTION public.socket_finalize_parent(
  parent_in uuid, invocation_in uuid, secret_in uuid, report_in jsonb
) RETURNS public.tasks LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $$
DECLARE v_inv public.socket_invocations; v_atom public.socket_atomizations;
        v_parent public.tasks;
BEGIN
  v_inv:=public.socket_require_invocation(invocation_in,secret_in,ARRAY['verifier']);
  SELECT * INTO v_parent FROM public.tasks WHERE id=parent_in FOR UPDATE;
  SELECT * INTO v_atom FROM public.socket_atomizations WHERE parent_task_id=parent_in;
  IF NOT FOUND OR v_parent.status<>'waiting' THEN
    RAISE EXCEPTION 'Parent is not an atomised waiting socket';
  END IF;
  IF v_inv.agent_id=v_atom.authored_by_agent OR v_inv.id=v_atom.authored_by_invocation
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
  IF NOT EXISTS(SELECT 1 FROM public.socket_atomization_children
     WHERE parent_task_id=parent_in)
     OR EXISTS(SELECT 1 FROM public.socket_atomization_children c
       JOIN public.tasks t ON t.id=c.child_task_id
       WHERE c.parent_task_id=parent_in
         AND (t.status<>'completed' OR t.verification_status<>'verified')) THEN
    RAISE EXCEPTION 'Parent cannot complete before all children are independently verified';
  END IF;
  IF jsonb_typeof(report_in)<>'object' OR
     jsonb_typeof(report_in->'evidence')<>'array' OR
     jsonb_array_length(report_in->'evidence')=0 THEN
    RAISE EXCEPTION 'Parent finalization requires independent evidence';
  END IF;
  INSERT INTO public.socket_parent_finalization_grants(parent_task_id,invocation_id)
    VALUES(parent_in,invocation_in) ON CONFLICT(parent_task_id)
    DO UPDATE SET invocation_id=EXCLUDED.invocation_id,created_at=now();
  UPDATE public.tasks SET status='completed',verification_status='verified',
    verification_report=report_in,verified_by_agent_id=v_inv.agent_id,
    verified_at=now(),completed_at=now(),updated_at=now(),
    outcome='All atomised child outcomes independently verified',
    result_summary='Atomised parent completed with verified descendants'
    WHERE id=parent_in RETURNING * INTO v_parent;
  INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload)
   VALUES(parent_in,'completed',v_inv.agent_id,'Verified atomised parent finalized',
     jsonb_build_object('report',report_in));
  RETURN v_parent;
END $$;

-- Defense in depth: legacy claim/verification/completion paths cannot bypass
-- child identity separation or prematurely finalize a split parent.
CREATE OR REPLACE FUNCTION public.socket_guard_task_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $$
DECLARE v_atom public.socket_atomizations; v_inv public.socket_invocations;
BEGIN
  SELECT a.* INTO v_atom FROM public.socket_atomizations a
  JOIN public.socket_atomization_children c ON c.parent_task_id=a.parent_task_id
  WHERE c.child_task_id=NEW.id;
  IF FOUND THEN
    IF NEW.status='queued' THEN
      RAISE EXCEPTION 'Socket child cannot join legacy queued claim pool';
    END IF;
    IF OLD.status='running' AND NEW.status<>'running'
      AND NEW.status IN ('waiting','completed','failed','blocked') THEN
      SELECT i.* INTO v_inv FROM public.socket_child_claim_grants g
        JOIN public.socket_invocations i ON i.id=g.invocation_id
       WHERE g.child_task_id=NEW.id AND g.claim_token=OLD.claim_token
         AND i.agent_id=OLD.claimed_by_agent_id
         AND i.session_id=OLD.claimed_session_id
         AND i.expires_at>statement_timestamp();
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Child release/submission requires the authenticated existing claim';
      END IF;
    END IF;
    -- Keep submitted children out of the legacy global verifier selector.
    -- Infinity is an unclaimed socket-specific review marker, NOT a lease.
    IF OLD.status='running' AND NEW.status='completed'
       AND NEW.verification_status='pending' AND NEW.result_submitted_at IS NOT NULL THEN
      NEW.verification_claim_expires_at:='infinity'::timestamptz;
    END IF;
    IF NEW.status='running' AND
       (OLD.status IS DISTINCT FROM 'running' OR NEW.claim_token IS DISTINCT FROM OLD.claim_token) THEN
      SELECT i.* INTO v_inv FROM public.socket_child_claim_grants g
        JOIN public.socket_invocations i ON i.id=g.invocation_id
        WHERE g.child_task_id=NEW.id AND g.claim_token=NEW.claim_token
          AND i.agent_id=NEW.claimed_by_agent_id AND i.session_id=NEW.claimed_session_id
          AND i.expires_at>statement_timestamp();
      IF NOT FOUND OR v_inv.agent_id=v_atom.authored_by_agent
          OR v_inv.session_id=v_atom.authored_in_session THEN
        RAISE EXCEPTION 'Child execution requires a fresh independent authenticated claim';
      END IF;
    END IF;
    IF NEW.verification_claim_token IS NOT NULL AND
      NEW.verification_claim_token IS DISTINCT FROM OLD.verification_claim_token THEN
      SELECT i.* INTO v_inv FROM public.socket_child_verification_grants g
       JOIN public.socket_invocations i ON i.id=g.invocation_id
       WHERE g.child_task_id=NEW.id AND g.claim_token=NEW.verification_claim_token
         AND i.agent_id=NEW.verification_claimed_by_agent_id
         AND i.expires_at>statement_timestamp();
      IF NOT FOUND OR v_inv.agent_id=v_atom.authored_by_agent
         OR v_inv.agent_id=NEW.claimed_by_agent_id THEN
        RAISE EXCEPTION 'Child verification claim must be independently authenticated';
      END IF;
    END IF;
    IF NEW.verification_status='verified' AND OLD.verification_status IS DISTINCT FROM 'verified' THEN
      SELECT i.* INTO v_inv FROM public.socket_child_verification_grants g
       JOIN public.socket_invocations i ON i.id=g.invocation_id
       WHERE g.child_task_id=NEW.id AND i.agent_id=NEW.verified_by_agent_id
         AND g.result_approved=true
         AND i.expires_at>statement_timestamp();
      -- A recursively atomised child becomes a non-leaf parent. It is verified
      -- only by finalizing its own verified descendants; the nested parent's
      -- authenticated finalization grant is equivalent to a child verifier grant.
      IF NOT FOUND AND EXISTS(SELECT 1 FROM public.socket_atomizations
          WHERE parent_task_id=NEW.id) THEN
        SELECT i.* INTO v_inv FROM public.socket_parent_finalization_grants g
         JOIN public.socket_invocations i ON i.id=g.invocation_id
         WHERE g.parent_task_id=NEW.id AND i.agent_id=NEW.verified_by_agent_id
           AND i.expires_at>statement_timestamp();
      END IF;
      IF NOT FOUND OR v_inv.agent_id=v_atom.authored_by_agent
         OR v_inv.agent_id=NEW.claimed_by_agent_id
         OR EXISTS(SELECT 1 FROM public.socket_child_claim_grants g
            JOIN public.socket_invocations executor ON executor.id=g.invocation_id
            WHERE g.child_task_id=NEW.id AND executor.agent_id=v_inv.agent_id) THEN
        RAISE EXCEPTION 'Child verification may not reuse atomiser/executor identity';
      END IF;
    END IF;
  END IF;
  SELECT * INTO v_atom FROM public.socket_atomizations WHERE parent_task_id=NEW.id;
  IF FOUND THEN
    IF NEW.status IN ('queued','running') THEN
      RAISE EXCEPTION 'Atomised parent is non-executable';
    END IF;
    IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
      SELECT i.* INTO v_inv FROM public.socket_parent_finalization_grants g
        JOIN public.socket_invocations i ON i.id=g.invocation_id
        WHERE g.parent_task_id=NEW.id AND i.agent_id=NEW.verified_by_agent_id
          AND i.expires_at>statement_timestamp();
      IF NOT FOUND OR v_inv.agent_id=v_atom.authored_by_agent THEN
        RAISE EXCEPTION 'Parent completion needs independent authenticated finalizer';
      END IF;
      IF EXISTS(SELECT 1 FROM public.socket_atomization_children c
         JOIN public.tasks t ON t.id=c.child_task_id
         WHERE c.parent_task_id=NEW.id AND
         (t.status<>'completed' OR t.verification_status<>'verified')) THEN
        RAISE EXCEPTION 'Unverified child prevents parent completion';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tasks_socket_atomization_guards ON public.tasks;
CREATE TRIGGER tasks_socket_atomization_guards
  BEFORE UPDATE OF status,claim_token,claimed_by_agent_id,claimed_session_id,
   verification_claim_token,verification_status,verified_by_agent_id
  ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.socket_guard_task_transition();

-- The service role is the trust boundary for this stage. The later MCP/gateway
-- integration registers invocation rows after authenticating real sessions;
-- user-controlled text alone is never treated as an authenticated invocation.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname IN
       ('socket_require_invocation','socket_record_usage','socket_stop_for_atomization',
        'socket_atomize_task','socket_claim_child','socket_claim_child_verification',
        'socket_verify_child','socket_finalize_parent') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',r.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
  END LOOP;
END $$;
