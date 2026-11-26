-- Expand ATAX provider account vault records to FRNES compute providers.
ALTER TABLE atax_private.provider_accounts DROP CONSTRAINT IF EXISTS provider_accounts_provider_check;
ALTER TABLE atax_private.provider_accounts ADD CONSTRAINT provider_accounts_provider_check
  CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$');

CREATE OR REPLACE FUNCTION public.atax_mcp_upsert_provider_v1(
  owner_subject_in text,provider_in text,alias_in text,credential_in text,
  actor_subject_in text,account_id_in text DEFAULT NULL,enabled_in boolean DEFAULT true
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,atax_private,vault
AS $$
DECLARE existing_secret uuid; connection_id uuid; operation text;
BEGIN
  IF owner_subject_in IS NULL OR length(owner_subject_in) NOT BETWEEN 3 AND 200 OR
     actor_subject_in IS NULL OR length(actor_subject_in) NOT BETWEEN 3 AND 200 OR
     provider_in IS NULL OR provider_in !~ '^[a-z][a-z0-9_-]{1,63}$' OR
     alias_in IS NULL OR alias_in !~ '^[A-Z][A-Z0-9_]{0,47}$' OR
     credential_in IS NULL OR length(credential_in) NOT BETWEEN 16 AND 8192 OR
     (account_id_in IS NOT NULL AND account_id_in !~ '^[A-Za-z0-9_-]{1,128}$')
  THEN RAISE EXCEPTION 'Invalid ATAX MCP provider configuration'; END IF;
  SELECT id,vault_secret_id INTO connection_id,existing_secret
  FROM atax_private.provider_accounts
  WHERE owner_subject=owner_subject_in AND provider=provider_in AND alias=alias_in FOR UPDATE;
  IF existing_secret IS NULL THEN
    existing_secret:=vault.create_secret(credential_in,
      'atax-mcp-'||provider_in||'-'||replace(owner_subject_in,'@','-')||'-'||alias_in,
      'ATAX MCP server-owned credential');
    INSERT INTO atax_private.provider_accounts
      (owner_subject,provider,alias,vault_secret_id,provider_account_id,enabled)
    VALUES(owner_subject_in,provider_in,alias_in,existing_secret,account_id_in,enabled_in)
    RETURNING id INTO connection_id;
    operation:='create';
  ELSE
    PERFORM vault.update_secret(existing_secret,credential_in);
    UPDATE atax_private.provider_accounts
    SET provider_account_id=account_id_in,enabled=enabled_in,updated_at=now()
    WHERE id=connection_id;
    operation:='rotate';
  END IF;
  INSERT INTO atax_private.provider_credential_audit
    (actor_subject,owner_subject,account_id,provider,alias,action)
  VALUES(actor_subject_in,owner_subject_in,connection_id,provider_in,alias_in,operation);
  RETURN connection_id;
END $$;