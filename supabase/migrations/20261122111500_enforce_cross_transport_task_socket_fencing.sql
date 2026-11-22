-- ATAX task-socket fencing: additive, signature-preserving corrections.
-- Each replacement must match exactly one existing function definition; the
-- entire migration aborts atomically if production drift is detected.
-- Recovery follows a strict 120-second heartbeat TTL: heartbeat every 30-60 sec;
-- each claim/renewal expires in at most 120 seconds; both age and lease gates apply.
-- All fenced executor mutations require a still-live claim token.
DO $migration$
DECLARE
  patch record;
  target_oid oid;
  before_sql text;
  after_sql text;
  candidate_old text;
BEGIN
  FOR patch IN SELECT * FROM (VALUES
    ('task_ledger_claim_next','5','coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''5 minutes''','coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''2 minutes'' and coalesce(t.claim_expires_at,''-infinity''::timestamptz)<=statement_timestamp()'),
    ('task_ledger_claim_goal_next','6','coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''5 minutes''','coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''2 minutes'' and coalesce(t.claim_expires_at,''-infinity''::timestamptz)<=statement_timestamp()'),
    ('goal_ledger_claim_task','7','coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''5 minutes''','coalesce(t.heartbeat_at,''-infinity''::timestamptz)<=now()-interval ''2 minutes'' and coalesce(t.claim_expires_at,''-infinity''::timestamptz)<=statement_timestamp()'),
    ('task_ledger_claim_next','5','greatest(600,least(coalesce(lease_seconds_in,600),86400))','greatest(30,least(coalesce(lease_seconds_in,120),120))'),
    ('task_ledger_claim_goal_next','6','greatest(600, least(coalesce(lease_seconds_in,600),86400))','greatest(30, least(coalesce(lease_seconds_in,120),120))'),
    ('goal_ledger_claim_task','7','greatest(600,least(coalesce(lease_seconds_in,600),86400))','greatest(30,least(coalesce(lease_seconds_in,120),120))'),
    ('task_ledger_heartbeat_claim','5','greatest(30,least(coalesce(lease_seconds_in,900),86400))','greatest(30,least(coalesce(lease_seconds_in,120),120))'),
    ('task_ledger_heartbeat_claim','5','greatest(3600,least(coalesce(lease_seconds_in,3600),86400))','greatest(30,least(coalesce(lease_seconds_in,120),120))'),
    ('task_ledger_heartbeat_claim','6','greatest(600,least(coalesce(lease_seconds_in,600),86400))','greatest(30,least(coalesce(lease_seconds_in,120),120))'),
    ('task_ledger_heartbeat_policy','0','''heartbeat_interval_seconds'', 120','''heartbeat_interval_seconds'', 60'),
    ('task_ledger_heartbeat_policy','0','''ownership_check_interval_seconds'', 300','''ownership_check_interval_seconds'', 60'),
    ('task_ledger_heartbeat_policy','0','''stale_heartbeat_timeout_seconds'', 300','''stale_heartbeat_timeout_seconds'', 120'),
    ('task_ledger_heartbeat_policy','0','''recovery_threshold_minutes'', 5','''recovery_threshold_minutes'', 2'),
    ('task_ledger_claim_next','5','''Task reclaimed after at least five minutes without a heartbeat.''','''Task reclaimed after at least two minutes without a heartbeat.'''),
    ('task_ledger_claim_goal_next','6','''Task reclaimed after at least 5 minutes without a heartbeat.''','''Task reclaimed after at least 2 minutes without a heartbeat.'''),
    ('task_ledger_claim_next','5','''recovery_threshold_minutes'',5','''recovery_threshold_minutes'',2'),
    ('task_ledger_claim_goal_next','6','''recovery_threshold_minutes'',5','''recovery_threshold_minutes'',2'),
    ('task_ledger_check_claim','3','and claim_token=claim_token_in','and claim_token=claim_token_in and claim_expires_at>statement_timestamp()'),
    ('task_ledger_heartbeat_claim','5','status=''running''','status=''running'' and claim_expires_at>statement_timestamp()'),
    ('task_ledger_heartbeat_claim','6','status=''running''','status=''running'' and claim_expires_at>statement_timestamp()'),
    ('task_ledger_release_claim','5','status=''running''','status=''running'' and claim_expires_at>statement_timestamp()'),
    ('task_ledger_submit_result','8','status=''running'' for update','status=''running'' and claim_expires_at>statement_timestamp() for update'),
    ('task_ledger_finalize_loop_script','7','and task_role=''loop_authoring''','and claim_expires_at>statement_timestamp() and task_role=''loop_authoring'''),
    ('task_ledger_record_iteration','11','AND claim_token=claim_token_in AND status=''running'') THEN','AND claim_token=claim_token_in AND status=''running'' AND claim_expires_at>statement_timestamp() FOR UPDATE) THEN'),
    ('task_ledger_update','10','where id=task_id_in and agent_id=agent_id_in','where id=task_id_in and agent_id=agent_id_in and claim_token is null and (claim_expires_at is null or claim_expires_at<=statement_timestamp()) and status_in is distinct from ''running'' and status_in is distinct from ''completed'''),
    ('task_ledger_heartbeat','5','and status in (''running'',''blocked'',''waiting'')','and status in (''running'',''blocked'',''waiting'') and claim_token is null and (claim_expires_at is null or claim_expires_at<=statement_timestamp())'),
    ('resolve_checkpoint_blocker','6','if not found then raise exception ''task not found''; end if;','if not found then raise exception ''task not found''; end if; if t.status=''running'' and t.claim_expires_at>statement_timestamp() then raise exception ''Active task socket cannot be requeued by blocker resolution''; end if;'),
    ('task_ledger_record_parent_loop_iteration','12','and t.status in (''queued'',''running'',''blocked'')','and t.status in (''queued'',''running'',''blocked'') and (t.status<>''running'' or (t.claim_token is null and (t.claim_expires_at is null or t.claim_expires_at<=statement_timestamp())))'),
    ('task_ledger_finalize_parent','4','where id = task_id_in
  returning * into task_out;','where id = task_id_in and (status<>''running'' or (claim_token is null and (claim_expires_at is null or claim_expires_at<=statement_timestamp())))
  returning * into task_out;'),
    ('task_ledger_claim_verification','2','where t.verification_status=''pending'' and t.result_submitted_at is not null','where t.verification_status=''pending'' and t.result_submitted_at is not null and t.claimed_by_agent_id is distinct from verifier_agent_id_in'),
('task_ledger_heartbeat_policy','0','''lease_expiry_is_recovery_gate'', false','''lease_expiry_is_recovery_gate'', true'),
    ('record_checkpoint_predicate_result','10','if t.execution_model <> ''bounded-v2'' then','if t.status=''running'' and (t.claim_token is null or t.claim_expires_at<=statement_timestamp() or t.claimed_by_agent_id is distinct from executor_id_in or t.claim_token::text is distinct from fencing_token_in) then raise exception ''Active task socket requires valid checkpoint predicate fencing''; end if;
  if t.execution_model <> ''bounded-v2'' then'),
    ('report_checkpoint_blocker','7','if t.execution_model <> ''bounded-v2'' then','if t.status=''running'' and (t.claim_token is null or t.claim_expires_at<=statement_timestamp() or t.claimed_by_agent_id is distinct from agent_id_in or t.claim_token is distinct from claim_token_in) then raise exception ''Active task socket requires valid blocker-report fencing''; end if;
  if t.execution_model <> ''bounded-v2'' then'),
    ('task_ledger_revise_definition','8','if old_task.status not in (''queued'', ''running'', ''waiting'') then','if old_task.status=''running'' and old_task.claim_expires_at>statement_timestamp() then raise exception ''Release the active socket lease before revising task definition''; end if;
  if old_task.status not in (''queued'', ''running'', ''waiting'') then'),
    ('goal_ledger_finalize','3','and not (p.status=''completed'' and p.verification_status=''verified'')','and not (p.status=''completed'' and p.verification_status=''verified'') and (p.status<>''running'' or p.claim_expires_at is null or p.claim_expires_at<=statement_timestamp())'),
    ('task_ledger_verify_result','4','where t.id=task_id_in and t.status=''completed'' and t.verification_status=''pending'';','where t.id=task_id_in and t.status=''completed'' and t.verification_status=''pending'' and (t.verification_claim_token is null or t.verification_claim_expires_at<=statement_timestamp());')
  ) AS v(function_name,arity,old_fragment,new_fragment)
  LOOP
    SELECT p.oid INTO target_oid
      FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace
        AND p.proname=patch.function_name
        AND p.pronargs=patch.arity::integer;
    IF target_oid IS NULL THEN
      RAISE EXCEPTION 'Socket-fence migration: missing function % / % arguments',
        patch.function_name,patch.arity;
    END IF;
    before_sql:=pg_get_functiondef(target_oid);
    -- Safe if this reviewed migration is replayed via both direct Supabase and CLI.
    IF strpos(before_sql,patch.new_fragment)>0 THEN CONTINUE; END IF;
    candidate_old := patch.old_fragment;
    -- Clean migrations historically used a 3,600-second five-argument heartbeat
    -- while the live schema has a 30-second bound. Both exact legacy definitions
    -- are deliberately recognized; unexpected definitions remain fail-closed.
    IF patch.function_name='task_ledger_heartbeat_claim' AND patch.arity='5'
       AND patch.old_fragment='greatest(30,least(coalesce(lease_seconds_in,900),86400))'
       AND strpos(before_sql,candidate_old)=0
       AND strpos(before_sql,'greatest(3600,least(coalesce(lease_seconds_in,3600),86400))')>0 THEN
       candidate_old := 'greatest(3600,least(coalesce(lease_seconds_in,3600),86400))';
    END IF;
    IF patch.function_name='task_ledger_update'
       AND patch.arity::integer=10
       AND strpos(before_sql,candidate_old)=0
       AND strpos(before_sql,E'where id=task_id_in and agent_id=agent_id_in\n  returning')>0
    THEN
       candidate_old := E'where id=task_id_in and agent_id=agent_id_in\n  returning';
    END IF;
    IF patch.function_name='task_ledger_heartbeat'
       AND patch.arity::integer=5
       AND strpos(before_sql,candidate_old)=0
       AND strpos(before_sql,E'and status in (''running'',''blocked'',''waiting'')\n  returning')>0
    THEN
       candidate_old := E'and status in (''running'',''blocked'',''waiting'')\n  returning';
    END IF;
    IF patch.function_name='task_ledger_finalize_parent'
       AND patch.arity::integer=4
       AND strpos(before_sql,candidate_old)=0
       AND strpos(before_sql,'where id=task_id_in returning * into task_out;')>0
    THEN
       candidate_old := 'where id=task_id_in returning * into task_out;';
    END IF;
    IF strpos(before_sql,candidate_old)=0 THEN
      -- Some installations retain the earlier five-argument heartbeat body,
      -- while the canonical isolated rebuild starts from its older migration.
      -- Both variants are explicitly recognized; unknown drift still aborts.
      IF patch.function_name='task_ledger_heartbeat_claim'
         AND patch.arity::integer=5
         AND patch.old_fragment='greatest(30,least(coalesce(lease_seconds_in,900),86400))'
         AND strpos(before_sql,'greatest(3600,least(coalesce(lease_seconds_in,3600),86400))')>0
      THEN CONTINUE; END IF;
      RAISE EXCEPTION 'Socket-fence migration drift: % / % fragment not found',
        patch.function_name,patch.arity;
    END IF;
    IF length(before_sql)-length(replace(before_sql,candidate_old,''))<>length(candidate_old) THEN
      RAISE EXCEPTION 'Socket-fence migration ambiguous target: % / %',
        patch.function_name,patch.arity;
    END IF;
    after_sql:=replace(before_sql,candidate_old,patch.new_fragment);
    EXECUTE after_sql;
  END LOOP;
END;
$migration$;
