create or replace function atax_private.initialize_instance_passkey_v1(passkey_in text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, atax_private, extensions
as $$
begin
  if passkey_in is null or length(passkey_in) < 12 or length(passkey_in) > 256 then
    raise exception 'Passkey must be 12-256 characters';
  end if;
  if exists (select 1 from atax_private.instance_auth where id = true) then
    raise exception 'ATAX instance passkey is already initialized';
  end if;
  insert into atax_private.instance_auth(id,passkey_hash,failed_attempts)
  values(true,extensions.crypt(passkey_in,extensions.gen_salt('bf',12)),0);
end; $$;

create or replace function atax_private.verify_instance_passkey_v1(passkey_in text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, atax_private, extensions
as $$
declare row_data atax_private.instance_auth%rowtype; next_failed integer;
begin
  select * into row_data from atax_private.instance_auth where id = true for update;
  if not found then return jsonb_build_object('ok',false,'reason','unconfigured'); end if;
  if row_data.locked_until is not null and row_data.locked_until > now()
    then return jsonb_build_object('ok',false,'reason','locked'); end if;
  if passkey_in is not null and extensions.crypt(passkey_in,row_data.passkey_hash)=row_data.passkey_hash then
    update atax_private.instance_auth set failed_attempts=0,locked_until=null,last_success_at=now(),updated_at=now() where id=true;
    return jsonb_build_object('ok',true,'reason',null);
  end if;
  next_failed := row_data.failed_attempts + 1;
  update atax_private.instance_auth
     set failed_attempts=next_failed,
         locked_until=case when next_failed >= 5 then now()+interval '15 minutes' else null end,
         updated_at=now()
   where id=true;
  if next_failed >= 5 then return jsonb_build_object('ok',false,'reason','locked'); end if;
  return jsonb_build_object('ok',false,'reason','invalid');
end; $$;
