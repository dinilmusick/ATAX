-- Run with: psql -v ON_ERROR_STOP=1 -f tests/socket-ledger/socket_atomization_integration.sql
-- All fixtures and DDL rollback. Runs against a dedicated PostgreSQL test database
-- with the canonical ATAX ledger schema; do not run tests against production data.
\set ON_ERROR_STOP on
BEGIN;
\ir ../../supabase/migrations/20261122170000_socket_atomization_v1.sql
\ir ../../supabase/migrations/20261122170000_socket_atomization_v1.sql

DO $test$
DECLARE
  inv_atom public.socket_invocations; inv_same public.socket_invocations;
  inv_exec public.socket_invocations; inv_other public.socket_invocations;
  inv_ver public.socket_invocations; inv_other_atom public.socket_invocations;
  inv_author_ver public.socket_invocations;
  inv_exec_verify public.socket_invocations;
  p uuid; p_stale uuid; p_crash uuid; fence uuid:=gen_random_uuid();
  fence_stale uuid:=gen_random_uuid(); fence_crash uuid:=gen_random_uuid();
  definition jsonb; bad jsonb; outcome jsonb; split_result jsonb;
  c1 uuid; c2 uuid; nested_c1 uuid; child public.tasks; claim public.tasks;
  verification public.tasks; msg text; rejected boolean;
BEGIN
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-atomiser','test-atom-session','controller:atom','worker',now()+interval '1 hour')
    RETURNING * INTO inv_atom;
  INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
    VALUES('test-atomiser','test-atom-fresh-session','controller:atom-fresh','executor',now()+interval '1 hour')
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
  INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
    VALUES(p,50,50,80),(p_stale,50,50,80),(p_crash,50,50,80);

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

  -- Freeze, provenance, typed edges, and atomic child registration.
  split_result:=public.socket_atomize_task(p,inv_atom.id,inv_atom.secret,fence,
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

  outcome:=public.socket_atomize_task(p,inv_atom.id,inv_atom.secret,fence,
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

  -- Same invocation and same author agent across a different session both fail.
  rejected:=false;
  BEGIN
    PERFORM public.socket_claim_child(c1,inv_atom.id,inv_atom.secret);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Atomiser identity/session' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: atomiser claimed own child'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_claim_child(c1,inv_same.id,inv_same.secret);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Atomiser identity/session' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: author ID reused via new session'; END IF;

  claim:=public.socket_claim_child(c1,inv_exec.id,inv_exec.secret);
  IF claim.claim_token IS NULL OR claim.claimed_session_id<>inv_exec.session_id THEN
    RAISE EXCEPTION 'FAIL: fresh executor not recorded'; END IF;

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
    PERFORM public.task_ledger_release_claim(c1,inv_exec.agent_id,claim.claim_token,
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

  -- Result submission follows existing loop author/execute contract.
  PERFORM public.task_ledger_record_loop_iteration(c1,inv_exec.agent_id,claim.claim_token,
    1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('status','satisfied')),
    '{}'::jsonb,'[]'::jsonb,jsonb_build_array('independent-execution-evidence'),
    'pass','Ready for independent verification');
  child:=public.task_ledger_submit_result(c1,inv_exec.agent_id,claim.claim_token,
    '{}'::jsonb,'First child completed','[]'::jsonb,
    jsonb_build_array('execution-evidence'),'completed');
  IF child.verification_status<>'pending' THEN
    RAISE EXCEPTION 'FAIL: child did not enter verification queue'; END IF;
  IF child.verification_claim_expires_at IS DISTINCT FROM 'infinity'::timestamptz THEN
    RAISE EXCEPTION 'FAIL: child leaked into legacy verification queue'; END IF;

  rejected:=false;
  BEGIN
    PERFORM public.socket_claim_child_verification(c1,inv_author_ver.id,inv_author_ver.secret);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Verifier must be independent' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: author reused identity to verify'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_claim_child_verification(c1,inv_exec_verify.id,inv_exec_verify.secret);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Verifier must be independent' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: executor reused identity to verify'; END IF;

  verification:=public.socket_claim_child_verification(c1,inv_ver.id,inv_ver.secret);
  -- Even an authorized verifier identity cannot bypass the verification RPC
  -- by directly setting verified on the canonical task row.
  rejected:=false;
  BEGIN
    UPDATE public.tasks SET verification_status='verified',
      verified_by_agent_id=inv_ver.agent_id WHERE id=c1;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Child verification may not reuse' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: direct verification bypassed grant approval'; END IF;
  rejected:=false;
  BEGIN
    PERFORM public.socket_verify_child(c1,inv_ver.id,inv_ver.secret,
      gen_random_uuid(),true,jsonb_build_object('evidence',jsonb_build_array('x')));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('Verification fence' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: stale verification fence accepted'; END IF;
  child:=public.socket_verify_child(c1,inv_ver.id,inv_ver.secret,
    verification.verification_claim_token,true,
    jsonb_build_object('evidence',jsonb_build_array('first verified independently')));
  IF child.verification_status<>'verified' THEN
    RAISE EXCEPTION 'FAIL: independent verification not persisted'; END IF;

  -- Now the typed blocking edge is satisfied.
  claim:=public.socket_claim_child(c2,inv_other.id,inv_other.secret);
  PERFORM public.task_ledger_record_loop_iteration(c2,inv_other.agent_id,claim.claim_token,
    1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('status','satisfied')),
    '{}'::jsonb,'[]'::jsonb,jsonb_build_array('evidence'),
    'pass','Second child ready');
  child:=public.task_ledger_submit_result(c2,inv_other.agent_id,claim.claim_token,
    '{}'::jsonb,'Second child completed','[]'::jsonb,
    jsonb_build_array('result-evidence'),'completed');
  verification:=public.socket_claim_child_verification(c2,inv_ver.id,inv_ver.secret);
  PERFORM public.socket_verify_child(c2,inv_ver.id,inv_ver.secret,
    verification.verification_claim_token,true,
    jsonb_build_object('evidence',jsonb_build_array('second verified')));
  child:=public.socket_finalize_parent(p,inv_ver.id,inv_ver.secret,
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
  PERFORM public.socket_atomize_task(nested_c1,inv_other_atom.id,inv_other_atom.secret,
    NULL,'nested-split',definition,jsonb_build_object('partial','checkpoint'));
  IF (SELECT count(*) FROM public.socket_atomization_children
      WHERE parent_task_id=nested_c1)<>2
     OR (SELECT status FROM public.tasks WHERE id=nested_c1)<>'waiting' THEN
    RAISE EXCEPTION 'FAIL: recursive atomisation did not create waiting subtree';
  END IF;
  -- Complete the grandchildren, independently verify them, then reconcile
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
  PERFORM public.task_ledger_submit_result(c1,inv_exec.agent_id,claim.claim_token,
    '{}'::jsonb,'Nested first complete','[]'::jsonb,
    jsonb_build_array('nested-first-evidence'),'completed');
  verification:=public.socket_claim_child_verification(c1,inv_ver.id,inv_ver.secret);
  PERFORM public.socket_verify_child(c1,inv_ver.id,inv_ver.secret,
    verification.verification_claim_token,true,
    jsonb_build_object('evidence',jsonb_build_array('nested first verified')));
  claim:=public.socket_claim_child(c2,inv_other.id,inv_other.secret);
  PERFORM public.task_ledger_record_loop_iteration(c2,inv_other.agent_id,claim.claim_token,
    1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,
    jsonb_build_array(jsonb_build_object('status','satisfied')),
    '{}'::jsonb,'[]'::jsonb,jsonb_build_array('nested-second-work'),
    'pass','Nested second ready');
  PERFORM public.task_ledger_submit_result(c2,inv_other.agent_id,claim.claim_token,
    '{}'::jsonb,'Nested second complete','[]'::jsonb,
    jsonb_build_array('nested-second-evidence'),'completed');
  verification:=public.socket_claim_child_verification(c2,inv_ver.id,inv_ver.secret);
  PERFORM public.socket_verify_child(c2,inv_ver.id,inv_ver.secret,
    verification.verification_claim_token,true,
    jsonb_build_object('evidence',jsonb_build_array('nested second verified')));
  rejected:=false;
  BEGIN
    PERFORM public.socket_finalize_parent(nested_c1,inv_exec_verify.id,inv_exec_verify.secret,
      jsonb_build_object('evidence',jsonb_build_array('not independent')));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
    rejected:=position('preceding executor' IN msg)>0;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'FAIL: preceding executor verified nested parent'; END IF;
  child:=public.socket_finalize_parent(nested_c1,inv_ver.id,inv_ver.secret,
    jsonb_build_object('evidence',jsonb_build_array('grandchildren independently verified')));
  IF child.status<>'completed' OR child.verification_status<>'verified' THEN
    RAISE EXCEPTION 'FAIL: nested parent failed verified finalization';
  END IF;
  RAISE NOTICE 'PASS: replay, quota stop, stale fences, identity isolation, dependencies, verification, atomic recovery, recursive finalization';
END $test$;
ROLLBACK;