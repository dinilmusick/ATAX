-- Remove the obsolete orchestrator/worker identity split from the goal-scoped
-- ChatGPT claim path. Task ownership remains fenced by the task claim token,
-- lease, session and existing transactional claim predicates.
CREATE OR REPLACE FUNCTION public.goal_ledger_claim_task(
  goal_name_in text,
  agent_id_in text,
  agent_name_in text,
  agent_type_in text DEFAULT 'worker',
  capabilities_in text[] DEFAULT '{}',
  session_id_in text DEFAULT NULL,
  lease_seconds_in integer DEFAULT 900
)
RETURNS SETOF public.tasks
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
declare
  goal_id_value uuid;
  candidate_id uuid;
  previous_status text;
  previous_agent_id text;
  previous_heartbeat timestamptz;
  previous_claim_token uuid;
  previous_heartbeat_context jsonb;
  task_out public.tasks;
  lease_value integer := greatest(30,least(coalesce(lease_seconds_in,120),120));
  goal_key_value text;
begin
  if nullif(btrim(goal_name_in),'') is null
     or nullif(btrim(agent_id_in),'') is null
     or nullif(btrim(agent_name_in),'') is null
     or nullif(btrim(session_id_in),'') is null then
    raise exception 'goal name, agent identity and unique chat session_id are required';
  end if;

  select id,goal_key
    into goal_id_value,goal_key_value
  from public.goals
  where lower(name)=lower(btrim(goal_name_in))
    and (auth.uid() is null or owner_user_id=auth.uid())
    and status in ('ready','active');

  if goal_id_value is null then
    raise exception 'goal not found or access denied: %',goal_name_in;
  end if;

  select t.id,t.status,t.claimed_by_agent_id,t.heartbeat_at,t.claim_token,t.heartbeat_context
    into candidate_id,previous_status,previous_agent_id,previous_heartbeat,previous_claim_token,previous_heartbeat_context
  from public.tasks t
  where t.goal_id=goal_id_value
    and t.status in ('queued','running')
    and t.attempt_count<t.max_attempts
    and (
      t.status='queued'
      or (
        t.status='running'
        and t.claim_expires_at is not null
        and t.claim_expires_at<=now()
        and t.claim_token is not null
        and coalesce(t.heartbeat_at,'-infinity'::timestamptz)<=now()-interval '5 minutes'
        and coalesce(t.claim_expires_at,'-infinity'::timestamptz)<=statement_timestamp()
      )
    )
    and t.required_capabilities<@coalesce(capabilities_in,'{}'::text[])
    and not exists(select 1 from public.tasks child where child.parent_task_id=t.id)
    and (t.parent_task_id is null or not exists(
      select 1 from public.tasks p
      where p.id=t.parent_task_id
        and p.status in ('failed','cancelled','abandoned','blocked')
    ))
    and not exists(
      select 1
      from public.task_dependencies d
      join public.tasks dep on dep.id=d.depends_on_task_id
      where d.task_id=t.id
        and d.dependency_type='blocking'
        and (dep.status<>'completed' or dep.verification_status<>'verified')
    )
  order by coalesce(t.blocker_notoriety,0) desc,t.priority asc,t.started_at asc
  for update skip locked
  limit 1;

  if candidate_id is null then return; end if;

  update public.tasks
  set status='running',
      claimed_by_agent_id=agent_id_in,
      claimed_by_agent_name=agent_name_in,
      claimed_session_id=session_id_in,
      claim_token=gen_random_uuid(),
      claimed_at=now(),
      claim_expires_at=now()+make_interval(secs=lease_value),
      attempt_count=attempt_count+1,
      heartbeat_at=now(),
      updated_at=now(),
      heartbeat_context=jsonb_build_object(
        'activity','claimed',
        'progress','Task claimed with blocker-first ordering.',
        'notorious_blockers',public.goal_ledger_blocker_attention(goal_key_value),
        'next_action','Inspect the highest-notoriety active checkpoint blocker before implementation.'
      ),
      current_step='Claimed; inspect highest-notoriety blocker first'
  where id=candidate_id
  returning * into task_out;

  update public.goals set status='active',updated_at=now()
  where id=goal_id_value and status='ready';

  insert into public.task_events(task_id,event_type,agent_id,message,payload)
  values(
    task_out.id,'claimed',agent_id_in,'Goal-scoped ChatGPT worker claimed task',
    jsonb_build_object(
      'goal_id',goal_id_value,
      'session_id',session_id_in,
      'lease_expires_at',task_out.claim_expires_at,
      'attempt_count',task_out.attempt_count,
      'blocker_notoriety',task_out.blocker_notoriety,
      'notorious_blockers',public.goal_ledger_blocker_attention(goal_key_value)
    )
  );

  return next task_out;
end;
$function$;

-- Rollback-only coverage is kept in persistent-goals.integration.sql.
NOTIFY pgrst,'reload schema';
