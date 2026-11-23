-- Disposable database-only verification. Never write synthetic credentials to production.
BEGIN;
DO $$
DECLARE obj jsonb; ident uuid;
BEGIN
  IF has_function_privilege('anon','public.atax_mcp_runtime_config_v1()','EXECUTE') OR
     has_function_privilege('authenticated','public.atax_mcp_runtime_config_v1()','EXECUTE') OR
     has_function_privilege('anon','public.atax_mcp_socket_config_v1()','EXECUTE') OR
     has_function_privilege('authenticated','public.atax_mcp_provider_summary_v1(text)','EXECUTE')
  THEN RAISE EXCEPTION 'Privileged MCP RPC exposed to browser role'; END IF;
  IF has_function_privilege('atax_socket_restricted',
     'public.atax_mcp_runtime_config_v1()','EXECUTE')
  THEN RAISE EXCEPTION 'Restricted socket can hydrate provider secrets'; END IF;
  IF NOT has_function_privilege('atax_socket_restricted',
     'public.atax_mcp_socket_config_v1()','EXECUTE')
  THEN RAISE EXCEPTION 'Restricted socket policy inaccessible'; END IF;
  IF NOT has_function_privilege('atax_mcp_config_admin',
     'public.atax_mcp_upsert_provider_v1(text,text,text,text,text,text,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'Admin Vault setter grant missing'; END IF;
  PERFORM public.atax_mcp_set_settings_v1(
    '{"MCP_OWNER_SUBJECT":"synthetic_owner","MCP_SHARED_SUBJECT":"synthetic_owner","SOCKET_MODEL_ID":"unknown"}'::jsonb,
    'synthetic_admin');
  ident:=public.atax_mcp_upsert_provider_v1(
    'synthetic_owner','github','PRIMARY','synthetic-test-token-1234567890',
    'synthetic_admin',NULL,true);
  IF ident IS NULL THEN RAISE EXCEPTION 'Vault credential insert failed'; END IF;
  SELECT public.atax_mcp_runtime_config_v1() INTO obj;
  IF obj->'settings'->>'MCP_OWNER_SUBJECT'<>'synthetic_owner' OR
     obj->'accounts'->0->>'alias'<>'PRIMARY' OR
     obj->'accounts'->0->>'token'<>'synthetic-test-token-1234567890'
  THEN RAISE EXCEPTION 'Vault-backed config hydration mismatch'; END IF;
  SELECT public.atax_mcp_socket_config_v1() INTO obj;
  IF obj ? 'MCP_SHARED_SUBJECT' OR obj ? 'accounts' OR
     obj->>'SOCKET_MODEL_ID'<>'unknown'
  THEN RAISE EXCEPTION 'Socket policy leaked maintainer credentials'; END IF;
  PERFORM public.atax_mcp_upsert_provider_v1(
    'synthetic_owner','github','PRIMARY','rotated-synthetic-token-1234567890',
    'synthetic_admin',NULL,true);
  SELECT public.atax_mcp_runtime_config_v1() INTO obj;
  IF obj->'accounts'->0->>'token'<>'rotated-synthetic-token-1234567890'
  THEN RAISE EXCEPTION 'Vault rotation not effective'; END IF;
  PERFORM public.atax_mcp_set_provider_enabled_v1(
    'synthetic_owner','github','PRIMARY',false,'synthetic_admin');
  SELECT public.atax_mcp_runtime_config_v1() INTO obj;
  IF jsonb_array_length(obj->'accounts')<>0
  THEN RAISE EXCEPTION 'Disabled provider still served'; END IF;
  PERFORM public.atax_mcp_delete_provider_v1(
    'synthetic_owner','github','PRIMARY','synthetic_admin');
  IF EXISTS (SELECT 1 FROM atax_private.provider_accounts WHERE id=ident)
  THEN RAISE EXCEPTION 'Deleted provider still present'; END IF;
END $$;
ROLLBACK;
