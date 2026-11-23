-- ATAX MCP configuration lives in canonical Supabase, not Worker environment.
-- Source-only migration: deploy after independent review and UI backend planning.
-- All secrets are encrypted by Supabase Vault; no browser or anon permissions.
CREATE TABLE IF NOT EXISTS public.atax_mcp_server_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.atax_mcp_provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('github','cloudflare','vercel')),
  alias text NOT NULL CHECK (alias ~ '^[A-Z][A-Z0-9_]{0,47}$'),
  vault_secret_id uuid NOT NULL UNIQUE REFERENCES vault.secrets(id),
  provider_account_id text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider,alias),
  CHECK (provider_account_id IS NULL OR
         provider_account_id ~ '^[A-Za-z0-9_-]{1,128}$')
);
ALTER TABLE public.atax_mcp_server_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atax_mcp_provider_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.atax_mcp_server_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.atax_mcp_provider_credentials FROM PUBLIC, anon, authenticated;
INSERT INTO public.atax_mcp_server_settings(id,settings)
  VALUES(true,'{}'::jsonb) ON CONFLICT (id) DO NOTHING;

-- Runtime configuration is callable ONLY with a privileged server-side key.
-- This response contains decrypted secrets. Never expose it through a browser.
CREATE OR REPLACE FUNCTION public.atax_mcp_runtime_config_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE result_settings jsonb; result_accounts jsonb;
BEGIN
  SELECT settings INTO result_settings
  FROM public.atax_mcp_server_settings WHERE id=true;
  IF result_settings IS NULL THEN
    RAISE EXCEPTION 'ATAX MCP settings are not configured';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'provider',p.provider,'alias',p.alias,
    'token',d.decrypted_secret,'accountId',p.provider_account_id
  ) ORDER BY p.provider,p.alias),'[]'::jsonb)
  INTO result_accounts
  FROM public.atax_mcp_provider_credentials p
  JOIN vault.decrypted_secrets d ON d.id=p.vault_secret_id
  WHERE p.enabled;
  RETURN jsonb_build_object('settings',result_settings,'accounts',result_accounts);
END; $$;

-- Only server-side authenticated administrative handlers may call setters.
-- The handlers MUST independently authorize an actual administrator session,
-- not treat possession of an anonymous frontend session as admin authority.
CREATE OR REPLACE FUNCTION public.atax_mcp_set_settings_v1(settings_in jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE item record;
BEGIN
  IF settings_in IS NULL OR jsonb_typeof(settings_in)<>'object' THEN
    RAISE EXCEPTION 'Invalid ATAX MCP settings';
  END IF;
  FOR item IN SELECT key,value FROM jsonb_each(settings_in) LOOP
    IF item.key NOT IN (
      'MCP_GITHUB_OWNER','MCP_FMRL_ALLOWED_TARGETS',
      'MCP_SHARED_TOKEN_SHA256','MCP_SHARED_SUBJECT','MCP_SHARED_SCOPES',
      'MCP_ATAX_OWNER_JWT_SUBJECT','MCP_AUTH_OWNER_SCOPES',
      'MCP_AUTH_AUTHORIZATION_SERVER','MCP_AUTH_ISSUER',
      'MCP_AUTH_JWKS_URL','MCP_AUTH_AUDIENCE','MCP_ALLOWED_ORIGINS',
      'SOCKET_AUTH_ISSUER','SOCKET_AUTH_JWKS_URL',
      'SOCKET_AUTH_AUDIENCE','SOCKET_AUTH_CLIENT_ID',
      'SOCKET_WORKFLOW_CATALOG_JSON','SOCKET_MODEL_ID'
    ) OR jsonb_typeof(item.value)<>'string' OR length(item.value::text)>16386
    THEN RAISE EXCEPTION 'Unsupported ATAX MCP setting'; END IF;
  END LOOP;
  UPDATE public.atax_mcp_server_settings
     SET settings=settings_in,updated_at=now() WHERE id=true;
END; $$;

CREATE OR REPLACE FUNCTION public.atax_mcp_upsert_provider_v1(
  provider_in text, alias_in text, credential_in text,
  account_id_in text DEFAULT NULL, enabled_in boolean DEFAULT true
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
DECLARE existing_id uuid; vault_id uuid; connection_id uuid;
BEGIN
  IF provider_in NOT IN ('github','cloudflare','vercel') OR
     alias_in IS NULL OR alias_in !~ '^[A-Z][A-Z0-9_]{0,47}$' OR
     credential_in IS NULL OR length(credential_in)<16 OR
     length(credential_in)>8192 OR
     (account_id_in IS NOT NULL AND
      account_id_in !~ '^[A-Za-z0-9_-]{1,128}$')
  THEN RAISE EXCEPTION 'Invalid ATAX MCP provider configuration'; END IF;
  SELECT id,vault_secret_id INTO connection_id,existing_id
  FROM public.atax_mcp_provider_credentials
  WHERE provider=provider_in AND alias=alias_in FOR UPDATE;
  IF existing_id IS NULL THEN
    vault_id:=vault.create_secret(credential_in,
      'atax-mcp-'||provider_in||'-'||alias_in,
      'ATAX MCP provider credential (server only)');
    INSERT INTO public.atax_mcp_provider_credentials
      (provider,alias,vault_secret_id,provider_account_id,enabled)
    VALUES(provider_in,alias_in,vault_id,account_id_in,enabled_in)
    RETURNING id INTO connection_id;
  ELSE
    PERFORM vault.update_secret(existing_id,credential_in);
    UPDATE public.atax_mcp_provider_credentials SET
      provider_account_id=account_id_in,enabled=enabled_in,updated_at=now()
    WHERE id=connection_id;
  END IF;
  RETURN connection_id;
END; $$;

CREATE OR REPLACE FUNCTION public.atax_mcp_set_provider_enabled_v1(
  provider_in text,alias_in text,enabled_in boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.atax_mcp_provider_credentials
    SET enabled=enabled_in,updated_at=now()
    WHERE provider=provider_in AND alias=alias_in;
  IF NOT FOUND THEN RAISE EXCEPTION 'ATAX MCP provider not found'; END IF;
END; $$;

REVOKE ALL ON FUNCTION public.atax_mcp_runtime_config_v1() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_set_settings_v1(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_upsert_provider_v1(text,text,text,text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_set_provider_enabled_v1(text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atax_mcp_runtime_config_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.atax_mcp_set_settings_v1(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.atax_mcp_upsert_provider_v1(text,text,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.atax_mcp_set_provider_enabled_v1(text,text,boolean) TO service_role;
