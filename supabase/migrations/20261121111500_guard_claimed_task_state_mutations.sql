-- Prevent generic updates from bypassing ownership by changing task status.
-- Guard active-lease state transitions in addition to token rotation, without
-- blocking legitimate fenced RPC transitions; no historical rows rewritten.
-- The existing lease/heartbeat predicate remains in the preceding migration.

create or replace function public.atax_enforce_active_task_lease()
returns trigger language plpgsql set search_path to 'public' as $lease$
begin
  if current_user='postgres' then return new; end if;
  if old.status='running' and old.claim_token is not null
      and old.claim_expires_at>clock_timestamp()
      and new.status is distinct from old.status then
    if current_setting('atax.active_task_claim_agent',true) is distinct from old.claimed_by_agent_id
       or current_setting('atax.active_task_claim_token',true) is distinct from old.claim_token::text then
      raise exception 'active task status mutation requires matching current owner and fencing token'
        using errcode='55000';
    end if;
  end if;
  if old.status='running' and new.status='running' then
    if old.claim_expires_at is not null and old.claim_expires_at>clock_timestamp()
       and (new.claim_expires_at is null or new.claim_expires_at<old.claim_expires_at) then
      raise exception 'active task lease cannot be shortened' using errcode='55000';
    end if;
    if new.claimed_by_agent_id is distinct from old.claimed_by_agent_id
       or new.claim_token is distinct from old.claim_token then
      if old.claim_expires_at is null or old.claim_expires_at>clock_timestamp()
         or old.claim_token is null
         or coalesce(old.heartbeat_at,'-infinity'::timestamptz)>clock_timestamp()-interval '5 minutes' then
        raise exception 'active task claim cannot be replaced before expired lease and stale heartbeat' using errcode='55000';
      end if;
      if new.claimed_by_agent_id is null or new.claim_token is null
         or new.claim_token is not distinct from old.claim_token then
        raise exception 'task takeover requires a new owner and rotated fencing token' using errcode='55000';
      end if;
    end if;
  end if;
  return new;
end;
$lease$;

-- Enforce fenced updates through report_checkpoint_blocker.
CREATE OR REPLACE FUNCTION public.report_checkpoint_blocker(task_id_in uuid, checkpoint_index_in smallint, blocker_text_in text, agent_id_in text, claim_token_in uuid DEFAULT NULL::uuid, context_in jsonb DEFAULT '{}'::jsonb, evidence_in jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  t public.tasks; c jsonb; normalized text; blocker public.checkpoint_blockers;
  occurrence_inserted boolean; blocker_entry jsonb; blockers jsonb;
  promotion jsonb;
begin
  if checkpoint_index_in not between 0 and 3 then raise exception 'checkpoint index must be between 0 and 3'; end if;
  if nullif(btrim(blocker_text_in),'') is null then raise exception 'blocker text is required'; end if;
  if nullif(btrim(agent_id_in),'') is null then raise exception 'agent_id is required'; end if;
  select * into t from public.tasks where id=task_id_in for update;
  if not found then raise exception 'task not found'; end if;
  if t.execution_model <> 'bounded-v2' then raise exception 'task is not bounded-v2'; end if;
  if checkpoint_index_in >= jsonb_array_length(t.checkpoints) then raise exception 'checkpoint does not exist'; end if;
  if claim_token_in is not null and (t.claimed_by_agent_id is distinct from agent_id_in or t.claim_token is distinct from claim_token_in) then raise exception 'claim token does not fence the current task owner'; end if;

  normalized:=public.normalize_checkpoint_blocker_text(blocker_text_in);
  if normalized='' then raise exception 'blocker text normalizes to empty'; end if;

  insert into public.checkpoint_blockers(blocker_key,normalized_text,text,status)
  values('blocker-'||substr(md5(normalized),1,16),normalized,btrim(blocker_text_in),'active')
  on conflict(normalized_text) do update set text=excluded.text,status='active',last_reported_at=now(),updated_at=now(),
    resolved_at=null,resolved_by_agent_id=null,resolution=null
  returning * into blocker;

  insert into public.checkpoint_blocker_occurrences(blocker_id,task_id,checkpoint_index,agent_id,attempt_count,context,evidence)
  values(blocker.id,task_id_in,checkpoint_index_in,agent_id_in,t.attempt_count,coalesce(context_in,'{}'::jsonb),coalesce(evidence_in,'[]'::jsonb))
  on conflict(blocker_id,task_id,checkpoint_index,agent_id,attempt_count) do nothing;
  occurrence_inserted:=found;

  if occurrence_inserted then
    update public.checkpoint_blockers
    set notoriety=(select count(*)::integer from public.checkpoint_blocker_occurrences where blocker_id=blocker.id),
        last_reported_at=now(),updated_at=now()
    where id=blocker.id returning * into blocker;
  end if;

  if occurrence_inserted then
    promotion := public.promote_checkpoint_blocker_to_obstacle(
      blocker.id, task_id_in, agent_id_in, context_in, jsonb_build_object(
        'checkpoint_index', checkpoint_index_in,
        'evidence', coalesce(evidence_in,'[]'::jsonb)
      )
    );
  else
    promotion := jsonb_build_object('promoted', false, 'reason', 'duplicate_occurrence');
  end if;

  c:=t.checkpoints->checkpoint_index_in; blockers:=coalesce(c->'blockers','[]'::jsonb);
  blocker_entry:=jsonb_build_object(
    'blocker_id',blocker.id,'blocker_key',blocker.blocker_key,'text',blocker.text,
    'notoriety',blocker.notoriety,'status','active','reported_by_agent_id',agent_id_in,
    'last_reported_at',blocker.last_reported_at,'context',coalesce(context_in,'{}'::jsonb),
    'evidence',coalesce(evidence_in,'[]'::jsonb),'obstacle_promotion',promotion
  );

  if exists(select 1 from jsonb_array_elements(blockers) x where x->>'blocker_id'=blocker.id::text) then
    select coalesce(jsonb_agg(case when x->>'blocker_id'=blocker.id::text then blocker_entry else x end),'[]'::jsonb)
    into blockers from jsonb_array_elements(blockers) x;
  else
    blockers:=blockers||jsonb_build_array(blocker_entry);
  end if;

  c:=c||jsonb_build_object('blockers',blockers,'blocker_notoriety',blocker.notoriety);

  perform set_config('atax.active_task_claim_agent',agent_id_in,true);
  perform set_config('atax.active_task_claim_token',claim_token_in::text,true);
  update public.tasks
  set checkpoints=jsonb_set(t.checkpoints,array[checkpoint_index_in::text],c,false),
      blocker=blocker.text,
      blocker_notoriety=greatest(coalesce(blocker_notoriety,0),blocker.notoriety),
      status='blocked',updated_at=now(),
      heartbeat_context=coalesce(heartbeat_context,'{}'::jsonb)||
        jsonb_build_object('blocker_id',blocker.id,'blocker_key',blocker.blocker_key,
          'blocker_notoriety',blocker.notoriety,'blocked_at',now())
  where id=task_id_in;

  insert into public.task_events(task_id,event_type,agent_id,message,payload)
  values(task_id_in,'blocked',agent_id_in,
    'Checkpoint blocker recorded; task blocked until the blocker is resolved.',
    jsonb_build_object(
      'checkpoint_index',checkpoint_index_in,'blocker_id',blocker.id,'blocker_key',blocker.blocker_key,
      'notoriety',blocker.notoriety,'occurrence_inserted',occurrence_inserted,
      'obstacle_promotion',promotion
    ));

  return jsonb_build_object(
    'task_id',task_id_in,'checkpoint_index',checkpoint_index_in,'blocker_id',blocker.id,
    'blocker_key',blocker.blocker_key,'notoriety',blocker.notoriety,
    'distinct_agent_count',(select count(distinct agent_id) from public.checkpoint_blocker_occurrences where blocker_id=blocker.id),
    'notorious',blocker.notoriety>5,'obstacle_promotion',promotion,
    'occurrence_inserted',occurrence_inserted
  );
end;
$function$;

-- Enforce fenced updates through task_ledger_finalize_loop_script.
CREATE OR REPLACE FUNCTION public.task_ledger_finalize_loop_script(task_id_in uuid, agent_id_in text, claim_token_in uuid, loop_definition_in jsonb, parameter_contract_in jsonb, completion_parameters_in jsonb DEFAULT '[]'::jsonb, checkpoint_contract_in jsonb DEFAULT '{}'::jsonb)
 RETURNS tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ declare task_out public.tasks; begin if jsonb_typeof(loop_definition_in)<>'object' or loop_definition_in='{}'::jsonb then raise exception 'loop definition must be a non-empty JSON object'; end if; if jsonb_typeof(parameter_contract_in)<>'object' or parameter_contract_in='{}'::jsonb then raise exception 'parameter contract must be a non-empty JSON object'; end if; if jsonb_typeof(completion_parameters_in)<>'array' or jsonb_array_length(completion_parameters_in)>4 then raise exception 'completion parameters must be an array of at most 4 items'; end if; if jsonb_typeof(checkpoint_contract_in)<>'object' then raise exception 'checkpoint contract must be a JSON object'; end if; perform set_config('atax.active_task_claim_agent',agent_id_in,true);
  perform set_config('atax.active_task_claim_token',claim_token_in::text,true);
  update public.tasks set task_role='execution',loop_script_status='ready',loop_author_agent_id=agent_id_in,loop_author_claim_token=claim_token_in,loop_script_version=loop_script_version+1,loop_definition=loop_definition_in,parameter_contract=parameter_contract_in,completion_parameters=completion_parameters_in,metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{loop_checkpoint_contract}',checkpoint_contract_in,true),status='queued',claimed_by_agent_id=null,claimed_by_agent_name=null,claim_token=null,claimed_at=null,claim_expires_at=null,heartbeat_at=now(),heartbeat_context=jsonb_build_object('activity','loop_contract_ready','progress','Independent loop contract authored and persisted.','next_action','A different agent must execute the task.'),current_step='Loop contract ready; awaiting independent executor',updated_at=now() where id=task_id_in and claimed_by_agent_id=agent_id_in and claim_token=claim_token_in and status='running' and task_role='loop_authoring' returning * into task_out; if task_out.id is null then raise exception 'Loop-authoring claim not found, expired, or not owned by agent'; end if; insert into public.task_events(task_id,event_type,agent_id,message,payload) values(task_id_in,'note',agent_id_in,'Loop contract authored; task returned for independent execution.',jsonb_build_object('event_kind','loop_contract_ready','loop_script_version',task_out.loop_script_version,'executor_must_differ_from_author',true)); return task_out; end; $function$;

-- Enforce fenced updates through task_ledger_release_claim.
CREATE OR REPLACE FUNCTION public.task_ledger_release_claim(task_id_in uuid, agent_id_in text, claim_token_in uuid, release_status_in text DEFAULT 'queued'::text, reason_in text DEFAULT NULL::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ declare task_out public.tasks; begin if release_status_in not in ('queued','abandoned','blocked') then raise exception 'invalid release status'; end if; perform set_config('atax.active_task_claim_agent',agent_id_in,true);
  perform set_config('atax.active_task_claim_token',claim_token_in::text,true);
  update public.tasks set status=release_status_in,claimed_by_agent_id=null,claimed_by_agent_name=null,claim_token=null,claimed_at=null,claim_expires_at=null,heartbeat_at=now(),heartbeat_context=jsonb_build_object('activity','released','progress',coalesce(reason_in,'Claim released without further execution.'),'next_action',case when release_status_in='queued' then 'Return to claimable queue.' else 'Requires ledger review.' end),updated_at=now() where id=task_id_in and claimed_by_agent_id=agent_id_in and claim_token=claim_token_in and status='running' returning * into task_out; if task_out.id is null then raise exception 'Claim not found, expired, or not owned by agent'; end if; insert into public.task_events(task_id,event_type,agent_id,message,payload) values(task_id_in,'released',agent_id_in,coalesce(reason_in,'Claim released.'),jsonb_build_object('release_status',release_status_in,'claim_token',claim_token_in)); return task_out; end; $function$;

-- Enforce fenced updates through task_ledger_submit_result.
CREATE OR REPLACE FUNCTION public.task_ledger_submit_result(task_id_in uuid, agent_id_in text, claim_token_in uuid, result_in jsonb, result_summary_in text DEFAULT NULL::text, tools_used_in jsonb DEFAULT '[]'::jsonb, evidence_in jsonb DEFAULT '[]'::jsonb, status_in text DEFAULT 'completed'::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare task_out public.tasks; values_out jsonb; latest_iteration public.task_iterations;
begin
  if status_in not in ('completed','failed','blocked','waiting') then
    raise exception 'result status must be completed, failed, blocked, or waiting';
  end if;
  select * into task_out from public.tasks
  where id=task_id_in and claimed_by_agent_id=agent_id_in
    and claim_token=claim_token_in and status='running' for update;
  if not found then raise exception 'task claim not found or not owned by submitting agent'; end if;
  values_out:=coalesce(result_in->'parameter_values',task_out.parameter_values,'{}'::jsonb);
  perform public.task_ledger_validate_parameter_values(task_out.parameter_contract,values_out);
  if status_in='completed' and task_out.loop_definition->>'enabled'='true' then
    select * into latest_iteration from public.task_iterations
      where task_id=task_id_in order by iteration_no desc limit 1;
    if latest_iteration.id is null or latest_iteration.agent_id<>agent_id_in
       or latest_iteration.decision not like 'pass%'
       or jsonb_array_length(latest_iteration.evidence)=0
       or exists(select 1 from jsonb_array_elements(latest_iteration.observation->'criterionResults') c
         where c->>'status'<>'satisfied') then
      raise exception 'completed submission requires a passing task loop iteration with evidence';
    end if;
  end if;
  perform set_config('atax.active_task_claim_agent',agent_id_in,true);
  perform set_config('atax.active_task_claim_token',claim_token_in::text,true);
  update public.tasks set result=coalesce(result_in,'{}'),result_summary=result_summary_in,
    tools_used=coalesce(tools_used_in,'[]'),evidence=coalesce(evidence_in,'[]'),
    parameter_values=values_out,result_submitted_at=now(),status=status_in,
    verification_status=case when status_in='completed' then 'pending' else 'not_started' end,
    outcome=result_summary_in,heartbeat_at=now(),updated_at=now(),
    completed_at=case when status_in='completed' then now() else null end,
    claim_expires_at=null,claim_token=null
  where id=task_id_in returning * into task_out;
  insert into public.task_events(task_id,event_type,agent_id,message,payload)
  values(task_id_in,'result_submitted',agent_id_in,result_summary_in,
    jsonb_build_object('status',status_in,'result',coalesce(result_in,'{}'),
      'parameter_values',values_out,'tools_used',coalesce(tools_used_in,'[]'),
      'evidence',coalesce(evidence_in,'[]')));
  return task_out;
end;
$function$;

-- Enforce fenced updates through task_ledger_update.
CREATE OR REPLACE FUNCTION public.task_ledger_update(task_id_in uuid, agent_id_in text, status_in text DEFAULT NULL::text, current_step_in text DEFAULT NULL::text, context_summary_in text DEFAULT NULL::text, blocker_in text DEFAULT NULL::text, outcome_in text DEFAULT NULL::text, tags_in text[] DEFAULT NULL::text[], message_in text DEFAULT NULL::text, metadata_patch_in jsonb DEFAULT '{}'::jsonb)
 RETURNS tasks
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$ declare task_out public.tasks; event_out text; begin if status_in is not null and status_in not in ('queued','running','blocked','waiting','completed','failed','cancelled','abandoned') then raise exception 'Invalid task status: %',status_in; end if; if exists(select 1 from public.tasks t where t.id=task_id_in and t.agent_id=agent_id_in and t.status='running' and t.claim_token is not null) then raise exception 'fenced running task requires token-scoped RPC; legacy task_ledger_update is disallowed'; end if; update public.tasks set status=coalesce(status_in,status),heartbeat_at=now(),updated_at=now(),completed_at=case when status_in in ('completed','failed','cancelled','abandoned') then now() when status_in in ('running','blocked','waiting','queued') then null else completed_at end,current_step=coalesce(current_step_in,current_step),context_summary=coalesce(context_summary_in,context_summary),blocker=coalesce(blocker_in,blocker),outcome=coalesce(outcome_in,outcome),tags=coalesce(tags_in,tags),metadata=metadata||coalesce(metadata_patch_in,'{}'::jsonb) where id=task_id_in and agent_id=agent_id_in returning * into task_out; if task_out.id is null then raise exception 'Task not found or not owned by agent'; end if; event_out:=case when status_in='completed' then 'completed' when status_in='failed' then 'failed' when status_in='cancelled' then 'cancelled' when status_in='abandoned' then 'abandoned' when status_in='blocked' then 'blocked' when status_in='running' then 'unblocked' when tags_in is not null then 'tagged' else 'progress' end; insert into public.task_events(task_id,event_type,agent_id,message,payload) values(task_out.id,event_out,agent_id_in,message_in,jsonb_build_object('status',task_out.status,'current_step',task_out.current_step,'tags',task_out.tags,'blocker',task_out.blocker,'outcome',task_out.outcome)); return task_out; end; $function$;

