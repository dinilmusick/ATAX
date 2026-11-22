-- ATAX Socket V1 / Agent D. Additive only: no dependency on Agent B or C.
-- Apply after review; deployment remains disabled until Vault token + targets
-- are configured. pg_net/pg_cron are installed in the canonical project.
-- Database timers dispatch finite workflow operations only; NEVER spawn agents.
create table if not exists public.socket_dispatch_allowed_targets (
  target_repository text not null check (target_repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  runner_repository text not null check (runner_repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  workflow_file text not null check (workflow_file ~ '^[A-Za-z0-9_.-]+\.ya?ml$'),
  operation text not null check (operation in ('test','build','automation','change_request')),
  mode text not null check (mode in ('target','fmrl')),
  enabled boolean not null default false,
  primary key (target_repository,runner_repository,workflow_file,operation,mode),
  constraint socket_runner_isolation check ((mode = 'target' and runner_repository = target_repository)
                                  or (mode = 'fmrl' and runner_repository <> target_repository))
);
create table if not exists public.socket_dispatch_requests (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id),
  agent_id text not null check (length(agent_id) between 1 and 128),
  session_id text not null check (length(session_id) between 1 and 128),
  claim_fence uuid not null,
  correlation_id uuid not null unique,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_.:/-]{8,128}$'),
  operation text not null check (operation in ('test','build','automation','change_request')),
  target_repository text not null,
  runner_repository text not null,
  target_sha text not null check (target_sha ~ '^[0-9a-f]{40}$'),
  workflow_file text not null,
  mode text not null check (mode in ('target','fmrl')),
  input_payload jsonb not null default '{}'::jsonb,
  expected_output jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','dispatching','accepted','uncertain','running','succeeded','failed','denied')),
  run_id text,
  receipt jsonb,
  error_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id,idempotency_key),
  foreign key (target_repository,runner_repository,workflow_file,operation,mode)
    references public.socket_dispatch_allowed_targets(target_repository,runner_repository,workflow_file,operation,mode),
  constraint socket_input_object check (jsonb_typeof(input_payload)='object' and octet_length(input_payload::text)<=8192),
  constraint socket_expected_object check (jsonb_typeof(expected_output)='object' and octet_length(expected_output::text)<=2048),
  constraint socket_receipt_bounded check (receipt is null or (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=4096))
);
-- Observe the terminal run BEFORE deleting a disposable FMRL repo.
-- This record survives loss of GitHub run history if deletion completes first.
create table if not exists public.socket_dispatch_cleanup_journal (
  request_id uuid primary key references public.socket_dispatch_requests(id) on delete restrict,
  run_id text not null check (run_id ~ '^[0-9]{1,24}$'),
  conclusion text not null check (conclusion in ('success','failure','cancelled','timed_out','action_required')),
  receipt jsonb not null check (jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=4096),
  observed_at timestamptz not null default now()
);
create table if not exists public.socket_dispatch_outbox (
  request_id uuid primary key references public.socket_dispatch_requests(id) on delete restrict,
  state text not null default 'queued' check (state in ('queued','sent','retry','accepted','failed','blocked_credentials')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  http_request_id bigint,
  last_error_class text,
  accepted_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.socket_dispatch_config (
  singleton boolean primary key default true check (singleton),
  github_token_secret_id uuid,
  owner text not null default 'dinilmusick' check (owner ~ '^[A-Za-z0-9_.-]+$'),
  repo text not null default 'ATAX' check (repo ~ '^[A-Za-z0-9_.-]+$'),
  workflow_file text not null default 'socket-execution-controller.yml',
  branch text not null default 'main',
  enabled boolean not null default false
);
insert into public.socket_dispatch_config (singleton) values (true) on conflict do nothing;
create index if not exists socket_dispatch_state_idx on public.socket_dispatch_requests(status,created_at);
create index if not exists socket_dispatch_outbox_due_idx on public.socket_dispatch_outbox(state,next_attempt_at);

-- Every table is server-only even if public is exposed via PostgREST.
do $$ declare table_name text; begin
  foreach table_name in array array['socket_dispatch_allowed_targets','socket_dispatch_requests','socket_dispatch_cleanup_journal','socket_dispatch_outbox','socket_dispatch_config'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select,insert,update on table public.%I to service_role', table_name);
  end loop;
end $$;

revoke update,delete on public.socket_dispatch_cleanup_journal from service_role;

-- Canonical immutable fields cannot be edited after insertion, even by a
-- controller with a service key. No raw inputs or secrets are accepted later.
create or replace function public.socket_dispatch_immutability() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
 if row(old.task_id,old.agent_id,old.session_id,old.claim_fence,old.correlation_id,
        old.idempotency_key,old.operation,old.target_repository,old.runner_repository,
        old.target_sha,old.workflow_file,old.mode,old.input_payload,old.expected_output)
    is distinct from
    row(new.task_id,new.agent_id,new.session_id,new.claim_fence,new.correlation_id,
        new.idempotency_key,new.operation,new.target_repository,new.runner_repository,
        new.target_sha,new.workflow_file,new.mode,new.input_payload,new.expected_output) then
   raise exception 'immutable socket dispatch request';
 end if;
 return new;
end $$;
drop trigger if exists socket_dispatch_immutable on public.socket_dispatch_requests;
create trigger socket_dispatch_immutable before update on public.socket_dispatch_requests
for each row execute function public.socket_dispatch_immutability();

-- Recursively reject credential-shaped keys and credential token prefixes on the
-- authoritative database path, not only in optional client-side validation.
create or replace function public.socket_dispatch_payload_safe(p_value jsonb, p_depth integer default 0)
returns boolean language plpgsql immutable strict set search_path=pg_catalog,public as $safe$
declare kv record; element jsonb; decoded text;
begin
 if p_depth > 8 then return false; end if;
 if jsonb_typeof(p_value)='object' then
   for kv in select key,value from jsonb_each(p_value) loop
     if length(kv.key)>128 or kv.key ~* '(secret|password|token|credential|authorization|api[_-]?key|private[_-]?key)'
        or not public.socket_dispatch_payload_safe(kv.value,p_depth+1) then return false; end if;
   end loop;
 elsif jsonb_typeof(p_value)='array' then
   if jsonb_array_length(p_value)>64 then return false; end if;
   for element in select value from jsonb_array_elements(p_value) loop
     if not public.socket_dispatch_payload_safe(element,p_depth+1) then return false; end if;
   end loop;
 elsif jsonb_typeof(p_value)='string' then
   decoded := p_value #>> '{}';
   if length(decoded)>1024 or decoded ~* '^(ghp_|ghs_|github_pat_|sk-)' then return false; end if;
 end if;
 return true;
end $safe$;
alter table public.socket_dispatch_requests
  add constraint socket_dispatch_safe_input check(public.socket_dispatch_payload_safe(input_payload));
revoke all on function public.socket_dispatch_payload_safe(jsonb,integer) from public,anon,authenticated;
grant execute on function public.socket_dispatch_payload_safe(jsonb,integer) to service_role;

-- Service-role intake. Socket gateway must independently authorise the caller;
-- SQL rechecks exact task+session+fence and allowlist inside this transaction.
create or replace function public.socket_dispatch_submit(
 p_task_id uuid,p_agent_id text,p_session_id text,p_claim_fence uuid,
 p_correlation_id uuid,p_idempotency_key text,p_operation text,
 p_target_repository text,p_runner_repository text,p_target_sha text,
 p_workflow_file text,p_mode text,p_input_payload jsonb,p_expected_output jsonb
) returns uuid language plpgsql security invoker set search_path = pg_catalog, public as $$
declare existing public.socket_dispatch_requests%rowtype; created uuid;
begin
 if not exists(select 1 from public.tasks t where t.id=p_task_id
  and t.status='running' and t.task_role='execution'
  and t.claimed_by_agent_id=p_agent_id and t.claimed_session_id=p_session_id
  and t.claim_token=p_claim_fence and t.claim_expires_at>statement_timestamp()) then
   raise exception 'invalid or expired task socket claim';
 end if;
 if not exists(select 1 from public.socket_dispatch_allowed_targets a
  where a.target_repository=p_target_repository and a.runner_repository=p_runner_repository
    and a.workflow_file=p_workflow_file and a.operation=p_operation and a.mode=p_mode and a.enabled) then
   raise exception 'execution target not allowlisted';
 end if;
 if p_mode='fmrl' and p_runner_repository <> split_part(p_target_repository,'/',1)
   ||'/FMRL-'||left(replace(p_correlation_id::text,'-',''),20) then
   raise exception 'FMRL runner must match canonical correlation-bound identity';
 end if;
 if p_target_sha !~ '^[0-9a-f]{40}
    or p_input_payload is null or jsonb_typeof(p_input_payload)<>'object'
    or octet_length(p_input_payload::text)>8192
    or p_expected_output is null or jsonb_typeof(p_expected_output)<>'object'
    or octet_length(p_expected_output::text)>2048
    or p_input_payload ?| array['secret','token','password','credentials','authorization'] then
   raise exception 'invalid bounded execution contract';
 end if;
 select * into existing from public.socket_dispatch_requests
   where task_id=p_task_id and idempotency_key=p_idempotency_key for update;
 if found then
   if existing.claim_fence<>p_claim_fence or existing.correlation_id<>p_correlation_id
     or existing.operation<>p_operation or existing.target_repository<>p_target_repository
     or existing.runner_repository<>p_runner_repository or existing.target_sha<>p_target_sha
     or existing.workflow_file<>p_workflow_file or existing.mode<>p_mode
     or existing.input_payload<>p_input_payload or existing.expected_output<>p_expected_output then
     raise exception 'idempotency collision with different immutable request';
   end if;
   return existing.id;
 end if;
 insert into public.socket_dispatch_requests (
   task_id,agent_id,session_id,claim_fence,correlation_id,idempotency_key,
   operation,target_repository,runner_repository,target_sha,workflow_file,mode,input_payload,expected_output)
 values (p_task_id,p_agent_id,p_session_id,p_claim_fence,p_correlation_id,p_idempotency_key,
   p_operation,p_target_repository,p_runner_repository,p_target_sha,p_workflow_file,p_mode,p_input_payload,p_expected_output)
 returning id into created;
 return created;
end $$;

create or replace function public.socket_dispatch_enqueue() returns trigger
language plpgsql security invoker set search_path = pg_catalog,public as $$
begin
 insert into public.socket_dispatch_outbox(request_id) values(new.id);
 return new;
end $$;
drop trigger if exists socket_dispatch_enqueue_trigger on public.socket_dispatch_requests;
create trigger socket_dispatch_enqueue_trigger after insert on public.socket_dispatch_requests
for each row execute function public.socket_dispatch_enqueue();

-- One dispatch attempt is sent asynchronously by pg_net, DIRECT to GitHub.
-- Durable outbox provides retries and HTTP acknowledgement tracking; sends
-- only opaque IDs. These are workflow operations, never AI agents.
create or replace function public.socket_dispatch_pump(p_limit integer default 10)
returns integer language plpgsql security definer
set search_path = pg_catalog,public,net,vault as $$
declare cfg public.socket_dispatch_config%rowtype; token_value text;
 item record; response_code integer; response_error text; response_timeout boolean;
 response_found boolean; request_number bigint; processed integer:=0;
begin
 if p_limit < 1 or p_limit > 50 then raise exception 'outbox batch bound exceeded'; end if;
 select * into cfg from public.socket_dispatch_config where singleton=true and enabled=true;
 if not found then return 0; end if;
 if cfg.github_token_secret_id is not null then
   select decrypted_secret into token_value from vault.decrypted_secrets where id=cfg.github_token_secret_id;
 end if;
 if token_value is null or length(token_value)<10 then
   update public.socket_dispatch_outbox
   set state='blocked_credentials',last_error_class='missing_github_token',
       next_attempt_at=now()+interval '5 minutes',updated_at=now()
   where state in ('queued','retry','sent','blocked_credentials')
     and next_attempt_at<=now();
   return 0;
 end if;
 for item in select o.request_id,o.state,o.attempts,o.http_request_id,o.next_attempt_at,
      r.correlation_id,r.status as request_status
  from public.socket_dispatch_outbox o join public.socket_dispatch_requests r on r.id=o.request_id
  where o.state in ('queued','retry','sent','blocked_credentials') and o.next_attempt_at<=now()
  order by o.next_attempt_at,o.request_id for update of o skip locked limit p_limit loop
   if item.state='sent' then
     select status_code,error_msg,timed_out,true into response_code,response_error,response_timeout,response_found
       from net._http_response where id=item.http_request_id;
     if response_found and response_code=204 then
       update public.socket_dispatch_outbox set state='accepted',accepted_at=now(),updated_at=now(),last_error_class=null
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
     if response_found and response_code between 400 and 499 and response_code<>429 then
       update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='github_rejected'
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
     -- A lost HTTP response is ambiguous. Replaying the opaque relay event is
     -- safe: socket_dispatch_begin grants only one target dispatch.
     if item.attempts>=5 then
       update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='acknowledgement_exhausted'
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
   end if;
   if item.attempts>=5 then
      update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='retry_exhausted'
      where request_id=item.request_id; continue;
   end if;
   if item.request_status in ('succeeded','failed','denied') then
      update public.socket_dispatch_outbox set state='accepted',updated_at=now() where request_id=item.request_id;
      continue;
   end if;
   begin
     select net.http_post(
       url=>'https://api.github.com/repos/'||cfg.owner||'/'||cfg.repo||'/actions/workflows/'||cfg.workflow_file||'/dispatches',
       body=>jsonb_build_object('ref',cfg.branch,'inputs',jsonb_build_object(
         'request_id',item.request_id::text,'correlation_id',item.correlation_id::text)),
       headers=>jsonb_build_object('Accept','application/vnd.github+json',
         'X-GitHub-Api-Version','2022-11-28','Authorization','Bearer '||token_value,
         'Content-Type','application/json'),
       timeout_milliseconds=>10000) into request_number;
     update public.socket_dispatch_outbox set state='sent',attempts=attempts+1,
        http_request_id=request_number,next_attempt_at=now()+interval '2 minutes',
        last_error_class=null,updated_at=now() where request_id=item.request_id;
     processed:=processed+1;
   exception when others then
     update public.socket_dispatch_outbox set state='retry',attempts=attempts+1,
       next_attempt_at=now()+interval '2 minutes',last_error_class='request_queue_error',updated_at=now()
       where request_id=item.request_id;
   end;
 end loop;
 return processed;
end $$;

-- Only a presently fenced holder may start. Duplicate relay runs are inert.
create or replace function public.socket_dispatch_begin(
 p_request_id uuid,p_fence uuid,p_agent text,p_session text
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare acquired uuid;
begin
 update public.socket_dispatch_requests r set status='dispatching',updated_at=now()
 where r.id=p_request_id and r.status='queued' and r.claim_fence=p_fence
  and r.agent_id=p_agent and r.session_id=p_session
  and exists(select 1 from public.tasks t where t.id=r.task_id and t.status='running'
    and t.claimed_by_agent_id=p_agent and t.claimed_session_id=p_session
    and t.claim_token=p_fence and t.claim_expires_at>statement_timestamp())
  and exists(select 1 from public.socket_dispatch_allowed_targets a where a.enabled
    and a.target_repository=r.target_repository and a.runner_repository=r.runner_repository
    and a.workflow_file=r.workflow_file and a.mode=r.mode and a.operation=r.operation)
 returning r.id into acquired;
 return acquired is not null;
end $$;

create or replace function public.socket_dispatch_delivery_result(
 p_request_id uuid,p_state text,p_error_class text default null
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare changed uuid;
begin
 if p_state not in ('accepted','uncertain','failed') then raise exception 'invalid dispatch acknowledgement state'; end if;
 update public.socket_dispatch_requests set status=p_state,error_class=left(p_error_class,80),updated_at=now()
 where id=p_request_id and status='dispatching' returning id into changed;
 return changed is not null;
end $$;

-- Durable prepare-first terminal observation: cleanup is not yet attested.
create or replace function public.socket_dispatch_prepare_cleanup(
 p_request_id uuid,p_run_id text,p_conclusion text,p_receipt jsonb
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.socket_dispatch_cleanup_journal%rowtype;
begin
 if p_run_id !~ '^[0-9]{1,24}$'
   or p_conclusion not in ('success','failure','cancelled','timed_out','action_required')
   or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
   or octet_length(p_receipt::text)>4096
   or p_receipt->>'request_id' <> p_request_id::text
   or p_receipt->>'conclusion' <> p_conclusion
   or p_receipt->>'run_id' <> p_run_id
   or p_receipt->>'cleanup' <> 'pending' then
   raise exception 'invalid cleanup preparation';
 end if;
 if not exists(select 1 from public.socket_dispatch_requests r
   where r.id=p_request_id and r.mode='fmrl'
     and r.status in ('dispatching','accepted','uncertain','running')) then
   raise exception 'not a pending disposable execution';
 end if;
 insert into public.socket_dispatch_cleanup_journal(request_id,run_id,conclusion,receipt)
 values(p_request_id,p_run_id,p_conclusion,p_receipt)
 on conflict(request_id) do nothing;
 select * into previous from public.socket_dispatch_cleanup_journal where request_id=p_request_id;
 if previous.run_id <> p_run_id or previous.conclusion <> p_conclusion
   or previous.receipt <> p_receipt then
    raise exception 'immutable cleanup observation collision';
 end if;
 return true;
end $$;

-- Called only by the trusted observer after querying the target GitHub Actions
-- run status. No task-bound agent has database service-role credentials.
create or replace function public.socket_dispatch_finish_observed(
 p_request_id uuid,p_run_id text,p_conclusion text,p_receipt jsonb
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare changed uuid;
begin
 if p_conclusion not in ('success','failure','cancelled','timed_out','action_required')
    or p_run_id !~ '^[0-9]{1,24}$'
    or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>4096
    or p_receipt->>'conclusion'<>p_conclusion
    or p_receipt->>'run_id'<>p_run_id
    or p_receipt->>'request_id'<>p_request_id::text then
   raise exception 'invalid observed terminal receipt';
 end if;
 update public.socket_dispatch_requests set status=case when p_conclusion='success' then 'succeeded' else 'failed' end,
   run_id=p_run_id,receipt=p_receipt,updated_at=now()
 where id=p_request_id and status in ('dispatching','accepted','uncertain','running')
   and (mode<>'fmrl' or
     (p_receipt->>'cleanup'='independent_404'
      and exists(select 1 from public.socket_dispatch_cleanup_journal j
        where j.request_id=p_request_id and j.run_id=p_run_id and j.conclusion=p_conclusion)))
 returning id into changed;
 return changed is not null;
end $$;

-- SECURITY DEFINER only for Vault/pg_net access. All RPCs are restricted.
revoke all on function public.socket_dispatch_pump(integer) from public,anon,authenticated;
revoke all on function public.socket_dispatch_submit(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_begin(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.socket_dispatch_delivery_result(uuid,text,text) from public,anon,authenticated;
revoke all on function public.socket_dispatch_prepare_cleanup(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_finish_observed(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_immutability() from public,anon,authenticated;
revoke all on function public.socket_dispatch_enqueue() from public,anon,authenticated;
grant execute on function public.socket_dispatch_pump(integer) to service_role;
grant execute on function public.socket_dispatch_submit(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,jsonb) to service_role;
grant execute on function public.socket_dispatch_begin(uuid,uuid,text,text) to service_role;
grant execute on function public.socket_dispatch_delivery_result(uuid,text,text) to service_role;
grant execute on function public.socket_dispatch_prepare_cleanup(uuid,text,text,jsonb) to service_role;
grant execute on function public.socket_dispatch_finish_observed(uuid,text,text,jsonb) to service_role;

-- pg_cron may be absent from isolated/local Supabase stacks. Register the
-- pump only where the extension and schema exist; never block migration in CI.
-- Dispatch still remains disabled until Vault config and target allowlists are set.
do $socket_schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_namespace where nspname = 'cron') then
    execute $cron_sql$select cron.schedule(
      'atax-socket-v1-dispatch-outbox', '* * * * *',
      'select public.socket_dispatch_pump(10)'
    )$cron_sql$;
  end if;
end;
$socket_schedule$;

-- Target-scoped runner rechecks the live claim BEFORE checkout/execution.
create or replace function public.socket_dispatch_fence_valid(
 p_request_id uuid,p_claim_fence uuid,p_target_sha text
) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.socket_dispatch_requests r
   join public.tasks t on t.id=r.task_id
   join public.socket_dispatch_allowed_targets a
     on a.target_repository=r.target_repository and a.runner_repository=r.runner_repository
     and a.workflow_file=r.workflow_file and a.mode=r.mode and a.operation=r.operation
   where r.id=p_request_id and r.claim_fence=p_claim_fence and r.target_sha=p_target_sha
     and r.status in ('dispatching','accepted','running') and a.enabled
     and t.status='running' and t.claimed_by_agent_id=r.agent_id
     and t.claimed_session_id=r.session_id and t.claim_token=p_claim_fence
     and t.claim_expires_at>statement_timestamp());
$$;
revoke all on function public.socket_dispatch_fence_valid(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.socket_dispatch_fence_valid(uuid,uuid,text) to service_role;
 or p_idempotency_key !~ '^[A-Za-z0-9_.:/-]{8,128}
    or p_input_payload is null or jsonb_typeof(p_input_payload)<>'object'
    or octet_length(p_input_payload::text)>8192
    or p_expected_output is null or jsonb_typeof(p_expected_output)<>'object'
    or octet_length(p_expected_output::text)>2048
    or p_input_payload ?| array['secret','token','password','credentials','authorization'] then
   raise exception 'invalid bounded execution contract';
 end if;
 select * into existing from public.socket_dispatch_requests
   where task_id=p_task_id and idempotency_key=p_idempotency_key for update;
 if found then
   if existing.claim_fence<>p_claim_fence or existing.correlation_id<>p_correlation_id
     or existing.operation<>p_operation or existing.target_repository<>p_target_repository
     or existing.runner_repository<>p_runner_repository or existing.target_sha<>p_target_sha
     or existing.workflow_file<>p_workflow_file or existing.mode<>p_mode
     or existing.input_payload<>p_input_payload or existing.expected_output<>p_expected_output then
     raise exception 'idempotency collision with different immutable request';
   end if;
   return existing.id;
 end if;
 insert into public.socket_dispatch_requests (
   task_id,agent_id,session_id,claim_fence,correlation_id,idempotency_key,
   operation,target_repository,runner_repository,target_sha,workflow_file,mode,input_payload,expected_output)
 values (p_task_id,p_agent_id,p_session_id,p_claim_fence,p_correlation_id,p_idempotency_key,
   p_operation,p_target_repository,p_runner_repository,p_target_sha,p_workflow_file,p_mode,p_input_payload,p_expected_output)
 returning id into created;
 return created;
end $$;

create or replace function public.socket_dispatch_enqueue() returns trigger
language plpgsql security invoker set search_path = pg_catalog,public as $$
begin
 insert into public.socket_dispatch_outbox(request_id) values(new.id);
 return new;
end $$;
drop trigger if exists socket_dispatch_enqueue_trigger on public.socket_dispatch_requests;
create trigger socket_dispatch_enqueue_trigger after insert on public.socket_dispatch_requests
for each row execute function public.socket_dispatch_enqueue();

-- One dispatch attempt is sent asynchronously by pg_net, DIRECT to GitHub.
-- Durable outbox provides retries and HTTP acknowledgement tracking; sends
-- only opaque IDs. These are workflow operations, never AI agents.
create or replace function public.socket_dispatch_pump(p_limit integer default 10)
returns integer language plpgsql security definer
set search_path = pg_catalog,public,net,vault as $$
declare cfg public.socket_dispatch_config%rowtype; token_value text;
 item record; response_code integer; response_error text; response_timeout boolean;
 response_found boolean; request_number bigint; processed integer:=0;
begin
 if p_limit < 1 or p_limit > 50 then raise exception 'outbox batch bound exceeded'; end if;
 select * into cfg from public.socket_dispatch_config where singleton=true and enabled=true;
 if not found then return 0; end if;
 if cfg.github_token_secret_id is not null then
   select decrypted_secret into token_value from vault.decrypted_secrets where id=cfg.github_token_secret_id;
 end if;
 if token_value is null or length(token_value)<10 then
   update public.socket_dispatch_outbox
   set state='blocked_credentials',last_error_class='missing_github_token',
       next_attempt_at=now()+interval '5 minutes',updated_at=now()
   where state in ('queued','retry','sent','blocked_credentials')
     and next_attempt_at<=now();
   return 0;
 end if;
 for item in select o.request_id,o.state,o.attempts,o.http_request_id,o.next_attempt_at,
      r.correlation_id,r.status as request_status
  from public.socket_dispatch_outbox o join public.socket_dispatch_requests r on r.id=o.request_id
  where o.state in ('queued','retry','sent','blocked_credentials') and o.next_attempt_at<=now()
  order by o.next_attempt_at,o.request_id for update of o skip locked limit p_limit loop
   if item.state='sent' then
     select status_code,error_msg,timed_out,true into response_code,response_error,response_timeout,response_found
       from net._http_response where id=item.http_request_id;
     if response_found and response_code=204 then
       update public.socket_dispatch_outbox set state='accepted',accepted_at=now(),updated_at=now(),last_error_class=null
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
     if response_found and response_code between 400 and 499 and response_code<>429 then
       update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='github_rejected'
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
     -- A lost HTTP response is ambiguous. Replaying the opaque relay event is
     -- safe: socket_dispatch_begin grants only one target dispatch.
     if item.attempts>=5 then
       update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='acknowledgement_exhausted'
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
   end if;
   if item.attempts>=5 then
      update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='retry_exhausted'
      where request_id=item.request_id; continue;
   end if;
   if item.request_status in ('succeeded','failed','denied') then
      update public.socket_dispatch_outbox set state='accepted',updated_at=now() where request_id=item.request_id;
      continue;
   end if;
   begin
     select net.http_post(
       url=>'https://api.github.com/repos/'||cfg.owner||'/'||cfg.repo||'/actions/workflows/'||cfg.workflow_file||'/dispatches',
       body=>jsonb_build_object('ref',cfg.branch,'inputs',jsonb_build_object(
         'request_id',item.request_id::text,'correlation_id',item.correlation_id::text)),
       headers=>jsonb_build_object('Accept','application/vnd.github+json',
         'X-GitHub-Api-Version','2022-11-28','Authorization','Bearer '||token_value,
         'Content-Type','application/json'),
       timeout_milliseconds=>10000) into request_number;
     update public.socket_dispatch_outbox set state='sent',attempts=attempts+1,
        http_request_id=request_number,next_attempt_at=now()+interval '2 minutes',
        last_error_class=null,updated_at=now() where request_id=item.request_id;
     processed:=processed+1;
   exception when others then
     update public.socket_dispatch_outbox set state='retry',attempts=attempts+1,
       next_attempt_at=now()+interval '2 minutes',last_error_class='request_queue_error',updated_at=now()
       where request_id=item.request_id;
   end;
 end loop;
 return processed;
end $$;

-- Only a presently fenced holder may start. Duplicate relay runs are inert.
create or replace function public.socket_dispatch_begin(
 p_request_id uuid,p_fence uuid,p_agent text,p_session text
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare acquired uuid;
begin
 update public.socket_dispatch_requests r set status='dispatching',updated_at=now()
 where r.id=p_request_id and r.status='queued' and r.claim_fence=p_fence
  and r.agent_id=p_agent and r.session_id=p_session
  and exists(select 1 from public.tasks t where t.id=r.task_id and t.status='running'
    and t.claimed_by_agent_id=p_agent and t.claimed_session_id=p_session
    and t.claim_token=p_fence and t.claim_expires_at>statement_timestamp())
  and exists(select 1 from public.socket_dispatch_allowed_targets a where a.enabled
    and a.target_repository=r.target_repository and a.runner_repository=r.runner_repository
    and a.workflow_file=r.workflow_file and a.mode=r.mode and a.operation=r.operation)
 returning r.id into acquired;
 return acquired is not null;
end $$;

create or replace function public.socket_dispatch_delivery_result(
 p_request_id uuid,p_state text,p_error_class text default null
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare changed uuid;
begin
 if p_state not in ('accepted','uncertain','failed') then raise exception 'invalid dispatch acknowledgement state'; end if;
 update public.socket_dispatch_requests set status=p_state,error_class=left(p_error_class,80),updated_at=now()
 where id=p_request_id and status='dispatching' returning id into changed;
 return changed is not null;
end $$;

-- Durable prepare-first terminal observation: cleanup is not yet attested.
create or replace function public.socket_dispatch_prepare_cleanup(
 p_request_id uuid,p_run_id text,p_conclusion text,p_receipt jsonb
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.socket_dispatch_cleanup_journal%rowtype;
begin
 if p_run_id !~ '^[0-9]{1,24}$'
   or p_conclusion not in ('success','failure','cancelled','timed_out','action_required')
   or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
   or octet_length(p_receipt::text)>4096
   or p_receipt->>'request_id' <> p_request_id::text
   or p_receipt->>'conclusion' <> p_conclusion
   or p_receipt->>'run_id' <> p_run_id
   or p_receipt->>'cleanup' <> 'pending' then
   raise exception 'invalid cleanup preparation';
 end if;
 if not exists(select 1 from public.socket_dispatch_requests r
   where r.id=p_request_id and r.mode='fmrl'
     and r.status in ('dispatching','accepted','uncertain','running')) then
   raise exception 'not a pending disposable execution';
 end if;
 insert into public.socket_dispatch_cleanup_journal(request_id,run_id,conclusion,receipt)
 values(p_request_id,p_run_id,p_conclusion,p_receipt)
 on conflict(request_id) do nothing;
 select * into previous from public.socket_dispatch_cleanup_journal where request_id=p_request_id;
 if previous.run_id <> p_run_id or previous.conclusion <> p_conclusion
   or previous.receipt <> p_receipt then
    raise exception 'immutable cleanup observation collision';
 end if;
 return true;
end $$;

-- Called only by the trusted observer after querying the target GitHub Actions
-- run status. No task-bound agent has database service-role credentials.
create or replace function public.socket_dispatch_finish_observed(
 p_request_id uuid,p_run_id text,p_conclusion text,p_receipt jsonb
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare changed uuid;
begin
 if p_conclusion not in ('success','failure','cancelled','timed_out','action_required')
    or p_run_id !~ '^[0-9]{1,24}$'
    or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>4096
    or p_receipt->>'conclusion'<>p_conclusion
    or p_receipt->>'run_id'<>p_run_id
    or p_receipt->>'request_id'<>p_request_id::text then
   raise exception 'invalid observed terminal receipt';
 end if;
 update public.socket_dispatch_requests set status=case when p_conclusion='success' then 'succeeded' else 'failed' end,
   run_id=p_run_id,receipt=p_receipt,updated_at=now()
 where id=p_request_id and status in ('dispatching','accepted','uncertain','running')
   and (mode<>'fmrl' or
     (p_receipt->>'cleanup'='independent_404'
      and exists(select 1 from public.socket_dispatch_cleanup_journal j
        where j.request_id=p_request_id and j.run_id=p_run_id and j.conclusion=p_conclusion)))
 returning id into changed;
 return changed is not null;
end $$;

-- SECURITY DEFINER only for Vault/pg_net access. All RPCs are restricted.
revoke all on function public.socket_dispatch_pump(integer) from public,anon,authenticated;
revoke all on function public.socket_dispatch_submit(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_begin(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.socket_dispatch_delivery_result(uuid,text,text) from public,anon,authenticated;
revoke all on function public.socket_dispatch_prepare_cleanup(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_finish_observed(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_immutability() from public,anon,authenticated;
revoke all on function public.socket_dispatch_enqueue() from public,anon,authenticated;
grant execute on function public.socket_dispatch_pump(integer) to service_role;
grant execute on function public.socket_dispatch_submit(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,jsonb) to service_role;
grant execute on function public.socket_dispatch_begin(uuid,uuid,text,text) to service_role;
grant execute on function public.socket_dispatch_delivery_result(uuid,text,text) to service_role;
grant execute on function public.socket_dispatch_prepare_cleanup(uuid,text,text,jsonb) to service_role;
grant execute on function public.socket_dispatch_finish_observed(uuid,text,text,jsonb) to service_role;

-- pg_cron may be absent from isolated/local Supabase stacks. Register the
-- pump only where the extension and schema exist; never block migration in CI.
-- Dispatch still remains disabled until Vault config and target allowlists are set.
do $socket_schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_namespace where nspname = 'cron') then
    execute $cron_sql$select cron.schedule(
      'atax-socket-v1-dispatch-outbox', '* * * * *',
      'select public.socket_dispatch_pump(10)'
    )$cron_sql$;
  end if;
end;
$socket_schedule$;

-- Target-scoped runner rechecks the live claim BEFORE checkout/execution.
create or replace function public.socket_dispatch_fence_valid(
 p_request_id uuid,p_claim_fence uuid,p_target_sha text
) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.socket_dispatch_requests r
   join public.tasks t on t.id=r.task_id
   join public.socket_dispatch_allowed_targets a
     on a.target_repository=r.target_repository and a.runner_repository=r.runner_repository
     and a.workflow_file=r.workflow_file and a.mode=r.mode and a.operation=r.operation
   where r.id=p_request_id and r.claim_fence=p_claim_fence and r.target_sha=p_target_sha
     and r.status in ('dispatching','accepted','running') and a.enabled
     and t.status='running' and t.claimed_by_agent_id=r.agent_id
     and t.claimed_session_id=r.session_id and t.claim_token=p_claim_fence
     and t.claim_expires_at>statement_timestamp());
$$;
revoke all on function public.socket_dispatch_fence_valid(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.socket_dispatch_fence_valid(uuid,uuid,text) to service_role;

    or p_input_payload is null or jsonb_typeof(p_input_payload)<>'object'
    or octet_length(p_input_payload::text)>8192
    or p_expected_output is null or jsonb_typeof(p_expected_output)<>'object'
    or octet_length(p_expected_output::text)>2048
    or p_input_payload ?| array['secret','token','password','credentials','authorization'] then
   raise exception 'invalid bounded execution contract';
 end if;
 select * into existing from public.socket_dispatch_requests
   where task_id=p_task_id and idempotency_key=p_idempotency_key for update;
 if found then
   if existing.claim_fence<>p_claim_fence or existing.correlation_id<>p_correlation_id
     or existing.operation<>p_operation or existing.target_repository<>p_target_repository
     or existing.runner_repository<>p_runner_repository or existing.target_sha<>p_target_sha
     or existing.workflow_file<>p_workflow_file or existing.mode<>p_mode
     or existing.input_payload<>p_input_payload or existing.expected_output<>p_expected_output then
     raise exception 'idempotency collision with different immutable request';
   end if;
   return existing.id;
 end if;
 insert into public.socket_dispatch_requests (
   task_id,agent_id,session_id,claim_fence,correlation_id,idempotency_key,
   operation,target_repository,runner_repository,target_sha,workflow_file,mode,input_payload,expected_output)
 values (p_task_id,p_agent_id,p_session_id,p_claim_fence,p_correlation_id,p_idempotency_key,
   p_operation,p_target_repository,p_runner_repository,p_target_sha,p_workflow_file,p_mode,p_input_payload,p_expected_output)
 returning id into created;
 return created;
end $$;

create or replace function public.socket_dispatch_enqueue() returns trigger
language plpgsql security invoker set search_path = pg_catalog,public as $$
begin
 insert into public.socket_dispatch_outbox(request_id) values(new.id);
 return new;
end $$;
drop trigger if exists socket_dispatch_enqueue_trigger on public.socket_dispatch_requests;
create trigger socket_dispatch_enqueue_trigger after insert on public.socket_dispatch_requests
for each row execute function public.socket_dispatch_enqueue();

-- One dispatch attempt is sent asynchronously by pg_net, DIRECT to GitHub.
-- Durable outbox provides retries and HTTP acknowledgement tracking; sends
-- only opaque IDs. These are workflow operations, never AI agents.
create or replace function public.socket_dispatch_pump(p_limit integer default 10)
returns integer language plpgsql security definer
set search_path = pg_catalog,public,net,vault as $$
declare cfg public.socket_dispatch_config%rowtype; token_value text;
 item record; response_code integer; response_error text; response_timeout boolean;
 response_found boolean; request_number bigint; processed integer:=0;
begin
 if p_limit < 1 or p_limit > 50 then raise exception 'outbox batch bound exceeded'; end if;
 select * into cfg from public.socket_dispatch_config where singleton=true and enabled=true;
 if not found then return 0; end if;
 if cfg.github_token_secret_id is not null then
   select decrypted_secret into token_value from vault.decrypted_secrets where id=cfg.github_token_secret_id;
 end if;
 if token_value is null or length(token_value)<10 then
   update public.socket_dispatch_outbox
   set state='blocked_credentials',last_error_class='missing_github_token',
       next_attempt_at=now()+interval '5 minutes',updated_at=now()
   where state in ('queued','retry','sent','blocked_credentials')
     and next_attempt_at<=now();
   return 0;
 end if;
 for item in select o.request_id,o.state,o.attempts,o.http_request_id,o.next_attempt_at,
      r.correlation_id,r.status as request_status
  from public.socket_dispatch_outbox o join public.socket_dispatch_requests r on r.id=o.request_id
  where o.state in ('queued','retry','sent','blocked_credentials') and o.next_attempt_at<=now()
  order by o.next_attempt_at,o.request_id for update of o skip locked limit p_limit loop
   if item.state='sent' then
     select status_code,error_msg,timed_out,true into response_code,response_error,response_timeout,response_found
       from net._http_response where id=item.http_request_id;
     if response_found and response_code=204 then
       update public.socket_dispatch_outbox set state='accepted',accepted_at=now(),updated_at=now(),last_error_class=null
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
     if response_found and response_code between 400 and 499 and response_code<>429 then
       update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='github_rejected'
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
     -- A lost HTTP response is ambiguous. Replaying the opaque relay event is
     -- safe: socket_dispatch_begin grants only one target dispatch.
     if item.attempts>=5 then
       update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='acknowledgement_exhausted'
       where request_id=item.request_id;
       processed:=processed+1; continue;
     end if;
   end if;
   if item.attempts>=5 then
      update public.socket_dispatch_outbox set state='failed',updated_at=now(),last_error_class='retry_exhausted'
      where request_id=item.request_id; continue;
   end if;
   if item.request_status in ('succeeded','failed','denied') then
      update public.socket_dispatch_outbox set state='accepted',updated_at=now() where request_id=item.request_id;
      continue;
   end if;
   begin
     select net.http_post(
       url=>'https://api.github.com/repos/'||cfg.owner||'/'||cfg.repo||'/actions/workflows/'||cfg.workflow_file||'/dispatches',
       body=>jsonb_build_object('ref',cfg.branch,'inputs',jsonb_build_object(
         'request_id',item.request_id::text,'correlation_id',item.correlation_id::text)),
       headers=>jsonb_build_object('Accept','application/vnd.github+json',
         'X-GitHub-Api-Version','2022-11-28','Authorization','Bearer '||token_value,
         'Content-Type','application/json'),
       timeout_milliseconds=>10000) into request_number;
     update public.socket_dispatch_outbox set state='sent',attempts=attempts+1,
        http_request_id=request_number,next_attempt_at=now()+interval '2 minutes',
        last_error_class=null,updated_at=now() where request_id=item.request_id;
     processed:=processed+1;
   exception when others then
     update public.socket_dispatch_outbox set state='retry',attempts=attempts+1,
       next_attempt_at=now()+interval '2 minutes',last_error_class='request_queue_error',updated_at=now()
       where request_id=item.request_id;
   end;
 end loop;
 return processed;
end $$;

-- Only a presently fenced holder may start. Duplicate relay runs are inert.
create or replace function public.socket_dispatch_begin(
 p_request_id uuid,p_fence uuid,p_agent text,p_session text
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare acquired uuid;
begin
 update public.socket_dispatch_requests r set status='dispatching',updated_at=now()
 where r.id=p_request_id and r.status='queued' and r.claim_fence=p_fence
  and r.agent_id=p_agent and r.session_id=p_session
  and exists(select 1 from public.tasks t where t.id=r.task_id and t.status='running'
    and t.claimed_by_agent_id=p_agent and t.claimed_session_id=p_session
    and t.claim_token=p_fence and t.claim_expires_at>statement_timestamp())
  and exists(select 1 from public.socket_dispatch_allowed_targets a where a.enabled
    and a.target_repository=r.target_repository and a.runner_repository=r.runner_repository
    and a.workflow_file=r.workflow_file and a.mode=r.mode and a.operation=r.operation)
 returning r.id into acquired;
 return acquired is not null;
end $$;

create or replace function public.socket_dispatch_delivery_result(
 p_request_id uuid,p_state text,p_error_class text default null
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare changed uuid;
begin
 if p_state not in ('accepted','uncertain','failed') then raise exception 'invalid dispatch acknowledgement state'; end if;
 update public.socket_dispatch_requests set status=p_state,error_class=left(p_error_class,80),updated_at=now()
 where id=p_request_id and status='dispatching' returning id into changed;
 return changed is not null;
end $$;

-- Durable prepare-first terminal observation: cleanup is not yet attested.
create or replace function public.socket_dispatch_prepare_cleanup(
 p_request_id uuid,p_run_id text,p_conclusion text,p_receipt jsonb
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare previous public.socket_dispatch_cleanup_journal%rowtype;
begin
 if p_run_id !~ '^[0-9]{1,24}$'
   or p_conclusion not in ('success','failure','cancelled','timed_out','action_required')
   or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
   or octet_length(p_receipt::text)>4096
   or p_receipt->>'request_id' <> p_request_id::text
   or p_receipt->>'conclusion' <> p_conclusion
   or p_receipt->>'run_id' <> p_run_id
   or p_receipt->>'cleanup' <> 'pending' then
   raise exception 'invalid cleanup preparation';
 end if;
 if not exists(select 1 from public.socket_dispatch_requests r
   where r.id=p_request_id and r.mode='fmrl'
     and r.status in ('dispatching','accepted','uncertain','running')) then
   raise exception 'not a pending disposable execution';
 end if;
 insert into public.socket_dispatch_cleanup_journal(request_id,run_id,conclusion,receipt)
 values(p_request_id,p_run_id,p_conclusion,p_receipt)
 on conflict(request_id) do nothing;
 select * into previous from public.socket_dispatch_cleanup_journal where request_id=p_request_id;
 if previous.run_id <> p_run_id or previous.conclusion <> p_conclusion
   or previous.receipt <> p_receipt then
    raise exception 'immutable cleanup observation collision';
 end if;
 return true;
end $$;

-- Called only by the trusted observer after querying the target GitHub Actions
-- run status. No task-bound agent has database service-role credentials.
create or replace function public.socket_dispatch_finish_observed(
 p_request_id uuid,p_run_id text,p_conclusion text,p_receipt jsonb
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare changed uuid;
begin
 if p_conclusion not in ('success','failure','cancelled','timed_out','action_required')
    or p_run_id !~ '^[0-9]{1,24}$'
    or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>4096
    or p_receipt->>'conclusion'<>p_conclusion
    or p_receipt->>'run_id'<>p_run_id
    or p_receipt->>'request_id'<>p_request_id::text then
   raise exception 'invalid observed terminal receipt';
 end if;
 update public.socket_dispatch_requests set status=case when p_conclusion='success' then 'succeeded' else 'failed' end,
   run_id=p_run_id,receipt=p_receipt,updated_at=now()
 where id=p_request_id and status in ('dispatching','accepted','uncertain','running')
   and (mode<>'fmrl' or
     (p_receipt->>'cleanup'='independent_404'
      and exists(select 1 from public.socket_dispatch_cleanup_journal j
        where j.request_id=p_request_id and j.run_id=p_run_id and j.conclusion=p_conclusion)))
 returning id into changed;
 return changed is not null;
end $$;

-- SECURITY DEFINER only for Vault/pg_net access. All RPCs are restricted.
revoke all on function public.socket_dispatch_pump(integer) from public,anon,authenticated;
revoke all on function public.socket_dispatch_submit(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_begin(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.socket_dispatch_delivery_result(uuid,text,text) from public,anon,authenticated;
revoke all on function public.socket_dispatch_prepare_cleanup(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_finish_observed(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.socket_dispatch_immutability() from public,anon,authenticated;
revoke all on function public.socket_dispatch_enqueue() from public,anon,authenticated;
grant execute on function public.socket_dispatch_pump(integer) to service_role;
grant execute on function public.socket_dispatch_submit(uuid,text,text,uuid,uuid,text,text,text,text,text,text,text,jsonb,jsonb) to service_role;
grant execute on function public.socket_dispatch_begin(uuid,uuid,text,text) to service_role;
grant execute on function public.socket_dispatch_delivery_result(uuid,text,text) to service_role;
grant execute on function public.socket_dispatch_prepare_cleanup(uuid,text,text,jsonb) to service_role;
grant execute on function public.socket_dispatch_finish_observed(uuid,text,text,jsonb) to service_role;

-- pg_cron may be absent from isolated/local Supabase stacks. Register the
-- pump only where the extension and schema exist; never block migration in CI.
-- Dispatch still remains disabled until Vault config and target allowlists are set.
do $socket_schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_namespace where nspname = 'cron') then
    execute $cron_sql$select cron.schedule(
      'atax-socket-v1-dispatch-outbox', '* * * * *',
      'select public.socket_dispatch_pump(10)'
    )$cron_sql$;
  end if;
end;
$socket_schedule$;

-- Target-scoped runner rechecks the live claim BEFORE checkout/execution.
create or replace function public.socket_dispatch_fence_valid(
 p_request_id uuid,p_claim_fence uuid,p_target_sha text
) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.socket_dispatch_requests r
   join public.tasks t on t.id=r.task_id
   join public.socket_dispatch_allowed_targets a
     on a.target_repository=r.target_repository and a.runner_repository=r.runner_repository
     and a.workflow_file=r.workflow_file and a.mode=r.mode and a.operation=r.operation
   where r.id=p_request_id and r.claim_fence=p_claim_fence and r.target_sha=p_target_sha
     and r.status in ('dispatching','accepted','running') and a.enabled
     and t.status='running' and t.claimed_by_agent_id=r.agent_id
     and t.claimed_session_id=r.session_id and t.claim_token=p_claim_fence
     and t.claim_expires_at>statement_timestamp());
$$;
revoke all on function public.socket_dispatch_fence_valid(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.socket_dispatch_fence_valid(uuid,uuid,text) to service_role;
