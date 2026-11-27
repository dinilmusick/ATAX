-- Restore singleton owner authorization in atax_mcp_upsert_provider_v1 (regressed in 20261126103500)
-- and allow all valid provider identifiers (including neon, vercel, compute, inference) in
-- atax_mcp_set_provider_enabled_v1 and atax_mcp_delete_provider_v1.

create or replace function public.atax_mcp_upsert_provider_v1(
  owner_subject_in text,
  provider_in text,
  alias_in text,
  credential_in text,
  actor_subject_in text,
  account_id_in text default null,
  enabled_in boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, atax_private, vault
as $$
declare
  existing_secret uuid;
  connection_id uuid;
  operation text;
  configured_owner text;
begin
  configured_owner := atax_private.instance_owner_subject_v1();

  if owner_subject_in is distinct from configured_owner
     or actor_subject_in is distinct from configured_owner then
    raise exception 'ATAX provider owner authorization failed';
  end if;

  if provider_in is null
     or provider_in !~ '^[a-z][a-z0-9_-]{1,63}$'
     or alias_in is null
     or alias_in !~ '^[A-Z][A-Z0-9_]{0,47}$'
     or credential_in is null
     or length(credential_in) not between 16 and 8192
     or (account_id_in is not null and account_id_in !~ '^[A-Za-z0-9_-]{1,128}$')
  then
    raise exception 'Invalid ATAX MCP provider configuration';
  end if;

  select id, vault_secret_id into connection_id, existing_secret
    from atax_private.provider_accounts
   where owner_subject = configured_owner
     and provider = provider_in
     and alias = alias_in
   for update;

  if existing_secret is null then
    existing_secret := vault.create_secret(
      credential_in,
      'atax-mcp-'||provider_in||'-'||replace(configured_owner,'@','-')||'-'||alias_in,
      'ATAX MCP server-owned credential'
    );
    insert into atax_private.provider_accounts
      (owner_subject,provider,alias,vault_secret_id,provider_account_id,enabled)
    values
      (configured_owner,provider_in,alias_in,existing_secret,account_id_in,enabled_in)
    returning id into connection_id;
    operation := 'create';
  else
    perform vault.update_secret(existing_secret,credential_in);
    update atax_private.provider_accounts
       set provider_account_id = account_id_in,
           enabled = enabled_in,
           updated_at = now()
     where id = connection_id;
    operation := 'rotate';
  end if;

  insert into atax_private.provider_credential_audit
    (actor_subject,owner_subject,account_id,provider,alias,action)
  values
    (configured_owner,configured_owner,connection_id,provider_in,alias_in,operation);

  return connection_id;
end;
$$;

create or replace function public.atax_mcp_set_provider_enabled_v1(
  owner_subject_in text,
  provider_in text,
  alias_in text,
  enabled_in boolean,
  actor_subject_in text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  connection_id uuid;
  configured_owner text;
begin
  configured_owner := atax_private.instance_owner_subject_v1();
  if owner_subject_in is distinct from configured_owner
     or actor_subject_in is distinct from configured_owner then
    raise exception 'ATAX provider owner authorization failed';
  end if;

  if provider_in is null or provider_in !~ '^[a-z][a-z0-9_-]{1,63}$' then
    raise exception 'Invalid ATAX MCP provider configuration';
  end if;

  update atax_private.provider_accounts
     set enabled = enabled_in, updated_at = now()
   where owner_subject = configured_owner
     and provider = provider_in
     and alias = alias_in
   returning id into connection_id;

  if connection_id is null then
    raise exception 'Provider account not found';
  end if;

  insert into atax_private.provider_credential_audit
    (actor_subject,owner_subject,account_id,provider,alias,action)
  values
    (configured_owner,configured_owner,connection_id,provider_in,alias_in,
     case when enabled_in then 'enable' else 'disable' end);
end;
$$;

create or replace function public.atax_mcp_delete_provider_v1(
  owner_subject_in text,
  provider_in text,
  alias_in text,
  actor_subject_in text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, atax_private, vault
as $$
declare
  connection_id uuid;
  secret_id uuid;
  configured_owner text;
begin
  configured_owner := atax_private.instance_owner_subject_v1();
  if owner_subject_in is distinct from configured_owner
     or actor_subject_in is distinct from configured_owner then
    raise exception 'ATAX provider owner authorization failed';
  end if;

  if provider_in is null or provider_in !~ '^[a-z][a-z0-9_-]{1,63}$' then
    raise exception 'Invalid ATAX MCP provider configuration';
  end if;

  select id,vault_secret_id into connection_id,secret_id
    from atax_private.provider_accounts
   where owner_subject=configured_owner
     and provider=provider_in
     and alias=alias_in
   for update;

  if connection_id is null then
    raise exception 'Provider account not found';
  end if;

  delete from atax_private.provider_accounts where id=connection_id;
  delete from vault.secrets where id=secret_id;

  insert into atax_private.provider_credential_audit
    (actor_subject,owner_subject,account_id,provider,alias,action)
  values
    (configured_owner,configured_owner,connection_id,provider_in,alias_in,'delete');
end;
$$;
