-- ATAX MCP preemptive strategic guidance.
-- Guidance is durable state: actions refresh it; ordinary MCP responses only advertise retrieval.

create table if not exists atax_private.mcp_preemptive_guidance (
  owner_subject text primary key,
  guidance jsonb not null default '{}'::jsonb,
  version bigint not null default 0,
  last_tool_name text,
  last_action_summary text,
  updated_at timestamptz not null default now(),
  constraint mcp_preemptive_guidance_owner_subject_chk check (length(trim(owner_subject)) between 3 and 200)
);

create index if not exists mcp_preemptive_guidance_updated_idx on atax_private.mcp_preemptive_guidance (updated_at desc);

create or replace function public.atax_mcp_preemptive_guidance_get_v1(owner_subject_in text)
returns jsonb language sql security definer
set search_path to pg_catalog, atax_private
as $$
  select coalesce(
    (select jsonb_build_object('owner_subject',owner_subject,'version',version,'guidance',guidance,'last_tool_name',last_tool_name,'last_action_summary',last_action_summary,'updated_at',updated_at)
       from atax_private.mcp_preemptive_guidance where owner_subject=owner_subject_in),
    jsonb_build_object('owner_subject',owner_subject_in,'version',0,
      'guidance',jsonb_build_object('message','Strategic guidance has not yet been materialized for this MCP principal.','next_steps',jsonb_build_array(
        'Resolve the applicable System and existing Vision/Goal graph.',
        'Reuse existing strategic nodes before creating new ones.',
        'Decompose substantive goals into bounded 1–4 action tasks.',
        'Claim, execute externally, submit evidence, independently verify, then reassess.'
      )),
      'last_tool_name',null,'last_action_summary',null,'updated_at',null)
  );
$$;

create or replace function public.atax_mcp_preemptive_guidance_update_v1(
  owner_subject_in text, tool_name_in text, action_summary_in text default null, context_in jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path to pg_catalog, atax_private, public
as $$
declare
  current_version bigint := 0;
  next_steps jsonb;
  message text;
  active_goals jsonb;
  guidance jsonb;
begin
  if owner_subject_in is null or length(trim(owner_subject_in)) not between 3 and 200 then raise exception 'Invalid MCP owner subject'; end if;
  select coalesce(max(version),0) into current_version from atax_private.mcp_preemptive_guidance where owner_subject=owner_subject_in;
  select coalesce(jsonb_agg(jsonb_build_object('goal_key',g.goal_key,'name',g.name,'status',g.status,'system_id',g.system_id,'user_priority',g.user_priority)
    order by g.user_priority desc nulls last,g.updated_at desc),'[]'::jsonb)
    into active_goals
    from (select goal_key,name,status,system_id,user_priority,updated_at from public.goals
          where status in ('planning','ready','active','blocked')
          order by user_priority desc nulls last,updated_at desc limit 8) g;

  message := case
    when tool_name_in in ('atax_intro_documentation','atax_context','atax_system_context','atax_goal_overview','atax_goal_get','atax_goal_resume') then 'Orient this request in the existing strategic graph before creating or claiming work.'
    when tool_name_in in ('atax_vision_create','atax_vision_add_target') then 'The strategic layer changed. Resolve its targets and attach or create the appropriate Omni goal before executing implementation work.'
    when tool_name_in in ('atax_goal_create_bounded','atax_goal_create_omni') then 'A goal now exists. Inspect dependencies and acceptance, then claim the next eligible bounded task.'
    when tool_name_in in ('atax_goal_add_dependency','atax_task_add_dependency') then 'Dependencies changed. Reassess the graph for newly unblocked work and claim only an eligible task.'
    when tool_name_in in ('atax_task_claim_next','atax_goal_claim_task','atax_task_heartbeat','atax_socket_context_pull','atax_socket_task_status') then 'Execution is in progress. Work externally, preserve the fenced socket, collect evidence, and submit rather than self-verifying.'
    when tool_name_in in ('atax_task_submit','atax_socket_output_submit') then 'A result was submitted. The next required strategic step is independent verification; do not self-certify.'
    when tool_name_in in ('atax_verification_submit','atax_goal_finalize') then 'Verification state changed. Reassess the parent Goal/Vision graph and continue the next unblocked strategic work.'
    when tool_name_in in ('atax_fmrl_create_run_dispose') then 'FMRL execution was dispatched. Poll status to terminal state and require independent cleanup verification before accepting CI evidence.'
    when tool_name_in in ('atax_fmrl_get_status') then 'FMRL status changed. If cleanup is not independently verified, treat it as a blocker; if verified, persist evidence and independently review the CI result.'
    when tool_name_in in ('atax_github_workflow_dispatch','atax_github_workflow_runs','atax_github_check_runs') then 'For private repositories, remote CI must use disposable FMRL rather than private GitHub Actions. For public repositories, ordinary workflow evidence may be used.'
    else 'Use the current graph state to determine the next strategic move; retrieve this guidance again whenever the next step is unclear.'
  end;

  next_steps := case
    when tool_name_in in ('atax_task_submit','atax_socket_output_submit') then jsonb_build_array('Claim an independent verification socket.','Verify the submitted evidence without relying on the executor.','If verified, reassess the parent Goal and its remaining dependencies.')
    when tool_name_in in ('atax_verification_submit','atax_goal_finalize') then jsonb_build_array('Re-read the parent Goal and dependency graph.','Identify the next unblocked finite task or remaining acceptance gap.','Continue execution or finalize only when independent acceptance is satisfied.')
    when tool_name_in in ('atax_fmrl_create_run_dispose','atax_fmrl_get_status') then jsonb_build_array('Poll FMRL until terminal.','Require independent 404 cleanup verification.','Persist exact CI and cleanup evidence before accepting the result.')
    when tool_name_in in ('atax_github_workflow_dispatch','atax_github_workflow_runs','atax_github_check_runs') then jsonb_build_array('Determine repository visibility before remote execution.','Use FMRL for private-target CI; never fall back to private GitHub Actions through ATAX.','Use ordinary GitHub workflow evidence only for public repositories when appropriate.')
    else jsonb_build_array('Resolve the applicable System and existing Vision/Goal graph.','Reuse existing strategic nodes; create missing Vision/Target/Goal structure only when necessary.','Decompose substantive goals into bounded 1–4 action tasks with explicit acceptance.','Claim one eligible task, execute externally, submit evidence, independently verify, then reassess.')
  end;

  guidance := jsonb_build_object('message',message,'next_steps',next_steps,'active_goals',active_goals,'context',coalesce(context_in,'{}'::jsonb),'updated_by_tool',tool_name_in);

  insert into atax_private.mcp_preemptive_guidance(owner_subject,guidance,version,last_tool_name,last_action_summary,updated_at)
  values(owner_subject_in,guidance,current_version+1,tool_name_in,left(coalesce(action_summary_in,''),4000),now())
  on conflict(owner_subject) do update set guidance=excluded.guidance,version=excluded.version,last_tool_name=excluded.last_tool_name,last_action_summary=excluded.last_action_summary,updated_at=excluded.updated_at;

  return public.atax_mcp_preemptive_guidance_get_v1(owner_subject_in);
end;
$$;

revoke all on function public.atax_mcp_preemptive_guidance_get_v1(text) from public;
revoke all on function public.atax_mcp_preemptive_guidance_update_v1(text,text,text,jsonb) from public;
grant execute on function public.atax_mcp_preemptive_guidance_get_v1(text) to service_role;
grant execute on function public.atax_mcp_preemptive_guidance_update_v1(text,text,text,jsonb) to service_role;
