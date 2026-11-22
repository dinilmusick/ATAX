-- Direct Supabase pg_net -> GitHub workflow_dispatch. No Worker.
-- Fail closed until an operator installs a scoped GitHub credential in Vault.
create table if not exists public.atax_github_dispatch_config (
 id boolean primary key default true check(id),
 owner text not null check(owner ~ '^[A-Za-z0-9_.-]+$'),
 repo text not null check(repo ~ '^[A-Za-z0-9_.-]+$'),
 workflow text not null check(workflow ~ '^[A-Za-z0-9_.-]+\.ya?ml$'),
 branch text not null default 'main',
 github_token_secret_id uuid not null,
 enabled boolean not null default false
);
alter table public.atax_github_dispatch_config enable row level security;
revoke all on public.atax_github_dispatch_config from public,anon,authenticated;
create or replace function public.atax_dispatch_outbox_insert()
returns trigger language plpgsql security definer
set search_path = pg_catalog,public,net,vault as $$
declare cfg public.atax_github_dispatch_config%rowtype; tok text;
begin
 select * into cfg from public.atax_github_dispatch_config where id=true and enabled=true;
 if not found then return new; end if;
 select decrypted_secret into tok from vault.decrypted_secrets
 where id=cfg.github_token_secret_id;
 if tok is null or length(tok)<10 then
   raise exception 'ATAX GitHub dispatch secret missing';
 end if;
 perform net.http_post(
 url := 'https://api.github.com/repos/'||cfg.owner||'/'||cfg.repo||
   '/actions/workflows/'||cfg.workflow||'/dispatches',
 body := jsonb_build_object('ref',cfg.branch,'inputs',
   jsonb_build_object('execution_id',new.execution_id::text,
   'correlation_id',new.correlation_id::text))::jsonb,
 headers := jsonb_build_object('Accept','application/vnd.github+json',
  'Authorization','Bearer '||tok,'X-GitHub-Api-Version','2022-11-28',
  'Content-Type','application/json'),
 timeout_milliseconds := 10000
 );
 return new;
end $$;
revoke all on function public.atax_dispatch_outbox_insert() from public,anon,authenticated;
drop trigger if exists atax_outbox_dispatch_insert on public.typed_execution_outbox;
create trigger atax_outbox_dispatch_insert after insert on public.typed_execution_outbox
for each row execute function public.atax_dispatch_outbox_insert();
comment on function public.atax_dispatch_outbox_insert() is
'Asynchronous direct GitHub dispatch; pg_net enqueue is not execution confirmation. Disabled until Vault configuration. Requires independent response reconciliation.';
