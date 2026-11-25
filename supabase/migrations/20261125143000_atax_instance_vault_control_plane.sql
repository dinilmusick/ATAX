-- ATAX singleton instance-auth + durable management sessions + secure RPC transport.
-- No plaintext passkeys, no browser owner identity, no operator claim flow.

create table if not exists atax_private.instance_auth (
  id boolean primary key default true check (id = true),
  passkey_hash text not null check (length(passkey_hash) >= 20),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table atax_private.instance_auth enable row level security;
alter table atax_private.instance_auth force row level security;

create table if not exists atax_private.instance_sessions (
  id uuid primary key default gen_random_uuid(),
  session_hash text not null unique check (session_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz
);

create index if not exists instance_sessions_active_idx
  on atax_private.instance_sessions(session_hash, expires_at)
  where revoked_at is null;

alter table atax_private.instance_sessions enable row level security;
alter table atax_private.instance_sessions force row level security;

revoke all on atax_private.instance_auth from public, anon, authenticated, atax_mcp_config_admin, atax_mcp_maintainer, atax_socket_restricted;
revoke all on atax_private.instance_sessions from public, anon, authenticated, atax_mcp_config_admin, atax_mcp_maintainer, atax_socket_restricted;

create or replace function atax_private.instance_owner_subject_v1()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  owner_subject text;
begin
  select nullif(trim(settings->>'MCP_OWNER_SUBJECT'),'')
    into owner_subject
    from atax_private.mcp_server_settings
   where id = true;
  if owner_subject is null or length(owner_subject) not between 3 and 200 then
    raise exception 'ATAX instance owner is not configured';
  end if;
  return owner_subject;
end;
$$;

create or replace function atax_private.initialize_instance_passkey_v1(passkey_in text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
begin
  if passkey_in is null or length(passkey_in) < 12 or length(passkey_in) > 256 then
    raise exception 'Passkey must be 12-256 characters';
  end if;

  if exists (select 1 from atax_private.instance_auth where id = true) then
    raise exception 'ATAX instance passkey is already initialized';
  end if;

  insert into atax_private.instance_auth (
    id,
    passkey_hash,
    failed_attempts,
    locked_until,
    last_success_at
  )
  values (
    true,
    extensions.crypt(passkey_in, extensions.gen_salt('bf', 12)),
    0,
    null,
    null
  );
end;
$$;

create or replace function atax_private.verify_instance_passkey_v1(passkey_in text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  row_data atax_private.instance_auth%rowtype;
  next_failed integer;
begin
  select *
    into row_data
    from atax_private.instance_auth
   where id = true
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unconfigured');
  end if;

  if row_data.locked_until is not null and row_data.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  if passkey_in is not null and extensions.crypt(passkey_in, row_data.passkey_hash) = row_data.passkey_hash then
    update atax_private.instance_auth
       set failed_attempts = 0,
           locked_until = null,
           last_success_at = now(),
           updated_at = now()
     where id = true;
    return jsonb_build_object('ok', true, 'reason', null);
  end if;

  next_failed := row_data.failed_attempts + 1;
  update atax_private.instance_auth
     set failed_attempts = next_failed,
         locked_until = case when next_failed >= 5 then now() + interval '15 minutes' else null end,
         updated_at = now()
   where id = true;

  if next_failed >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'invalid');
end;
$$;

create or replace function atax_private.create_instance_session_v1(
  session_hash_in text,
  expires_at_in timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
begin
  if session_hash_in is null or session_hash_in !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid instance session identifier';
  end if;
  if expires_at_in is null or expires_at_in <= now() or expires_at_in > now() + interval '2 hours' then
    raise exception 'Invalid instance session expiry';
  end if;

  delete from atax_private.instance_sessions
   where expires_at <= now() or revoked_at is not null;

  insert into atax_private.instance_sessions(session_hash, expires_at, last_seen_at)
  values(session_hash_in, expires_at_in, now());
end;
$$;

create or replace function atax_private.validate_instance_session_v1(session_hash_in text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  valid boolean;
begin
  if session_hash_in is null or session_hash_in !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  select exists(
    select 1
      from atax_private.instance_sessions
     where session_hash = session_hash_in
       and revoked_at is null
       and expires_at > now()
  )
  into valid;

  if valid then
    update atax_private.instance_sessions
       set last_seen_at = now()
     where session_hash = session_hash_in;
  end if;

  return valid;
end;
$$;

create or replace function atax_private.revoke_instance_session_v1(session_hash_in text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
begin
  if session_hash_in is null or session_hash_in !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  update atax_private.instance_sessions
     set revoked_at = coalesce(revoked_at, now())
   where session_hash = session_hash_in;
end;
$$;

create or replace function atax_private.instance_auth_status_v1()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, atax_private
as $$
  select jsonb_build_object(
    'passkeyConfigured', exists(select 1 from atax_private.instance_auth where id = true)
  );
$$;

create or replace function public.atax_mcp_verify_instance_passkey_v1(passkey_in text)
returns jsonb
language sql
security definer
set search_path = pg_catalog, atax_private
as $$ select atax_private.verify_instance_passkey_v1(passkey_in); $$;

create or replace function public.atax_mcp_create_instance_session_v1(
  session_hash_in text,
  expires_at_in timestamptz
)
returns void
language sql
security definer
set search_path = pg_catalog, atax_private
as $$ select atax_private.create_instance_session_v1(session_hash_in, expires_at_in); $$;

create or replace function public.atax_mcp_validate_instance_session_v1(session_hash_in text)
returns boolean
language sql
security definer
set search_path = pg_catalog, atax_private
as $$ select atax_private.validate_instance_session_v1(session_hash_in); $$;

create or replace function public.atax_mcp_revoke_instance_session_v1(session_hash_in text)
returns void
language sql
security definer
set search_path = pg_catalog, atax_private
as $$ select atax_private.revoke_instance_session_v1(session_hash_in); $$;

create or replace function public.atax_mcp_instance_auth_status_v1()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, atax_private
as $$ select atax_private.instance_auth_status_v1(); $$;

revoke all on function public.atax_mcp_verify_instance_passkey_v1(text) from public, anon, authenticated;
revoke all on function public.atax_mcp_create_instance_session_v1(text, timestamptz) from public, anon, authenticated;
revoke all on function public.atax_mcp_validate_instance_session_v1(text) from public, anon, authenticated;
revoke all on function public.atax_mcp_revoke_instance_session_v1(text) from public, anon, authenticated;
revoke all on function public.atax_mcp_instance_auth_status_v1() from public, anon, authenticated;
grant execute on function public.atax_mcp_verify_instance_passkey_v1(text) to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_create_instance_session_v1(text, timestamptz) to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_validate_instance_session_v1(text) to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_revoke_instance_session_v1(text) to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_instance_auth_status_v1() to atax_mcp_config_admin, atax_mcp_maintainer;

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

  if provider_in = 'vercel' then
    raise exception 'Vercel provider adapter is not implemented';
  end if;

  if provider_in not in ('github','cloudflare')
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

create or replace function public.atax_mcp_provider_summary_v1(owner_subject_in text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  configured_owner text;
begin
  configured_owner := atax_private.instance_owner_subject_v1();
  if owner_subject_in is distinct from configured_owner then
    raise exception 'ATAX provider owner authorization failed';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',p.id,'provider',p.provider,'alias',p.alias,
      'accountId',p.provider_account_id,'enabled',p.enabled,
      'createdAt',p.created_at,'updatedAt',p.updated_at
    ) order by p.provider,p.alias),'[]'::jsonb)
    from atax_private.provider_accounts p
    where p.owner_subject = configured_owner
  );
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

  if provider_in not in ('github','cloudflare') then
    raise exception 'Vercel provider adapter is not implemented';
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

  if provider_in not in ('github','cloudflare') then
    raise exception 'Vercel provider adapter is not implemented';
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

create or replace function public.atax_mcp_runtime_config_v1()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, atax_private, vault
as $$
declare
  policy jsonb;
  accounts jsonb;
  configured_owner text;
begin
  select settings into policy
    from atax_private.mcp_server_settings
   where id = true;

  if policy is null then
    raise exception 'ATAX MCP policy unavailable';
  end if;

  configured_owner := atax_private.instance_owner_subject_v1();

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider',p.provider,
    'alias',p.alias,
    'token',v.decrypted_secret,
    'accountId',p.provider_account_id
  ) order by p.provider,p.alias),'[]'::jsonb)
  into accounts
  from atax_private.provider_accounts p
  join vault.decrypted_secrets v on v.id=p.vault_secret_id
  where p.enabled and p.owner_subject=configured_owner;

  return jsonb_build_object('settings',policy,'accounts',accounts);
end;
$$;

create or replace function public.atax_mcp_audit_provider_test_v1(
  provider_in text,
  alias_in text,
  ok_in boolean,
  status_code_in integer,
  actor_subject_in text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  configured_owner text;
  connection_id uuid;
begin
  configured_owner := atax_private.instance_owner_subject_v1();
  if actor_subject_in is distinct from configured_owner then
    raise exception 'ATAX provider owner authorization failed';
  end if;

  select id into connection_id
    from atax_private.provider_accounts
   where owner_subject=configured_owner and provider=provider_in and alias=alias_in;

  if connection_id is null then
    raise exception 'Provider account not found';
  end if;

  insert into atax_private.provider_credential_audit
    (actor_subject,owner_subject,account_id,provider,alias,action)
  values
    (configured_owner,configured_owner,connection_id,provider_in,alias_in,'test');
end;
$$;

revoke all on function public.atax_mcp_upsert_provider_v1(text,text,text,text,text,text,boolean) from public, anon, authenticated;
revoke all on function public.atax_mcp_provider_summary_v1(text) from public, anon, authenticated;
revoke all on function public.atax_mcp_set_provider_enabled_v1(text,text,text,boolean,text) from public, anon, authenticated;
revoke all on function public.atax_mcp_delete_provider_v1(text,text,text,text) from public, anon, authenticated;
revoke all on function public.atax_mcp_runtime_config_v1() from public, anon, authenticated;
revoke all on function public.atax_mcp_audit_provider_test_v1(text,text,boolean,integer,text) from public, anon, authenticated;
grant execute on function public.atax_mcp_upsert_provider_v1(text,text,text,text,text,text,boolean) to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_provider_summary_v1(text) to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_set_provider_enabled_v1(text,text,text,boolean,text) to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_delete_provider_v1(text,text,text,text) to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_runtime_config_v1() to atax_mcp_config_admin, atax_mcp_maintainer;
grant execute on function public.atax_mcp_audit_provider_test_v1(text,text,boolean,integer,text) to atax_mcp_config_admin, atax_mcp_maintainer;

create or replace function atax_private.execute_mcp_rpc_v1(
  rpc_name_in text,
  args_in jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, atax_private
as $$
declare
  allowed_names constant text[] := array[
    'agent_context_overview','atax_context_snapshot','system_improvement_context',
    'goal_ledger_overview','goal_ledger_get_by_key','goal_ledger_resume_by_key','goal_ledger_blocker_overview',
    'goal_ledger_set_priority','goal_ledger_add_dependency','goal_ledger_finalize_by_key',
    'atax_goal_create_system_bounded','vision_ledger_create','vision_ledger_add_target',
    'vision_ledger_attach_tldraw','atax_goal_create_system_omni','task_ledger_claim_next',
    'atax_goal_claim_safe','task_ledger_check_claim','task_ledger_record_handoff',
    'task_ledger_heartbeat_claim','task_ledger_record_loop_iteration','task_ledger_submit_result',
    'task_ledger_release_claim','task_ledger_add_dependency','task_ledger_finalize_loop_script',
    'task_ledger_pending_verification','task_ledger_claim_verification',
    'task_ledger_claim_verification_for_task','task_ledger_verify_result_claimed',
    'atax_socket_execute_v1','atax_mcp_skills_search_v1','atax_mcp_skill_get_v1',
    'atax_mcp_skills_catalog_v1','atax_mcp_runtime_config_v1','atax_mcp_socket_config_v1'
  ];
  proc_oid oid;
  proc_set_return boolean;
  arg_names text[];
  arg_types oid[];
  arg_modes "char"[];
  input_names text[];
  input_indexes integer[];
  supplied_count integer;
  args_sql text := '';
  input_count integer;
  i integer;
  idx integer;
  type_name text;
  arg_name text;
  value_json jsonb;
begin
  if rpc_name_in is null or not (rpc_name_in = any(allowed_names)) then
    raise exception 'Invalid canonical RPC';
  end if;
  if args_in is null or jsonb_typeof(args_in) <> 'object' then
    raise exception 'RPC arguments must be an object';
  end if;

  supplied_count := (select count(*) from jsonb_object_keys(args_in));

  select p.oid, p.proretset, p.proargnames,
         coalesce(p.proallargtypes, p.proargtypes::oidvector::oid[]),
         p.proargmodes
    into proc_oid, proc_set_return, arg_names, arg_types, arg_modes
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname=rpc_name_in
     and p.pronargs=supplied_count
   order by p.oid
   limit 1;

  if proc_oid is null then
    raise exception 'Canonical RPC not found or argument count mismatch';
  end if;

  input_names := array[]::text[];
  input_indexes := array[]::integer[];
  input_count := 0;
  if arg_names is not null then
    for i in 1..array_length(arg_names,1) loop
      if arg_modes is null or arg_modes[i] in ('i','b','v') then
        input_count := input_count + 1;
        input_names := input_names || arg_names[i];
        input_indexes := input_indexes || i;
      end if;
    end loop;
  end if;

  if input_count <> supplied_count then
    raise exception 'Canonical RPC input count mismatch';
  end if;

  for i in 1..input_count loop
    arg_name := input_names[i];
    idx := input_indexes[i];
    value_json := args_in -> arg_name;

    if i > 1 then args_sql := args_sql || ', '; end if;
    type_name := format_type(arg_types[idx], null);

    if value_json is null or jsonb_typeof(value_json) = 'null' then
      args_sql := args_sql || format('NULL::%s', type_name);
    elsif right(type_name,2) = '[]' then
      args_sql := args_sql || format(
        'ARRAY(SELECT jsonb_array_elements_text(%L::jsonb))::%s',
        value_json::text,
        type_name
      );
    elsif type_name in ('jsonb','json') then
      args_sql := args_sql || format('%L::%s', value_json::text, type_name);
    else
      args_sql := args_sql || format('%L::%s', value_json #>> '{}', type_name);
    end if;
  end loop;

  if proc_set_return then
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(row_data)), ''[]''::jsonb) from public.%I(%s) row_data',
      rpc_name_in,
      args_sql
    ) into value_json;
  else
    execute format(
      'select to_jsonb(public.%I(%s))',
      rpc_name_in,
      args_sql
    ) into value_json;
  end if;

  return coalesce(value_json, 'null'::jsonb);
end;
$$;

create or replace function public.atax_mcp_execute_rpc_v1(rpc_name_in text, args_in jsonb)
returns jsonb
language sql
security definer
set search_path = pg_catalog, atax_private
as $$ select atax_private.execute_mcp_rpc_v1(rpc_name_in,args_in); $$;

revoke all on function public.atax_mcp_execute_rpc_v1(text,jsonb) from public, anon, authenticated;
grant execute on function public.atax_mcp_execute_rpc_v1(text,jsonb) to atax_mcp_maintainer, atax_mcp_config_admin;
