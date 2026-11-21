-- ATAX guarded release ownership. This table is a durable coordination ledger,
-- NOT a scheduler or autonomous agent. Only an incoming authorized reconciler
-- can request one bounded release action after independent provider evidence.
create table if not exists public.atax_release_days (
  system_id uuid not null references public.systems(id) on delete cascade,
  ist_day date not null,
  state text not null default 'idle'
    check (state in ('idle','reserved','completed','aborted','reconcile_required')),
  holder_agent_id text,
  lock_token uuid,
  lock_expires_at timestamptz,
  reserved_action text check (reserved_action in ('main_update','worker_deployment')),
  observed_main_updates integer not null default 0 check (observed_main_updates>=0),
  observed_worker_deployments integer not null default 0 check (observed_worker_deployments>=0),
  observed_main_sha text,
  source_report jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (system_id, ist_day),
  check ((state <> 'reserved') or
    (holder_agent_id is not null and lock_token is not null
      and lock_expires_at is not null and reserved_action is not null))
);

create table if not exists public.atax_release_events (
  id bigint generated always as identity primary key,
  system_id uuid not null references public.systems(id) on delete cascade,
  ist_day date not null,
  event_type text not null,
  agent_id text not null,
  lock_token uuid,
  action text,
  evidence jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists atax_release_events_system_day_idx
on public.atax_release_events(system_id,ist_day,occurred_at desc);

alter table public.atax_release_days enable row level security;
alter table public.atax_release_events enable row level security;
revoke all on public.atax_release_days from public,anon,authenticated,service_role;
revoke all on public.atax_release_events from public,anon,authenticated,service_role;
revoke all on sequence public.atax_release_events_id_seq from public,anon,authenticated,service_role;

-- This validation is a schema contract for external independent evidence,
-- not a claim that Postgres can authenticate the GitHub/Cloudflare source.
-- The reconciler must actually check all external sources and append URLs
-- before invoking this RPC. Unknown or incomplete counts always fail closed.
create or replace function public.atax_release_check_report(
  report_in jsonb, requester_in text, expected_day_in date
) returns void language plpgsql stable
set search_path to 'pg_catalog','public' as $function$
declare verified_at_value timestamptz;
begin
  if jsonb_typeof(report_in)<>'object'
     or nullif(btrim(requester_in),'') is null
     or nullif(btrim(report_in->>'verifier_agent_id'),'') is null
     or report_in->>'verifier_agent_id'=requester_in
     or coalesce(report_in->>'ist_day','')<>expected_day_in::text
     or coalesce(report_in->>'github_history_complete','false')<>'true'
     or coalesce(report_in->>'cloudflare_history_complete','false')<>'true'
     or coalesce(report_in->>'observed_main_sha','') !~ '^[0-9a-f]{40}$'
     or coalesce(jsonb_typeof(report_in->'source_links'),'null')<>'array'
     or coalesce(jsonb_array_length(report_in->'source_links'),0)<2
  then
    raise exception 'independent complete GitHub/Cloudflare evidence required' using errcode='22023';
  end if;
  if (report_in->>'main_updates')::integer<0
     or (report_in->>'worker_deployments')::integer<0 then
    raise exception 'release counts cannot be negative' using errcode='22023';
  end if;
  verified_at_value := (report_in->>'verified_at')::timestamptz;
  if verified_at_value is null
     or verified_at_value < clock_timestamp()-interval '15 minutes'
     or verified_at_value > clock_timestamp()+interval '1 minute' then
    raise exception 'release evidence is stale or from the future' using errcode='22023';
  end if;
exception
  when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
    raise exception 'invalid release evidence field' using errcode='22023';
end;
$function$;

create or replace function public.atax_release_reserve(
  system_id_in uuid, agent_id_in text, action_in text,
  provider_report_in jsonb, lease_seconds_in integer default 900
) returns jsonb language plpgsql security definer
set search_path to 'pg_catalog','public' as $function$
declare
  day_value date:= (clock_timestamp() at time zone 'Asia/Kolkata')::date;
  record_value public.atax_release_days;
  observed_main integer;
  observed_worker integer;
  token_value uuid:=gen_random_uuid();
begin
  if action_in not in ('main_update','worker_deployment')
     or lease_seconds_in not between 120 and 1800
     or not exists(select 1 from public.systems where id=system_id_in and system_key='atax' and status='active') then
    raise exception 'invalid ATAX release operation' using errcode='22023';
  end if;
  perform public.atax_release_check_report(provider_report_in,agent_id_in,day_value);
  observed_main := (provider_report_in->>'main_updates')::integer;
  observed_worker := (provider_report_in->>'worker_deployments')::integer;

  insert into public.atax_release_days(system_id,ist_day)
    values(system_id_in,day_value) on conflict do nothing;
  select * into record_value from public.atax_release_days
    where system_id=system_id_in and ist_day=day_value for update;

  -- Failed, expired, or uncertain releases need a separate independent
  -- reconciliation; expiration is never automatic authority to overwrite.
  if record_value.state in ('reserved','reconcile_required') then
    raise exception 'release slot has unresolved ownership; reconcile first' using errcode='55000';
  end if;
  if observed_main < record_value.observed_main_updates
     or observed_worker < record_value.observed_worker_deployments then
    raise exception 'provider evidence regressed since previous release' using errcode='55000';
  end if;
  if (action_in='main_update' and observed_main>=2)
     or (action_in='worker_deployment' and observed_worker>=2) then
    raise exception 'two-action IST daily release budget exhausted' using errcode='55000';
  end if;

  update public.atax_release_days
  set state='reserved',holder_agent_id=agent_id_in,lock_token=token_value,
      lock_expires_at=clock_timestamp()+make_interval(secs=>lease_seconds_in),
      reserved_action=action_in,
      observed_main_updates=observed_main,
      observed_worker_deployments=observed_worker,
      observed_main_sha=provider_report_in->>'observed_main_sha',
      source_report=provider_report_in,updated_at=clock_timestamp()
  where system_id=system_id_in and ist_day=day_value;
  insert into public.atax_release_events
    (system_id,ist_day,event_type,agent_id,lock_token,action,evidence)
  values(system_id_in,day_value,'reserved',agent_id_in,token_value,action_in,
         provider_report_in);
  return jsonb_build_object('token',token_value,'ist_day',day_value,
    'action',action_in,'lease_seconds',lease_seconds_in,
    'required_next_step','apply exactly one action and independently reobserve both providers');
end;
$function$;

create or replace function public.atax_release_finalize(
  system_id_in uuid, agent_id_in text, token_in uuid, outcome_in text,
  provider_report_in jsonb
) returns jsonb language plpgsql security definer
set search_path to 'pg_catalog','public' as $function$
declare
  record_value public.atax_release_days;
  after_main integer;
  after_worker integer;
  correct_counts boolean;
  new_state text;
begin
  select * into record_value from public.atax_release_days
  where system_id=system_id_in and lock_token=token_in and state='reserved'
  for update;
  if not found or record_value.holder_agent_id is distinct from agent_id_in then
    raise exception 'not the current fenced release owner' using errcode='55000';
  end if;
  if outcome_in not in ('completed','aborted') then
    raise exception 'invalid release outcome' using errcode='22023';
  end if;
  perform public.atax_release_check_report(provider_report_in,agent_id_in,record_value.ist_day);
  after_main := (provider_report_in->>'main_updates')::integer;
  after_worker := (provider_report_in->>'worker_deployments')::integer;
  correct_counts := case
    when outcome_in='completed' and record_value.reserved_action='main_update' then
      after_main=record_value.observed_main_updates+1
        and after_worker=record_value.observed_worker_deployments
    when outcome_in='completed' and record_value.reserved_action='worker_deployment' then
      after_worker=record_value.observed_worker_deployments+1
        and after_main=record_value.observed_main_updates
    else
      after_main=record_value.observed_main_updates
        and after_worker=record_value.observed_worker_deployments
  end;
  -- A late finalize or unexpected provider change is recorded as a blocker,
  -- never as a green release. It requires independent reconciliation.
  new_state:=case when correct_counts
                     and record_value.lock_expires_at>clock_timestamp()
                    then outcome_in else 'reconcile_required' end;
  update public.atax_release_days
  set state=new_state,holder_agent_id=null,lock_token=null,lock_expires_at=null,
      observed_main_updates=after_main,observed_worker_deployments=after_worker,
      observed_main_sha=provider_report_in->>'observed_main_sha',
      source_report=provider_report_in,updated_at=clock_timestamp()
  where system_id=system_id_in and ist_day=record_value.ist_day;
  insert into public.atax_release_events
    (system_id,ist_day,event_type,agent_id,lock_token,action,evidence)
  values(system_id_in,record_value.ist_day,new_state,agent_id_in,token_in,
         record_value.reserved_action,provider_report_in);
  return jsonb_build_object('state',new_state,'independently_verified',new_state='completed',
    'requires_reconciliation',new_state='reconcile_required');
end;
$function$;

-- Never expose privileged release RPCs to anonymous / ordinary JWT clients.
revoke all on function public.atax_release_check_report(jsonb,text,date) from public,anon,authenticated;
revoke all on function public.atax_release_reserve(uuid,text,text,jsonb,integer) from public,anon,authenticated;
revoke all on function public.atax_release_finalize(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.atax_release_reserve(uuid,text,text,jsonb,integer) to service_role;
grant execute on function public.atax_release_finalize(uuid,text,uuid,text,jsonb) to service_role;
