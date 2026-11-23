-- Canonical ATAX remote MCP configuration; no production deployment implied.
-- PostgreSQL connection roles are provisioned separately with TLS credentials.
-- Supabase Vault stores credential ciphertext; no raw secrets in app tables.
CREATE SCHEMA IF NOT EXISTS atax_private;
REVOKE ALL ON SCHEMA atax_private FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='atax_mcp_maintainer') THEN
    CREATE ROLE atax_mcp_maintainer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='atax_socket_restricted') THEN
    CREATE ROLE atax_socket_restricted NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='atax_mcp_config_admin') THEN
    CREATE ROLE atax_mcp_config_admin NOLOGIN;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS atax_private.mcp_server_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(settings)='object'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS atax_private.provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_subject text NOT NULL CHECK (length(owner_subject) BETWEEN 3 AND 200),
  provider text NOT NULL CHECK (provider IN ('github','cloudflare','vercel')),
  alias text NOT NULL CHECK (alias ~ '^[A-Z][A-Z0-9_]{0,47}$'),
  vault_secret_id uuid NOT NULL UNIQUE REFERENCES vault.secrets(id),
  provider_account_id text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_subject,provider,alias),
  CHECK (provider_account_id IS NULL OR
         provider_account_id ~ '^[A-Za-z0-9_-]{1,128}$')
);
CREATE TABLE IF NOT EXISTS atax_private.provider_credential_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_subject text NOT NULL,
  owner_subject text NOT NULL,
  account_id uuid,
  provider text,
  alias text,
  action text NOT NULL CHECK (action IN ('create','rotate','disable','enable','delete','settings')),
  outcome text NOT NULL DEFAULT 'accepted',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(actor_subject) BETWEEN 3 AND 200)
);

ALTER TABLE atax_private.mcp_server_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE atax_private.provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE atax_private.provider_credential_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA atax_private FROM PUBLIC,anon,authenticated;
INSERT INTO atax_private.mcp_server_settings(id,settings)
  VALUES(true,'{}'::jsonb) ON CONFLICT(id) DO NOTHING;

-- Maintainer server: provider secrets are decrypted ONLY in this privileged RPC.
-- No generic SQL, Vault table, or credential-get endpoint is exposed to agents.
CREATE OR REPLACE FUNCTION public.atax_mcp_runtime_config_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,atax_private,vault
AS $$
DECLARE policy jsonb; accounts jsonb; configured_owner text;
BEGIN
  SELECT settings INTO policy FROM atax_private.mcp_server_settings WHERE id=true;
  IF policy IS NULL THEN RAISE EXCEPTION 'ATAX MCP policy unavailable'; END IF;
  configured_owner := policy->>'MCP_OWNER_SUBJECT';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'provider',p.provider,'alias',p.alias,'token',v.decrypted_secret,
    'accountId',p.provider_account_id
  ) ORDER BY p.provider,p.alias),'[]'::jsonb)
  INTO accounts
  FROM atax_private.provider_accounts p
  JOIN vault.decrypted_secrets v ON v.id=p.vault_secret_id
  WHERE p.enabled AND p.owner_subject=configured_owner;
  RETURN jsonb_build_object('settings',policy,'accounts',accounts);
END $$;

-- Socket server: intentionally NOTHING about maintainer owner policy, provider
-- Vault secrets, GitHub/Cloudflare/Vercel accounts or UI sessions can be read.
CREATE OR REPLACE FUNCTION public.atax_mcp_socket_config_v1()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,atax_private
AS $$
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
  FROM atax_private.mcp_server_settings s,
       LATERAL jsonb_each(s.settings)
  WHERE s.id=true AND key IN (
    'SOCKET_AUTH_ISSUER','SOCKET_AUTH_JWKS_URL',
    'SOCKET_AUTH_AUDIENCE','SOCKET_AUTH_CLIENT_ID',
    'SOCKET_WORKFLOW_CATALOG_JSON','SOCKET_MODEL_ID'
  );
$$;

-- Server-side admin endpoint must first verify the human administrator
-- session and derive actor_subject. DB grants alone are NOT browser auth.
CREATE OR REPLACE FUNCTION public.atax_mcp_set_settings_v1(
  settings_in jsonb,actor_subject_in text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,atax_private
AS $$
DECLARE item record;
BEGIN
  IF settings_in IS NULL OR jsonb_typeof(settings_in)<>'object' OR
     actor_subject_in IS NULL OR length(actor_subject_in) NOT BETWEEN 3 AND 200
  THEN RAISE EXCEPTION 'Invalid ATAX MCP settings'; END IF;
  FOR item IN SELECT key,value FROM jsonb_each(settings_in) LOOP
    IF item.key NOT IN (
      'MCP_OWNER_SUBJECT','MCP_GITHUB_OWNER','MCP_FMRL_ALLOWED_TARGETS',
      'MCP_SHARED_TOKEN_SHA256','MCP_SHARED_SUBJECT','MCP_SHARED_SCOPES',
      'MCP_ATAX_OWNER_JWT_SUBJECT','MCP_AUTH_OWNER_SCOPES',
      'MCP_AUTH_AUTHORIZATION_SERVER','MCP_AUTH_ISSUER','MCP_AUTH_JWKS_URL',
      'MCP_AUTH_AUDIENCE','MCP_ALLOWED_ORIGINS',
      'SOCKET_AUTH_ISSUER','SOCKET_AUTH_JWKS_URL','SOCKET_AUTH_AUDIENCE',
      'SOCKET_AUTH_CLIENT_ID','SOCKET_WORKFLOW_CATALOG_JSON','SOCKET_MODEL_ID'
    ) OR jsonb_typeof(item.value)<>'string' OR length(item.value::text)>16386
    THEN RAISE EXCEPTION 'Unsupported ATAX MCP setting'; END IF;
  END LOOP;
  UPDATE atax_private.mcp_server_settings
  SET settings=settings_in,updated_by=actor_subject_in,updated_at=now()
  WHERE id=true;
  INSERT INTO atax_private.provider_credential_audit
    (actor_subject,owner_subject,action)
  VALUES(actor_subject_in,coalesce(settings_in->>'MCP_OWNER_SUBJECT',actor_subject_in),'settings');
END $$;

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
     provider_in NOT IN ('github','cloudflare','vercel') OR
     alias_in IS NULL OR alias_in !~ '^[A-Z][A-Z0-9_]{0,47}$' OR
     credential_in IS NULL OR length(credential_in) NOT BETWEEN 16 AND 8192 OR
     (account_id_in IS NOT NULL AND
       account_id_in !~ '^[A-Za-z0-9_-]{1,128}$')
  THEN RAISE EXCEPTION 'Invalid ATAX MCP provider configuration'; END IF;
  SELECT id,vault_secret_id INTO connection_id,existing_secret
  FROM atax_private.provider_accounts WHERE
    owner_subject=owner_subject_in AND provider=provider_in AND alias=alias_in FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.atax_mcp_set_provider_enabled_v1(
  owner_subject_in text,provider_in text,alias_in text,
  enabled_in boolean,actor_subject_in text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,atax_private
AS $$
DECLARE connection_id uuid;
BEGIN
  IF actor_subject_in IS NULL OR length(actor_subject_in) NOT BETWEEN 3 AND 200
  THEN RAISE EXCEPTION 'Invalid ATAX MCP actor'; END IF;
  UPDATE atax_private.provider_accounts
  SET enabled=enabled_in,updated_at=now()
  WHERE owner_subject=owner_subject_in AND provider=provider_in AND alias=alias_in
  RETURNING id INTO connection_id;
  IF connection_id IS NULL THEN RAISE EXCEPTION 'Provider account not found'; END IF;
  INSERT INTO atax_private.provider_credential_audit
    (actor_subject,owner_subject,account_id,provider,alias,action)
  VALUES(actor_subject_in,owner_subject_in,connection_id,provider_in,alias_in,
    CASE WHEN enabled_in THEN 'enable' ELSE 'disable' END);
END $$;

CREATE OR REPLACE FUNCTION public.atax_mcp_delete_provider_v1(
  owner_subject_in text,provider_in text,alias_in text,actor_subject_in text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,atax_private,vault
AS $$
DECLARE connection_id uuid; secret_id uuid;
BEGIN
  IF actor_subject_in IS NULL OR length(actor_subject_in) NOT BETWEEN 3 AND 200
  THEN RAISE EXCEPTION 'Invalid ATAX MCP actor'; END IF;
  SELECT id,vault_secret_id INTO connection_id,secret_id
  FROM atax_private.provider_accounts
  WHERE owner_subject=owner_subject_in AND provider=provider_in AND alias=alias_in FOR UPDATE;
  IF connection_id IS NULL THEN RAISE EXCEPTION 'Provider account not found'; END IF;
  DELETE FROM atax_private.provider_accounts WHERE id=connection_id;
  DELETE FROM vault.secrets WHERE id=secret_id;
  INSERT INTO atax_private.provider_credential_audit
    (actor_subject,owner_subject,account_id,provider,alias,action)
  VALUES(actor_subject_in,owner_subject_in,connection_id,provider_in,alias_in,'delete');
END $$;

CREATE OR REPLACE FUNCTION public.atax_mcp_provider_summary_v1(owner_subject_in text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,atax_private
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'provider',p.provider,'alias',p.alias,
    'accountId',p.provider_account_id,'enabled',p.enabled,
    'createdAt',p.created_at,'updatedAt',p.updated_at
  ) ORDER BY p.provider,p.alias),'[]'::jsonb)
  FROM atax_private.provider_accounts p WHERE p.owner_subject=owner_subject_in;
$$;

REVOKE ALL ON FUNCTION public.atax_mcp_runtime_config_v1() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_socket_config_v1() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_set_settings_v1(jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_upsert_provider_v1(text,text,text,text,text,text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_set_provider_enabled_v1(text,text,text,boolean,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_delete_provider_v1(text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_provider_summary_v1(text) FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.atax_mcp_runtime_config_v1() TO atax_mcp_maintainer;
GRANT EXECUTE ON FUNCTION public.atax_mcp_socket_config_v1() TO atax_socket_restricted;
GRANT EXECUTE ON FUNCTION public.atax_mcp_set_settings_v1(jsonb,text) TO atax_mcp_config_admin;
GRANT EXECUTE ON FUNCTION public.atax_mcp_upsert_provider_v1(text,text,text,text,text,text,boolean) TO atax_mcp_config_admin;
GRANT EXECUTE ON FUNCTION public.atax_mcp_set_provider_enabled_v1(text,text,text,boolean,text) TO atax_mcp_config_admin;
GRANT EXECUTE ON FUNCTION public.atax_mcp_delete_provider_v1(text,text,text,text) TO atax_mcp_config_admin;
GRANT EXECUTE ON FUNCTION public.atax_mcp_provider_summary_v1(text) TO atax_mcp_config_admin;

-- The maintainer's predefined RPCs may be granted individually by release
-- owner after exact live-function audit; do not grant unrestricted SQL/table
-- access. The restricted socket execution RPC is intentionally NOT granted
-- before independently verified Socket V1 release and production migration.
