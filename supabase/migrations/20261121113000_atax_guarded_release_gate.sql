-- Restore the canonical GitHub check-run projection in resettable migrations.
-- Production already contains this table; IF NOT EXISTS preserves existing data.
create table if not exists public.github_check_runs (
  id uuid primary key default gen_random_uuid(),
  system_id uuid not null references public.systems(id) on delete cascade,
  github_id bigint not null,
  name text, workflow_name text, status text, conclusion text,
  sha text, branch text, url text, started_at timestamptz,
  completed_at timestamptz, source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb,
  constraint github_check_runs_system_id_github_id_key unique(system_id, github_id)
);
create index if not exists github_check_runs_attention_idx
  on public.github_check_runs(system_id, conclusion, status, completed_at desc);
alter table public.github_check_runs enable row level security;
revoke all on public.github_check_runs from public, anon, authenticated;
grant select,insert,update on public.github_check_runs to service_role;

-- ATAX release controller, fail-closed. A durable gate is coordination, not a
-- scheduler: external agents perform operations and submit source evidence.
-- No production data changes or releases occur merely by applying this schema.
create table if not exists public.atax_release_gate_day (
  ist_day date primary key,
  observed_main_updates integer,
  observed_worker_deployments integer,
  complete_github_history boolean not null default false,
  complete_cloudflare_history boolean not null default false,
  attested_at timestamptz,
  attested_by_agent_id text,
  github_evidence jsonb not null default '{}'::jsonb,
  cloudflare_evidence jsonb not null default '{}'::jsonb,
  reserved_main_updates integer not null default 0,
  reserved_worker_deployments integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint atax_release_day_nonnegative check (
    (observed_main_updates is null or observed_main_updates>=0)
    and (observed_worker_deployments is null or observed_worker_deployments>=0)
    and reserved_main_updates>=0 and reserved_worker_deployments>=0
  )
);
create table if not exists public.atax_release_gate_lock (
  singleton boolean primary key default true check(singleton),
  claimed_by_agent_id text,
  claim_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.atax_release_gate_lock(singleton) values(true)
on conflict (singleton) do nothing;
create table if not exists public.atax_release_gate_events (
  id bigint generated always as identity primary key,
  ist_day date not null,
  event_type text not null check(event_type in ('lock_acquired','lock_recovered','lock_released','attested','reserved')),
  operation text,
  actor_id text not null,
  claim_token uuid,
  exact_head_sha text,
  evidence jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists atax_release_gate_events_day_idx
  on public.atax_release_gate_events(ist_day,occurred_at);

alter table public.atax_release_gate_day enable row level security;
alter table public.atax_release_gate_lock enable row level security;
alter table public.atax_release_gate_events enable row level security;
revoke all on public.atax_release_gate_day, public.atax_release_gate_lock,
  public.atax_release_gate_events from public,anon,authenticated;
grant select,insert,update on public.atax_release_gate_day,public.atax_release_gate_lock
  to service_role;
grant select,insert on public.atax_release_gate_events to service_role;
grant usage,select on sequence public.atax_release_gate_events_id_seq to service_role;

-- External attestation does not automatically equal verified API provenance.
-- The attestor must independently collect complete IST-day commit + Worker
-- deployment histories, including uploads and secret-triggered deployments.
create or replace function public.atax_release_gate_attest(
  attestor_in text,
  main_count_in integer,
  deployment_count_in integer,
  github_evidence_in jsonb,
  cloudflare_evidence_in jsonb
) returns jsonb language plpgsql set search_path to 'public' as $attest$
declare today_ist date := (now() at time zone 'Asia/Kolkata')::date;
  lock_owner text;
  result_row public.atax_release_gate_day;
begin
  if nullif(btrim(attestor_in),'') is null then raise exception 'independent attestor identity is required'; end if;
  if main_count_in is null or deployment_count_in is null or main_count_in<0 or deployment_count_in<0 then
    raise exception 'complete nonnegative provider counts are required';
  end if;
  if jsonb_typeof(github_evidence_in)<>'object'
     or github_evidence_in->>'source'<>'github_rest'
     or github_evidence_in->>'complete_ist_day' is distinct from 'true'
     or github_evidence_in->>'repository'<>'dinilmusick/ATAX'
     or nullif(github_evidence_in->>'source_url','') is null
     or jsonb_typeof(cloudflare_evidence_in)<>'object'
     or cloudflare_evidence_in->>'source'<>'cloudflare_workers_deployments'
     or cloudflare_evidence_in->>'complete_ist_day' is distinct from 'true'
     or cloudflare_evidence_in->>'worker'<>'atax-mcp'
     or nullif(cloudflare_evidence_in->>'source_url','') is null
  then raise exception 'complete day-scoped GitHub and Cloudflare source evidence required'; end if;
  select claimed_by_agent_id into lock_owner from public.atax_release_gate_lock
  where singleton=true and lease_expires_at>now();
  if lock_owner=attestor_in then
    raise exception 'release lock owner cannot attest their own provider counts';
  end if;
  insert into public.atax_release_gate_day(
    ist_day,observed_main_updates,observed_worker_deployments,
    complete_github_history,complete_cloudflare_history,attested_at,
    attested_by_agent_id,github_evidence,cloudflare_evidence)
  values(today_ist,main_count_in,deployment_count_in,true,true,now(),
    attestor_in,github_evidence_in,cloudflare_evidence_in)
  on conflict (ist_day) do update set
    observed_main_updates=excluded.observed_main_updates,
    observed_worker_deployments=excluded.observed_worker_deployments,
    complete_github_history=true,complete_cloudflare_history=true,
    attested_at=excluded.attested_at,attested_by_agent_id=excluded.attested_by_agent_id,
    github_evidence=excluded.github_evidence,cloudflare_evidence=excluded.cloudflare_evidence,
    updated_at=now()
  where public.atax_release_gate_day.observed_main_updates is null
    or (excluded.observed_main_updates >= public.atax_release_gate_day.observed_main_updates
      and excluded.observed_worker_deployments >= coalesce(public.atax_release_gate_day.observed_worker_deployments,0))
  returning * into result_row;
  if result_row.ist_day is null then
    raise exception 'source counts cannot decrease within an IST day';
  end if;
  insert into public.atax_release_gate_events(ist_day,event_type,actor_id,evidence)
  values(today_ist,'attested',attestor_in,jsonb_build_object('main',main_count_in,'workers',deployment_count_in,
    'github',github_evidence_in,'cloudflare',cloudflare_evidence_in));
  return jsonb_build_object('ist_day',today_ist,'observed_main',main_count_in,
    'observed_worker',deployment_count_in,'attested_at',result_row.attested_at);
end;
$attest$;

create or replace function public.atax_release_gate_acquire(
  agent_id_in text,lease_seconds_in integer default 900
) returns jsonb language plpgsql set search_path to 'public' as $claim$
declare current_lock public.atax_release_gate_lock;
  token_value uuid := gen_random_uuid();
  today_ist date := (now() at time zone 'Asia/Kolkata')::date;
  previous_owner text;
begin
  if nullif(btrim(agent_id_in),'') is null then raise exception 'release agent identity required'; end if;
  if lease_seconds_in is null or lease_seconds_in<60 or lease_seconds_in>1800 then
    raise exception 'release lock lease must be 60..1800 seconds'; end if;
  select * into current_lock from public.atax_release_gate_lock where singleton=true for update;
  if current_lock.claimed_by_agent_id is not null and current_lock.lease_expires_at>now() then
    return jsonb_build_object('acquired',false,'reason','active_exclusive_lock');
  end if;
  previous_owner:=current_lock.claimed_by_agent_id;
  update public.atax_release_gate_lock set claimed_by_agent_id=agent_id_in,
    claim_token=token_value,lease_expires_at=now()+make_interval(secs=>lease_seconds_in),
    updated_at=now() where singleton=true;
  insert into public.atax_release_gate_events(ist_day,event_type,actor_id,claim_token,evidence)
  values(today_ist,case when previous_owner is null then 'lock_acquired' else 'lock_recovered' end,
    agent_id_in,token_value,jsonb_build_object('previous_owner',previous_owner));
  return jsonb_build_object('acquired',true,'claim_token',token_value,'ist_day',today_ist,
    'lease_seconds',lease_seconds_in);
end;
$claim$;

-- Reserve one release slot BEFORE issuing GitHub/Cloudflare mutations.
-- Reservations are deliberately not refundable: an unknown or failed provider
-- operation may already have caused a release. Count as used until next day.
create or replace function public.atax_release_gate_reserve(
  agent_id_in text,claim_token_in uuid,operation_in text,
  exact_head_sha_in text,acceptance_in jsonb
) returns jsonb language plpgsql set search_path to 'public' as $reserve$
declare today_ist date := (now() at time zone 'Asia/Kolkata')::date;
  lock_row public.atax_release_gate_lock;
  day_row public.atax_release_gate_day;
  accepted_checks integer;
begin
  if operation_in not in ('main_update','worker_deployment') then
    raise exception 'unsupported release operation'; end if;
  if exact_head_sha_in is null or exact_head_sha_in !~ '^[0-9a-f]{40}$' then
    raise exception 'exact 40-character GitHub head SHA required'; end if;
  select * into lock_row from public.atax_release_gate_lock where singleton=true for update;
  if lock_row.claimed_by_agent_id is distinct from agent_id_in
     or lock_row.claim_token is distinct from claim_token_in
     or lock_row.lease_expires_at<=now() then
    raise exception 'exclusive release lock not held by caller'; end if;
  select * into day_row from public.atax_release_gate_day where ist_day=today_ist for update;
  if day_row.ist_day is null
    or not day_row.complete_github_history or not day_row.complete_cloudflare_history
    or day_row.observed_main_updates is null or day_row.observed_worker_deployments is null
    or day_row.attested_at<now()-interval '15 minutes'
    or day_row.attested_by_agent_id=agent_id_in then
    raise exception 'fresh independent complete IST-day provider audit missing'; end if;
  if jsonb_typeof(acceptance_in)<>'object'
    or acceptance_in->>'exact_head_sha' is distinct from exact_head_sha_in
    or acceptance_in->>'independent_verification' is distinct from 'verified'
    or acceptance_in->>'migration_compatibility' is distinct from 'verified'
    or nullif(acceptance_in->>'evidence_url','') is null then
    raise exception 'exact-head independent acceptance and migration proof required'; end if;
  select count(*) into accepted_checks from public.github_check_runs
  where system_id=(select id from public.systems where system_key='atax')
    and sha=exact_head_sha_in and status='completed' and conclusion='success'
    and synced_at>now()-interval '30 minutes';
  if accepted_checks<5 or exists(
    select 1 from public.github_check_runs where
      system_id=(select id from public.systems where system_key='atax')
      and sha=exact_head_sha_in and synced_at>now()-interval '30 minutes'
      and (status<>'completed' or conclusion<>'success')
  ) then raise exception 'fresh exact-head GitHub check evidence incomplete or nonpassing'; end if;
  if operation_in='main_update' then
    if day_row.observed_main_updates+day_row.reserved_main_updates>=2 then
      raise exception 'IST-day GitHub main-update budget exhausted'; end if;
    update public.atax_release_gate_day set reserved_main_updates=reserved_main_updates+1,updated_at=now() where ist_day=today_ist;
  else
    if day_row.observed_worker_deployments+day_row.reserved_worker_deployments>=2 then
      raise exception 'IST-day Worker deployment budget exhausted'; end if;
    update public.atax_release_gate_day set reserved_worker_deployments=reserved_worker_deployments+1,updated_at=now() where ist_day=today_ist;
  end if;
  insert into public.atax_release_gate_events(
    ist_day,event_type,operation,actor_id,claim_token,exact_head_sha,evidence)
  values(today_ist,'reserved',operation_in,agent_id_in,claim_token_in,exact_head_sha_in,acceptance_in);
  return jsonb_build_object('reserved',true,'ist_day',today_ist,'operation',operation_in,
    'head_sha',exact_head_sha_in,'reservation_nonrefundable',true);
end;
$reserve$;

create or replace function public.atax_release_gate_release(
  agent_id_in text,claim_token_in uuid
) returns boolean language plpgsql set search_path to 'public' as $release$
declare today_ist date := (now() at time zone 'Asia/Kolkata')::date;
begin
  update public.atax_release_gate_lock set claimed_by_agent_id=null,claim_token=null,
    lease_expires_at=null,updated_at=now()
  where singleton=true and claimed_by_agent_id=agent_id_in
    and claim_token=claim_token_in and lease_expires_at>now();
  if not found then return false; end if;
  insert into public.atax_release_gate_events(ist_day,event_type,actor_id,claim_token)
  values(today_ist,'lock_released',agent_id_in,claim_token_in);
  return true;
end;
$release$;

revoke all on function public.atax_release_gate_attest(text,integer,integer,jsonb,jsonb),
  public.atax_release_gate_acquire(text,integer),
  public.atax_release_gate_reserve(text,uuid,text,text,jsonb),
  public.atax_release_gate_release(text,uuid)
  from public,anon,authenticated;
grant execute on function public.atax_release_gate_attest(text,integer,integer,jsonb,jsonb),
  public.atax_release_gate_acquire(text,integer),
  public.atax_release_gate_reserve(text,uuid,text,text,jsonb),
  public.atax_release_gate_release(text,uuid) to service_role;
