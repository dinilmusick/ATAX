-- Run with: psql -v ON_ERROR_STOP=1 -f tests/socket-ledger/socket_atomization_integration.sql
-- All fixtures and DDL rollback. Runs against a dedicated PostgreSQL test database
-- with the canonical ATAX ledger schema; do not run tests against production data.
\set ON_ERROR_STOP on
BEGIN;
-- Synthetic fixtures still have to satisfy the real bounded-v2 invariant.
-- Record evidence-backed checkpoint predicates through the canonical RPC;
-- never set JSON status='succeeded' by bypassing the predicate trigger.
CREATE OR REPLACE FUNCTION pg_temp.socket_fixture_pass_checkpoints(
  task_in uuid, executor_in text, fence_in uuid
) RETURNS void LANGUAGE plpgsql AS $helper$
DECLARE t public.tasks; cp jsonb; n integer;
BEGIN
  SELECT * INTO t FROM public.tasks WHERE id=task_in;
  IF t.execution_model IS DISTINCT FROM 'bounded-v2' THEN RETURN; END IF;
  FOR n IN 0..jsonb_array_length(t.checkpoints)-1 LOOP
    cp:=t.checkpoints->n;
    PERFORM public.record_checkpoint_predicate_result(
      task_in,n::smallint,cp->>'predicate_key',
      coalesce((cp->>'predicate_version')::integer,t.completion_predicate_version),
      jsonb_build_object('evidence',jsonb_build_array('synthetic fixture: check passed')),
      'true'::jsonb,true,
      jsonb_build_array('synthetic fixture: independently observed expected outcome'),
      executor_in,coalesce(fence_in::text,'synthetic-parent-verification'));
  END LOOP;
END $helper$;
\ir ../../supabase/migrations/20261122170000_socket_atomization_v1.sql
\ir ../../supabase/migrations/20261122170000_socket_atomization_v1.sql

DO $test$
DECLARE
  inv_atom public.socket_invocations; inv_same public.socket_invocations;
  inv_exec public.socket_invocations; inv_other public.socket_invocations;
  inv_ver public.socket_invocations; inv_other_atom public.socket_invocations;
  inv_author_ver public.socket_invocations;
  inv_exec_verify public.socket_invocations;
  inv_unrelated_worker public.socket_invocations;
  p uuid; p_stale uuid; p_crash uuid; p_output uuid; p_total uuid;
  fence uuid:=gen_random_uuid();
  fence_stale uuid:=gen_random_uuid(); fence_crash uuid:=gen_random_uuid();
  fence_output uuid:=gen_random_uuid(); fence_total uuid:=gen_random_uuid();
  definition jsonb; bad jsonb; outcome jsonb; split_result jsonb;
  c1 uuid; c2 uuid; nested_c1 uuid; child public.tasks; claim public.tasks;
  verification public.tasks; msg text; rejected boolean;
BEGIN
  -- The socket tables and RPCs are server-only. A publishable/anon role must
  -- never read invocation secrets or call the control-plane primitives.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname LIKE 'socket_%'
      AND c.relkind IN ('r','p') AND NOT c.relrowsecurity
  ) THEN RAISE EXCEPTION 'FAIL: socket table missing row-level security'; END IF;
  IF has_table_privilege('anon','public.socket_invocations','SELECT')
     OR has_table_privilege('authenticated','public.socket_invocations','SELECT')
     OR has_table_privilege('anon','public.socket_usage_events','INSERT')
     OR has_function_privilege('anon',
       'public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.socket_record_usage(uuid,uuid,uuid,uuid,uuid,text,bigint,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.socket_atomize_task(uuid,uuid,uuid,uuid,text,jsonb,jsonb)','EXECUTE')
  THEN RAISE EXCEPTION 'FAIL: socket control-plane privileges leaked'; END IF;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-atomiser','test-atom-session','controller:atom','worker',now()+interval '1 hour')
    RETURNING * INTO inv_atom;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-atomiser','test-atom-fresh-session','controller:atom-fresh','worker',now()+interval '1 hour')
    RETURNING * INTO inv_same;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-executor','test-exec-session','controller:exec','executor',now()+interval '1 hour')
    RETURNING * INTO inv_exec;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-other-executor','test-other-session','controller:other','executor',now()+interval '1 hour')
    RETURNING * INTO inv_other;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-verifier','test-verify-session','controller:verify','verifier',now()+interval '1 hour')
    RETURNING * INTO inv_ver;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-secondary-atomiser','test-atom2-session','controller:atom2','atomizer',now()+interval '1 hour')
    RETURNING * INTO inv_other_atom;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-atomiser','test-atom-verifier-session','controller:atomver','verifier',now()+interval '1 hour')
    RETURNING * INTO inv_author_ver;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-executor','test-exec-verifier-session','controller:execver','verifier',now()+interval '1 hour')
    RETURNING * INTO inv_exec_verify;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-unrelated-worker','test-unrelated-worker-session','controller:unrelated','worker',now()+interval '1 hour')
    RETURNING * INTO inv_unrelated_worker;

  definition:=jsonb_build_array(
    jsonb_build_object('name','Socket child one','description','Produce a typed artifact',
      'actions',jsonb_build_array(jsonb_build_object('description','Create artifact')),
      'inputs',jsonb_build_object('seed','text'),
      'outputs',jsonb_build_object('artifact','text'),'outcome','Artifact verified',
      'acceptance_criteria',jsonb_build_array(jsonb_build_object('description','Artifact exists')),
      'verification',jsonb_build_object('method','independent-evidence'),
      'loop',jsonb_build_object('enabled',true,'objective','Produce artifact','max_iterations',2)),
    jsonb_build_object('name','Socket child two','description','Consume typed artifact',
      'actions',jsonb_build_array(jsonb_build_object('description','Consume artifact')),
      'inputs',jsonb_build_object('artifact','text'),
      'outputs',jsonb_build_object('result','text'),'outcome','Consumption verified',
      'acceptance_criteria',jsonb_build_array(jsonb_build_object('description','Result exists')),
      'verification',jsonb_build_object('method','independent-evidence'),
      'loop',jsonb_build_object('enabled',true,'objective','Consume artifact','max_iterations',2),
      'dependencies',jsonb_build_array(jsonb_build_object(
        'child_index',1,'type','blocking','from_output','artifact','to_input','artifact')))
  );

  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,claimed_by_agent_id,
    claimed_by_agent_name,claimed_session_id,claim_token,claim_expires_at,task_definition)
  VALUES('test-origin','test-origin','Socket parent one','running','test-atomiser',
    'test-atomiser','test-atom-session',fence,now()+interval '1 hour',
    jsonb_build_object('name','Socket parent one','general_pattern','read → split → verify',
      'actions',jsonb_build_array(jsonb_build_object('description','Carry work'))))
  RETURNING id INTO p;
  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,claimed_by_agent_id,
    claimed_by_agent_name,claimed_session_id,claim_token,claim_expires_at,task_definition)
  VALUES('test-origin','test-origin','Socket parent stale','running','test-atomiser',
    'test-atomiser','test-atom-session',fence_stale,now()+interval '1 hour',
    jsonb_build_object('name','Socket parent stale','general_pattern','read → split → verify',
      'actions',jsonb_build_array(jsonb_build_object('description','Carry work'))))
  RETURNING id INTO p_stale;
  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,claimed_by_agent_id,
    claimed_by_agent_name,claimed_session_id,claim_token,claim_expires_at,task_definition)
  VALUES('test-origin','test-origin','Socket parent crash','running','test-atomiser',
    'test-atomiser','test-atom-session',fence_crash,now()+interval '1 hour',
    jsonb_build_object('name','Socket parent crash','general_pattern','read → split → verify',
      'actions',jsonb_build_array(jsonb_build_object('description','Carry work'))))
  RETURNING id INTO p_crash;
  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,claimed_by_agent_id,
    claimed_by_agent_name,claimed_session_id,claim_token,claim_expires_at,task_definition)
  VALUES('test-origin','test-origin','Socket output budget','running','test-atomiser',
    'test-atomiser','test-atom-session',fence_output,now()+interval '1 hour',
    jsonb_build_object('name','Socket output budget','general_pattern','output → stop → split',
      'actions',jsonb_build_array(jsonb_build_object('description','Emit tokens'))))
  RETURNING id INTO p_output;
  INSERT INTO public.tasks(agent_id,agent_name,task_name,status,claimed_by_agent_id,
    claimed_by_agent_name,claimed_session_id,claim_token,claim_expires_at,task_definition)
  VALUES('test-origin','test-origin','Socket combined budget','running','test-atomiser',
    'test-atomiser','test-atom-session',fence_total,now()+interval '1 hour',
    jsonb_build_object('name','Socket combined budget','general_pattern','input → output → stop',
      'actions',jsonb_build_array(jsonb_build_object('description','Consume combined tokens'))))
  RETURNING id INTO p_total;
  INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
    VALUES(p,50,50,80),(p_stale,50,50,80),(p_crash,50,50,80),
      (p_output,50,20,120),(p_total,40,40,60);

  -- Output-only and aggregate thresholds are enforced separately.
  outcome:=public.socket_record_usage(p_output,inv_atom.id,inv_atom.secret,
    fence_output,gen_random_uuid(),'output',21);
  IF NOT (outcome->>'needs_atomization')::boolean OR
     (SELECT status FROM public.tasks WHERE id=p_output)<>'waiting' THEN
    RAISE EXCEPTION 'FAIL: output ceiling did not stop work';
  END IF;
  PERFORM public.socket_record_usage(p_total,inv_atom.id,inv_atom.secret,
    fence_total,gen_random_uuid(),'input',35);
  outcome:=public.socket_record_usage(p_total,inv_atom.id,inv_atom.secret,
    fence_total,gen_random_uuid(),'output',30);
  IF NOT (outcome->>'needs_atomization')::boolean OR
     (SELECT status FROM public.tasks WHERE id=p_total)<>'waiting' THEN
    RAISE EXCEPTION 'FAIL: aggregate ceiling did not stop work';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.socket_overflow_reports o
    WHERE o.task_id=p_total AND o.usage_snapshot->>'limit_total'='60') THEN
    RAISE EXCEPTION 'FAIL: combined overflow snapshot missing';
  END IF;
  -- Authenticated invocation credentials cannot be replaced with arbitrary
  -- identities or secrets supplied in client-controlled payloads.
  rejected:=false;
  BEGIN
    PERFORM public.socket_require_invocation(inv_exec.id,gen_random_uuid(),ARRAY['executor']);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Socket invocation missing, expired, or unauthorized' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: invalid invocation credential accepted'; END IF;
  -- The agent ID alone is insufficient: a later session cannot reuse an old
  -- invocation's fenced claim, even with the correct token.
  rejected:=false;
  BEGIN
    PERFORM public.socket_record_usage(p_stale,inv_same.id,inv_same.secret,
      fence_stale,gen_random_uuid(),'input',1);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Stale or foreign socket lease' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: same agent ID inherited usage fence across sessions'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_stop_for_atomization(p_stale,inv_same.id,inv_same.secret,
      fence_stale,'different-session-stop');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Stale or foreign socket lease' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: same agent ID stopped another session'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_atomize_task(p_stale,inv_same.id,inv_same.secret,
      fence_stale,'different-session-split',definition);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Stale or foreign split fence' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: same agent ID split another session'; END IF;
  -- Stale fence must fail without charging usage.
  rejected:=false;
  BEGIN
    PERFORM public.socket_record_usage(p_stale,inv_atom.id,inv_atom.secret,
      gen_random_uuid(),gen_random_uuid(),'input',5);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Stale or foreign socket lease' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: stale usage fence accepted'; END IF;
  IF EXISTS(SELECT 1 FROM public.socket_usage_events WHERE task_id=p_stale) THEN
    RAISE EXCEPTION 'FAIL: stale usage mutated events';
  END IF;
  -- A new authorized atomizer must inherit the durable progress from the
  -- original stopping invocation if no replacement progress is supplied.
  PERFORM public.socket_stop_for_atomization(p_stale,inv_atom.id,inv_atom.secret,
    fence_stale,'scope-recovery',
    jsonb_build_object('checkpoint','partial-progress-from-previous-invocation'));
  PERFORM public.socket_atomize_task(p_stale,inv_other_atom.id,inv_other_atom.secret,
    fence_stale,'separate-atomizer-split',definition);
  IF NOT EXISTS(SELECT 1 FROM public.socket_atomizations a WHERE a.parent_task_id=p_stale
      AND a.partial_progress->>'checkpoint'='partial-progress-from-previous-invocation') THEN
    RAISE EXCEPTION 'FAIL: atomizer dropped preserved stop checkpoint'; END IF;

  -- An exact duplicate event is a retry; a separate event is new usage.
  outcome:=public.socket_record_usage(p,inv_atom.id,inv_atom.secret,fence,
    '00000000-0000-4000-8000-000000000101','input',30,'chunk-1');
  IF (outcome->>'needs_atomization')::boolean THEN
    RAISE EXCEPTION 'FAIL: early overrun'; END IF;
  outcome:=public.socket_record_usage(p,inv_atom.id,inv_atom.secret,fence,
    '00000000-0000-4000-8000-000000000101','input',30,'chunk-1');
  IF NOT (outcome->>'duplicate')::boolean THEN
    RAISE EXCEPTION 'FAIL: usage replay not idempotent'; END IF;
  outcome:=public.socket_record_usage(p,inv_atom.id,inv_atom.secret,fence,
    '00000000-0000-4000-8000-000000000102','input',25,'chunk-2',
    jsonb_build_object('checkpoint','partial output saved'));
  IF NOT (outcome->>'needs_atomization')::boolean THEN
    RAISE EXCEPTION 'FAIL: budget overrun not detected'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=p AND status='waiting'
       AND claim_token IS NULL AND current_step='Needs atomisation') THEN
    RAISE EXCEPTION 'FAIL: overflow did not stop and release parent'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.socket_overflow_reports
    WHERE task_id=p AND reason='budget'
      AND partial_progress->>'checkpoint'='partial output saved') THEN
    RAISE EXCEPTION 'FAIL: overflow lost partial progress'; END IF;
  outcome:=public.socket_record_usage(p,inv_atom.id,inv_atom.secret,fence,
    '00000000-0000-4000-8000-000000000102','input',25,'chunk-2',
    jsonb_build_object('checkpoint','partial output saved'));
  IF NOT (outcome->>'duplicate')::boolean THEN
    RAISE EXCEPTION 'FAIL: overflow event retry not idempotent'; END IF;

  -- Contradictory replays with the same usage key are explicitly rejected.
  rejected:=false;
  BEGIN
    PERFORM public.socket_record_usage(p,inv_atom.id,inv_atom.secret,fence,
      '00000000-0000-4000-8000-000000000102','input',26,'chunk-2');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Usage event key reused with conflicting data' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: mutated usage replay accepted'; END IF;
  IF EXISTS(SELECT 1 FROM public.socket_task_budgets
    WHERE task_id=p AND (input_used<>55 OR output_used<>0 OR version<>1)) THEN
    RAISE EXCEPTION 'FAIL: replay changed the versioned budget counters';
  END IF;
  -- A stopped parent can never be split with a stale fence.
  rejected:=false;
  BEGIN
    PERFORM public.socket_atomize_task(p,inv_other_atom.id,inv_other_atom.secret,
      gen_random_uuid(),'stale-stopped-split',definition);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('original fenced overflow report' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: stale stopped-parent fence accepted'; END IF;
  -- Attempt to raise the child's input budget by one token above the parent.
  -- The database must reject the entire split before any child or atomization
  -- row is committed.
  bad:=jsonb_set(definition,'{0,budget}',jsonb_build_object('input',51),true);
  rejected:=false;
  BEGIN
    PERFORM public.socket_atomize_task(p,inv_unrelated_worker.id,inv_unrelated_worker.secret,
      fence,'budget-escalation-attempt',bad,jsonb_build_object('checkpoint','must-rollback'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('budget exceeds or invalidates its parent budget' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: child budget escalation was accepted'; END IF;
  IF EXISTS(SELECT 1 FROM public.socket_atomizations WHERE parent_task_id=p)
     OR EXISTS(SELECT 1 FROM public.socket_atomization_children WHERE parent_task_id=p) THEN
    RAISE EXCEPTION 'FAIL: rejected child budget escalation left partial atomization state';
  END IF;

  -- Any authenticated invocation holding the original overflow fence may
  -- atomise the stopped parent; author/worker identity is not an eligibility gate.

  -- Freeze, provenance, typed edges, and atomic child registration.
  split_result:=public.socket_atomize_task(p,inv_unrelated_worker.id,inv_unrelated_worker.secret,fence,
    'test-split-key',definition,jsonb_build_object('checkpoint','persisted'));
  IF (split_result->>'duplicate')::boolean THEN RAISE EXCEPTION 'FAIL: first split duplicate'; END IF;
  IF (SELECT count(*) FROM public.socket_atomization_children WHERE parent_task_id=p)<>2 THEN
    RAISE EXCEPTION 'FAIL: child count incorrect'; END IF;
  SELECT child_task_id INTO c1 FROM public.socket_atomization_children
    WHERE parent_task_id=p AND ordinal=1;
  SELECT child_task_id INTO c2 FROM public.socket_atomization_children
    WHERE parent_task_id=p AND ordinal=2;
  IF NOT EXISTS(SELECT 1 FROM public.socket_atomization_edges
      WHERE source_task_id=c1 AND target_task_id=c2 AND source_output='artifact'
      AND target_input='artifact' AND dependency_type='blocking') THEN
    RAISE EXCEPTION 'FAIL: typed edge not recorded'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.task_dependencies
      WHERE depends_on_task_id=c1 AND task_id=c2 AND dependency_type='blocking') THEN
    RAISE EXCEPTION 'FAIL: canonical blocking dependency not recorded'; END IF;
  IF EXISTS(SELECT 1 FROM public.tasks WHERE id IN (c1,c2) AND status<>'waiting') THEN
    RAISE EXCEPTION 'FAIL: children leaked into legacy queued pool'; END IF;

  -- A second invocation/session can safely replay the exact same fenced split.
  outcome:=public.socket_atomize_task(p,inv_same.id,inv_same.secret,fence,
    'test-split-key',definition);
  IF NOT (outcome->>'duplicate')::boolean OR
    (SELECT count(*) FROM public.socket_atomization_children WHERE parent_task_id=p)<>2 THEN
    RAISE EXCEPTION 'FAIL: split retry duplicated children'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_atomize_task(p,inv_atom.id,inv_atom.secret,fence,
      'conflicting-key',definition);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('already atomised' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: conflicting split accepted'; END IF;

  -- Parent is not executable, even through a legacy direct claim mutation.
  rejected:=false;
  BEGIN
    UPDATE public.tasks SET status='running',claim_token=gen_random_uuid(),
      claimed_by_agent_id='test-other-executor' WHERE id=p;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('non-executable' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: atomized parent reactivated'; END IF;

  -- Parent cannot finalize when even one child is unverified.
  rejected:=false;
  BEGIN
    PERFORM public.socket_finalize_parent(p,inv_ver.id,inv_ver.secret,
      jsonb_build_object('evidence',jsonb_build_array('parent-check')));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('before all children' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: parent finalized prematurely'; END IF;

  -- The same invocation that atomised the parent may claim its child.
  claim:=public.socket_claim_child(c1,inv_unrelated_worker.id,inv_unrelated_worker.secret);
  IF claim.claim_token IS NULL OR claim.claimed_session_id<>inv_unrelated_worker.session_id THEN
    RAISE EXCEPTION 'FAIL: same-principal child claim not recorded'; END IF;

  -- Competing holder cannot take an occupied socket; no lease token rotation.
  rejected:=false;
  BEGIN
    PERFORM public.socket_claim_child(c1,inv_other.id,inv_other.secret);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('not available' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: competing executor claimed child'; END IF;
  IF (SELECT claim_token FROM public.tasks WHERE id=c1)<>claim.claim_token THEN
    RAISE EXCEPTION 'FAIL: competing claim rotated active fence'; END IF;
  -- A legacy release-to-queued cannot make socket work globally claimable.
  rejected:=false;
  BEGIN
    PERFORM public.task_ledger_release_claim(c1,inv_unrelated_worker.agent_id,claim.claim_token,
      'queued','Legacy release attempt');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Socket child cannot join legacy queued claim pool' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: legacy release leaked child to queue'; END IF;

  -- Legacy direct claim on sibling is fenced by the database trigger.
  rejected:=false;
  BEGIN
    UPDATE public.tasks SET status='running',claim_token=gen_random_uuid(),
      claimed_by_agent_id='legacy-caller',claimed_session_id='legacy-session'
      WHERE id=c2;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('fresh independent authenticated claim' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: legacy child claim bypassed guard'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_claim_child(c2,inv_other.id,inv_other.secret);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('unverified blocking dependencies' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: unverified dependency ignored'; END IF;

  -- Result submission follows the persisted loop and evidence contract.
  PERFORM public.task_ledger_record_loop_iteration(c1,inv_unrelated_worker.agent_id,claim.claim_token,
    1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('status','satisfied')),
    '{}'::jsonb,'[]'::jsonb,jsonb_build_array('independent-execution-evidence'),
    'pass','Ready for independent verification');
  PERFORM pg_temp.socket_fixture_pass_checkpoints(c1,inv_unrelated_worker.agent_id,claim.claim_token);
  child:=public.task_ledger_submit_result(c1,inv_unrelated_worker.agent_id,claim.claim_token,
    '{}'::jsonb,'First child completed','[]'::jsonb,
    jsonb_build_array('execution-evidence'),'completed');
  IF child.verification_status<>'pending' THEN
    RAISE EXCEPTION 'FAIL: child did not enter verification queue'; END IF;
  IF child.verification_claim_expires_at IS DISTINCT FROM 'infinity'::timestamptz THEN
    RAISE EXCEPTION 'FAIL: child leaked into legacy verification queue'; END IF;

  -- The same caller may claim verification. Direct promotion still fails
  -- until this invocation's fenced verification grant is explicitly approved.
  verification:=public.socket_claim_child_verification(c1,inv_unrelated_worker.id,inv_unrelated_worker.secret);
  rejected:=false;
  BEGIN
    UPDATE public.tasks SET verification_status='verified',
      verified_by_agent_id=inv_unrelated_worker.agent_id WHERE id=c1;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Child verification requires an approved evidence grant' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: direct verification bypassed grant approval'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_verify_child(c1,inv_unrelated_worker.id,inv_unrelated_worker.secret,
      gen_random_uuid(),true,jsonb_build_object('evidence',jsonb_build_array('x')));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Verification fence' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: stale verification fence accepted'; END IF;
  child:=public.socket_verify_child(c1,inv_unrelated_worker.id,inv_unrelated_worker.secret,
    verification.verification_claim_token,true,
    jsonb_build_object('evidence',jsonb_build_array('first verified with the evidence gate')));
  IF child.verification_status<>'verified' THEN
    RAISE EXCEPTION 'FAIL: independent verification not persisted'; END IF;

  -- Now the typed blocking edge is satisfied.
  claim:=public.socket_claim_child(c2,inv_unrelated_worker.id,inv_unrelated_worker.secret);
  PERFORM public.task_ledger_record_loop_iteration(c2,inv_unrelated_worker.agent_id,claim.claim_token,
    1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('status','satisfied')),
    '{}'::jsonb,'[]'::jsonb,jsonb_build_array('evidence'),
    'pass','Second child ready');
  PERFORM pg_temp.socket_fixture_pass_checkpoints(c2,inv_unrelated_worker.agent_id,claim.claim_token);
  child:=public.task_ledger_submit_result(c2,inv_unrelated_worker.agent_id,claim.claim_token,
    '{}'::jsonb,'Second child completed under the atomizer principal','[]'::jsonb,
    jsonb_build_array('result-evidence'),'completed');
  verification:=public.socket_claim_child_verification(c2,inv_unrelated_worker.id,inv_unrelated_worker.secret);
  PERFORM public.socket_verify_child(c2,inv_unrelated_worker.id,inv_unrelated_worker.secret,
    verification.verification_claim_token,true,
    jsonb_build_object('evidence',jsonb_build_array('second verified')));
  child:=public.socket_finalize_parent(p,inv_unrelated_worker.id,inv_unrelated_worker.secret,
    jsonb_build_object('evidence',jsonb_build_array('both descendants verified')));
  IF child.status<>'completed' OR child.verification_status<>'verified' THEN
    RAISE EXCEPTION 'FAIL: verified parent did not finalize'; END IF;

  -- A failed split rolls back its parent STOP as well as all child inserts.
  bad:=jsonb_set(definition,'{1,actions}','[]'::jsonb);
  rejected:=false;
  BEGIN
    PERFORM public.socket_atomize_task(p_crash,inv_atom.id,inv_atom.secret,
      fence_crash,'bad-spec',bad);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Child 2 requires' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: invalid split unexpectedly succeeded'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=p_crash
      AND status='running' AND claim_token=fence_crash)
     OR EXISTS(SELECT 1 FROM public.socket_atomizations WHERE parent_task_id=p_crash)
     OR EXISTS(SELECT 1 FROM public.socket_overflow_reports WHERE task_id=p_crash) THEN
    RAISE EXCEPTION 'FAIL: crash left partial durable state'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_atomize_task(p_crash,inv_atom.id,inv_atom.secret,
      gen_random_uuid(),'stale-split',definition);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Stale or foreign split fence' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: stale split fence accepted'; END IF;
  PERFORM public.socket_atomize_task(p_crash,inv_atom.id,inv_atom.secret,
    fence_crash,'recovered-split',definition);

  -- Recursive scope overflow creates real grandchildren; a blocked ancestor
  -- remains nonterminal until every descendant has a verified outcome.
  SELECT child_task_id INTO nested_c1 FROM public.socket_atomization_children
    WHERE parent_task_id=p_crash AND ordinal=1;
  claim:=public.socket_claim_child(nested_c1,inv_exec.id,inv_exec.secret);
  PERFORM public.socket_stop_for_atomization(nested_c1,inv_exec.id,inv_exec.secret,
    claim.claim_token,'recursive-scope',jsonb_build_object('partial','checkpoint'));
  -- The same authenticated executor may author the recursive split.
  PERFORM public.socket_atomize_task(nested_c1,inv_exec.id,inv_exec.secret,
    claim.claim_token,'nested-split',definition,jsonb_build_object('partial','checkpoint'));
  IF (SELECT count(*) FROM public.socket_atomization_children
      WHERE parent_task_id=nested_c1)<>2
     OR (SELECT status FROM public.tasks WHERE id=nested_c1)<>'waiting' THEN
    RAISE EXCEPTION 'FAIL: recursive atomisation did not create waiting subtree';
  END IF;
  -- Complete the grandchildren, evidence-verify them, then reconcile
  -- the nested child as an independently verified ancestor leaf outcome.
  SELECT child_task_id INTO c1 FROM public.socket_atomization_children
    WHERE parent_task_id=nested_c1 AND ordinal=1;
  SELECT child_task_id INTO c2 FROM public.socket_atomization_children
    WHERE parent_task_id=nested_c1 AND ordinal=2;
  claim:=public.socket_claim_child(c1,inv_exec.id,inv_exec.secret);
  PERFORM public.task_ledger_record_loop_iteration(c1,inv_exec.agent_id,claim.claim_token,
    1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('status','satisfied')),
    '{}'::jsonb,'[]'::jsonb,jsonb_build_array('nested-first-work'),
    'pass','Nested first ready');
  PERFORM pg_temp.socket_fixture_pass_checkpoints(c1,inv_exec.agent_id,claim.claim_token);
  PERFORM public.task_ledger_submit_result(c1,inv_exec.agent_id,claim.claim_token,
    '{}'::jsonb,'Nested first complete','[]'::jsonb,
    jsonb_build_array('nested-first-evidence'),'completed');
  verification:=public.socket_claim_child_verification(c1,inv_exec.id,inv_exec.secret);
  PERFORM public.socket_verify_child(c1,inv_exec.id,inv_exec.secret,
    verification.verification_claim_token,true,
    jsonb_build_object('evidence',jsonb_build_array('nested first verified')));
  claim:=public.socket_claim_child(c2,inv_exec.id,inv_exec.secret);
  PERFORM public.task_ledger_record_loop_iteration(c2,inv_exec.agent_id,claim.claim_token,
    1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('status','satisfied')),
    '{}'::jsonb,'[]'::jsonb,jsonb_build_array('nested-second-work'),
    'pass','Nested second ready');
  PERFORM pg_temp.socket_fixture_pass_checkpoints(c2,inv_exec.agent_id,claim.claim_token);
  PERFORM public.task_ledger_submit_result(c2,inv_exec.agent_id,claim.claim_token,
    '{}'::jsonb,'Nested second complete','[]'::jsonb,
    jsonb_build_array('nested-second-evidence'),'completed');
  verification:=public.socket_claim_child_verification(c2,inv_exec.id,inv_exec.secret);
  PERFORM public.socket_verify_child(c2,inv_exec.id,inv_exec.secret,
    verification.verification_claim_token,true,
    jsonb_build_object('evidence',jsonb_build_array('nested second verified')));
  -- The same caller that atomised and executed both descendants may finalize
  -- the parent once every descendant has passed evidence verification.
  PERFORM pg_temp.socket_fixture_pass_checkpoints(nested_c1,inv_exec.agent_id,NULL);
  child:=public.socket_finalize_parent(nested_c1,inv_exec.id,inv_exec.secret,
    jsonb_build_object('evidence',jsonb_build_array('grandchildren verified by same principal')));
  IF child.status<>'completed' OR child.verification_status<>'verified' THEN
    RAISE EXCEPTION 'FAIL: nested parent failed verified finalization';
  END IF;
  -- A verifier's negative decision does not grant authorization to directly
  -- rewrite the result as verified.
  SELECT child_task_id INTO c2 FROM public.socket_atomization_children
    WHERE parent_task_id=p_crash AND ordinal=2;
  claim:=public.socket_claim_child(c2,inv_other.id,inv_other.secret);
  PERFORM public.task_ledger_record_loop_iteration(c2,inv_other.agent_id,claim.claim_token,
    1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('status','satisfied')),
    '{}'::jsonb,'[]'::jsonb,jsonb_build_array('execution-evidence'),
    'pass','Awaiting independent result');
  PERFORM pg_temp.socket_fixture_pass_checkpoints(c2,inv_other.agent_id,claim.claim_token);
  PERFORM public.task_ledger_submit_result(c2,inv_other.agent_id,claim.claim_token,
    '{}'::jsonb,'Result awaiting review','[]'::jsonb,
    jsonb_build_array('negative-test-result'),'completed');
  verification:=public.socket_claim_child_verification(c2,inv_other.id,inv_other.secret);
  PERFORM public.socket_verify_child(c2,inv_other.id,inv_other.secret,
    verification.verification_claim_token,false,
    jsonb_build_object('reason','Negative test outcome'));
  rejected:=false;
  BEGIN
    UPDATE public.tasks SET verification_status='verified',
      verified_by_agent_id=inv_other.agent_id WHERE id=c2;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Child verification requires an approved evidence grant' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: negative verdict improperly approved direct promotion'; END IF;
  RAISE NOTICE 'PASS: replay, quota stop, stale fences, same-principal atomise/execute/verify/finalize, dependencies, atomic recovery, recursive finalization and negative-verdict fencing';
END $test$;
ROLLBACK;