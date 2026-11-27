-- Strategic preemptive guidance for ATAX MCP.
-- Guidance is durable state, refreshed after tool actions, and fetched explicitly.
-- It is intentionally not included in ordinary tool responses.

create table if not exists atax_private.mcp_preemptive_guidance (
  owner_subject text primary key,
  guidance jsonb not null default '{}'::jsonb,
  last_tool text,
  last_action_at timestamptz,
  updated_at timestamptz not null default now()
);

revoke all on table atax_private.mcp_preemptive_guidance from public, anon, authenticated;

create or replace function public.atax_mcp_preemptive_guidance_update_v1(
  owner_subject_in text,
  tool_name_in text,
  action_summary_in text default null,
  context_in jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  configured_owner text;
  next_steps jsonb;
  guidance jsonb;
begin
  configured_owner := atax_private.instance_owner_subject_v1();

  if owner_subject_in is null
     or owner_subject_in is distinct from configured_owner then
    raise exception 'ATAX guidance owner authorization failed';
  end if;

  if tool_name_in is null
     or length(tool_name_in) not between 1 and 160 then
    raise exception 'Invalid ATAX guidance tool name';
  end if;

  next_steps :=
    case
      when tool_name_in in ('atax_context','atax_system_context','atax_goal_overview','atax_goal_get','atax_goal_resume')
        then jsonb_build_array(
          jsonb_build_object('id','resolve-strategy','title','Resolve the current request against the existing System → Vision → Goal → Task graph','action','Inspect existing strategic structure before creating duplicate work.'),
          jsonb_build_object('id','retrieve-guidance','title','Retrieve current preemptive guidance when planning the next step','action','Call atax_preemptive_guidance_get only when strategic guidance is needed.')
        )
      when tool_name_in in ('atax_vision_create','atax_vision_add_target','atax_goal_create_bounded','atax_goal_create_omni')
        then jsonb_build_array(
          jsonb_build_object('id','connect-strategy','title','Connect the new planning node to the existing strategic graph','action','Add the appropriate target and goal dependencies before execution.'),
          jsonb_build_object('id','decompose','title','Decompose the goal into bounded 1–4 action tasks','action','Keep tasks finite and independently verifiable.')
        )
      when tool_name_in in ('atax_task_submit','atax_verification_claim','atax_verification_claim_for_task','atax_goal_finalize')
        then jsonb_build_array(
          jsonb_build_object('id','verify','title','Continue through independent verification','action','Never self-verify terminal work.'),
          jsonb_build_object('id','reassess','title','Reassess the strategic graph after verification','action','Retrieve guidance if the completed work changes what should happen next.')
        )
      when tool_name_in like 'atax_fmrl_%' or tool_name_in like 'atax_github_%'
        then jsonb_build_array(
          jsonb_build_object('id','private-ci','title','Prefer FMRL for private-repository remote CI','action','Use local/container execution when appropriate, but do not consume private-repository GitHub Actions quota when FMRL is suitable.'),
          jsonb_build_object('id','cleanup','title','Verify disposable FMRL cleanup','action','Poll status until execution and independent 404 cleanup evidence are both present.')
        )
      else
        jsonb_build_array(
          jsonb_build_object('id','continue','title','Continue the current bounded work flow','action','Persist evidence, respect dependencies and verify terminal results independently.'),
          jsonb_build_object('id','retrieve-guidance','title','Retrieve current preemptive guidance when the next strategic move is unclear','action','Call atax_preemptive_guidance_get on demand.')
        )
    end;

  guidance := jsonb_build_object(
    'version', 1,
    'updatedAt', now(),
    'lastAction', jsonb_build_object(
      'tool', tool_name_in,
      'summary', left(coalesce(action_summary_in,''), 1000)
    ),
    'nextSteps', next_steps,
    'principles', jsonb_build_array(
      'ATAX is the persistent strategic graph, not merely a task queue.',
      'Reuse existing System, Vision and Goal structure before creating duplicates.',
      'Create bounded tasks only after the strategic placement is resolved.',
      'Guidance is on-demand state; do not repeatedly inject it into tool responses.',
      'For private remote CI, prefer disposable FMRL rather than consuming private GitHub Actions quota.'
    ),
    'context', coalesce(context_in,'{}'::jsonb)
  );

  insert into atax_private.mcp_preemptive_guidance(owner_subject,guidance,last_tool,last_action_at,updated_at)
  values(configured_owner,guidance,tool_name_in,now(),now())
  on conflict(owner_subject) do update set
    guidance=excluded.guidance,
    last_tool=excluded.last_tool,
    last_action_at=excluded.last_action_at,
    updated_at=excluded.updated_at;

  return jsonb_build_object(
    'updated', true,
    'guidance_available', true,
    'retrieval_tool', 'atax_preemptive_guidance_get',
    'updated_at', now()
  );
end;
$$;

create or replace function public.atax_mcp_preemptive_guidance_get_v1(
  owner_subject_in text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  configured_owner text;
  stored jsonb;
  briefing jsonb;
begin
  configured_owner := atax_private.instance_owner_subject_v1();

  if owner_subject_in is null
     or owner_subject_in is distinct from configured_owner then
    raise exception 'ATAX guidance owner authorization failed';
  end if;

  select guidance into stored
    from atax_private.mcp_preemptive_guidance
   where owner_subject = configured_owner;

  if stored is null then
    stored := jsonb_build_object(
      'version',1,
      'updatedAt',now(),
      'nextSteps',jsonb_build_array(
        jsonb_build_object('id','hydrate','title','Hydrate the ATAX strategic graph','action','Inspect System, Vision, Goal and Task state before meaningful work.'),
        jsonb_build_object('id','plan','title','Place the request strategically','action','Reuse an existing Vision/Goal or create the missing planning node before execution.')
      ),
      'principles',jsonb_build_array(
        'ATAX is the persistent strategic graph, not merely a task queue.',
        'Guidance is retrieved on demand rather than attached to every response.',
        'Private remote CI should prefer FMRL over consuming private GitHub Actions quota.'
      )
    );
  end if;

  begin
    select public.agent_context_overview() into briefing;
  exception when others then
    briefing := '{}'::jsonb;
  end;

  return stored || jsonb_build_object(
    'retrievedAt', now(),
    'retrievalTool', 'atax_preemptive_guidance_get',
    'currentBriefing', coalesce(briefing,'{}'::jsonb)
  );
end;
$$;

grant execute on function public.atax_mcp_preemptive_guidance_update_v1(text,text,text,jsonb) to service_role;
grant execute on function public.atax_mcp_preemptive_guidance_get_v1(text) to service_role;
