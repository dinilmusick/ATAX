-- Preserve append-only recovery events on the GLOBAL task claim path.
-- The earlier blocker-first migration unintentionally dropped this event while
-- changing claim priority. Restore parity with task_ledger_claim_goal_next.
-- Task selection, lease limits, fencing, authorization and priorities unchanged.
create or replace function public.task_ledger_claim_next(agent_id_in text,agent_name_in text,agent_type_in text default 'worker',capabilities_in text[] default '{}',lease_seconds_in integer default 900)
returns setof public.tasks language plpgsql set search_path to public as $$
declare candidate_id uuid; previous_status text; previous_agent_id text; previous_heartbeat timestamptz; previous_claim_token uuid; previous_heartbeat_context jsonb; previous_loop_author text; task_out public.tasks; lease_value integer:=greatest(600,least(coalesce(lease_seconds_in,600),86400)); goal_key_value text;
begin
  if nullif(btrim(agent_id_in),'') is null or nullif(btrim(agent_name_in),'') is null then raise exception 'agent identity is required'; end if;
  select t.id,t.status,t.claimed_by_agent_id,t.heartbeat_at,t.claim_token,t.heartbeat_context,t.loop_author_agent_id,g.goal_key into candidate_id,previous_status,previous_agent_id,previous_heartbeat,previous_claim_token,previous_heartbeat_context,previous_loop_author,goal_key_value
  from public.tasks t join public.goals g on g.id=t.goal_id where t.status in ('queued','running') and t.attempt_count<t.max_attempts
    and (t.status='queued' or (t.status='running' and coalesce(t.heartbeat_at,'-infinity'::timestamptz)<=now()-interval '5 minutes'))
    and t.required_capabilities<@coalesce(capabilities_in,'{}'::text[]) and not exists(select 1 from public.tasks child where child.parent_task_id=t.id)
    and (t.parent_task_id is null or not exists(select 1 from public.tasks p where p.id=t.parent_task_id and p.status in ('failed','cancelled','abandoned','blocked')))
    and g.status in ('ready','active')
    and not exists(select 1 from public.task_dependencies d join public.tasks dep on dep.id=d.depends_on_task_id where d.task_id=t.id and d.dependency_type='blocking' and (dep.status<>'completed' or dep.verification_status<>'verified'))
    and (t.task_role='loop_authoring' or (t.task_role='execution' and t.loop_script_status='ready' and (t.loop_author_agent_id is null or t.loop_author_agent_id<>agent_id_in)))
  order by coalesce(g.user_priority,0.5) desc,coalesce(t.blocker_notoriety,0) desc,t.priority asc,t.started_at asc for update skip locked limit 1;
  if candidate_id is null then return; end if;
  -- Persist the old owner's durable checkpoint evidence before fencing the claim.
  -- The task's running state and stale heartbeat were already checked under
  -- FOR UPDATE SKIP LOCKED. Never emit a recovery event for a fresh queued task.
  if previous_status='running' and previous_agent_id is not null then
    insert into public.task_events(task_id,event_type,agent_id,message,payload)
    values(
      candidate_id,'lease_recovered',agent_id_in,
      'Task reclaimed after at least five minutes without a heartbeat.',
      jsonb_build_object(
        'previous_agent_id',previous_agent_id,
        'previous_claim_token',previous_claim_token,
        'previous_heartbeat_at',previous_heartbeat,
        'previous_heartbeat_context',coalesce(previous_heartbeat_context,'{}'::jsonb),
        'recovery_reason','heartbeat_timeout',
        'recovery_threshold_minutes',5
      )
    );
  end if;
  update public.tasks set status='running',claimed_by_agent_id=agent_id_in,claimed_by_agent_name=agent_name_in,claim_token=gen_random_uuid(),claimed_at=now(),claim_expires_at=now()+make_interval(secs=>lease_value),attempt_count=attempt_count+1,heartbeat_at=now(),updated_at=now(),heartbeat_context=jsonb_build_object('activity','claimed','progress',case when task_role='loop_authoring' then 'Loop-contract authoring claimed; executor must be a different agent.' else 'Execution task claimed with blocker-first ordering.' end,'notorious_blockers',public.goal_ledger_blocker_attention(goal_key_value),'next_action',case when task_role='loop_authoring' then 'Author and validate loop contract; do not execute task.' else 'Inspect the highest-notoriety active checkpoint blocker first.' end),current_step=case when task_role='loop_authoring' then 'Authoring loop contract' else 'Claimed; inspect highest-notoriety blocker first' end where id=candidate_id returning * into task_out;
  insert into public.task_events(task_id,event_type,agent_id,message,payload) values(task_out.id,'claimed',agent_id_in,'Task claimed by worker',jsonb_build_object('lease_expires_at',task_out.claim_expires_at,'attempt_count',task_out.attempt_count,'task_role',task_out.task_role,'loop_script_status',task_out.loop_script_status,'blocker_notoriety',task_out.blocker_notoriety,'notorious_blockers',public.goal_ledger_blocker_attention(goal_key_value),'heartbeat_policy',public.task_ledger_heartbeat_policy()));
  return next task_out;
end; $$;
