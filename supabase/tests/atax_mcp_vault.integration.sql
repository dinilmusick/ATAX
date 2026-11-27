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
  IF has_table_privilege('anon','atax_private.instance_auth','SELECT') OR
     has_table_privilege('authenticated','atax_private.instance_auth','SELECT') OR
     has_table_privilege('anon','atax_private.instance_sessions','SELECT') OR
     has_table_privilege('authenticated','atax_private.instance_sessions','SELECT')
  THEN RAISE EXCEPTION 'Instance auth/session tables readable by browser role'; END IF;
  IF has_function_privilege('anon','atax_private.initialize_instance_passkey_v1(text)','EXECUTE') OR
     has_function_privilege('authenticated','atax_private.initialize_instance_passkey_v1(text)','EXECUTE') OR
     has_function_privilege('anon','public.atax_mcp_verify_instance_passkey_v1(text)','EXECUTE') OR
     has_function_privilege('authenticated','public.atax_mcp_verify_instance_passkey_v1(text)','EXECUTE')
  THEN RAISE EXCEPTION 'Instance auth functions exposed to browser role'; END IF;

  PERFORM atax_private.initialize_instance_passkey_v1('synthetic-instance-passkey-2026');
  IF (SELECT count(*) FROM atax_private.instance_auth WHERE id=true)<>1 THEN
    RAISE EXCEPTION 'Singleton instance auth invariant failed';
  END IF;
  IF (SELECT passkey_hash FROM atax_private.instance_auth WHERE id=true) LIKE '%synthetic-instance-passkey-2026%' THEN
    RAISE EXCEPTION 'Plaintext passkey stored';
  END IF;
  IF (atax_private.verify_instance_passkey_v1('wrong-synthetic-passkey')->>'reason')<>'invalid' THEN
    RAISE EXCEPTION 'Wrong passkey was accepted';
  END IF;
  IF NOT (atax_private.verify_instance_passkey_v1('synthetic-instance-passkey-2026')->>'ok')::boolean THEN
    RAISE EXCEPTION 'Correct passkey was rejected';
  END IF;
  BEGIN
    PERFORM atax_private.initialize_instance_passkey_v1('second-synthetic-passkey');
    RAISE EXCEPTION 'Second instance passkey initialization was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='Second instance passkey initialization was accepted' THEN RAISE; END IF;
    IF SQLERRM<>'ATAX instance passkey is already initialized' THEN RAISE; END IF;
  END;

  PERFORM atax_private.create_instance_session_v1(repeat('b',64),now()+interval '10 minutes');
  IF NOT atax_private.validate_instance_session_v1(repeat('b',64)) THEN
    RAISE EXCEPTION 'Valid instance session rejected';
  END IF;
  PERFORM atax_private.revoke_instance_session_v1(repeat('b',64));
  IF atax_private.validate_instance_session_v1(repeat('b',64)) THEN
    RAISE EXCEPTION 'Revoked instance session remained valid';
  END IF;

  PERFORM public.atax_mcp_set_settings_v1(
    '{"MCP_OWNER_SUBJECT":"synthetic_owner","MCP_SHARED_SUBJECT":"synthetic_owner","SOCKET_MODEL_ID":"unknown"}'::jsonb,
    'synthetic_admin');
  ident:=public.atax_mcp_upsert_provider_v1(
    'synthetic_owner','github','PRIMARY','synthetic-github-primary-123456',
    'synthetic_admin',NULL,true);
  IF ident IS NULL THEN RAISE EXCEPTION 'Vault credential insert failed'; END IF;
  PERFORM public.atax_mcp_upsert_provider_v1(
    'synthetic_owner','github','WORK','synthetic-github-work-123456',
    'synthetic_admin','work-org',true);
  PERFORM public.atax_mcp_upsert_provider_v1(
    'synthetic_owner','cloudflare','PRIMARY','synthetic-cloudflare-primary-123456',
    'synthetic_admin','cf-primary',true);
  PERFORM public.atax_mcp_upsert_provider_v1(
    'synthetic_owner','cloudflare','WORK','synthetic-cloudflare-work-123456',
    'synthetic_admin','cf-work',true);

  SELECT public.atax_mcp_provider_summary_v1('synthetic_owner') INTO obj;
  IF jsonb_array_length(obj)<>4 OR NOT (obj @> '[{"provider":"github","alias":"PRIMARY"},{"provider":"github","alias":"WORK"},{"provider":"cloudflare","alias":"PRIMARY"},{"provider":"cloudflare","alias":"WORK"}]'::jsonb) THEN
    RAISE EXCEPTION 'Provider multiplicity contract failed';
  END IF;
  IF obj::text LIKE '%synthetic-github-primary-123456%' OR obj::text LIKE '%token%' THEN
    RAISE EXCEPTION 'Provider listing leaked credential material';
  END IF;

  SELECT public.atax_mcp_runtime_config_v1() INTO obj;
  IF obj->'settings'->>'MCP_OWNER_SUBJECT'<>'synthetic_owner' OR
     jsonb_array_length(obj->'accounts')<>4 OR
     NOT (obj->'accounts' @> '[{"provider":"github","alias":"PRIMARY","token":"synthetic-github-primary-123456"},{"provider":"github","alias":"WORK","token":"synthetic-github-work-123456"},{"provider":"cloudflare","alias":"PRIMARY","token":"synthetic-cloudflare-primary-123456"},{"provider":"cloudflare","alias":"WORK","token":"synthetic-cloudflare-work-123456"}]'::jsonb)
  THEN RAISE EXCEPTION 'Vault-backed multi-account config hydration mismatch'; END IF;
  SELECT public.atax_mcp_socket_config_v1() INTO obj;
  IF obj ? 'MCP_SHARED_SUBJECT' OR obj ? 'accounts' OR
     obj->>'SOCKET_MODEL_ID'<>'unknown'
  THEN RAISE EXCEPTION 'Socket policy leaked maintainer credentials'; END IF;
  PERFORM public.atax_mcp_upsert_provider_v1(
    'synthetic_owner','github','PRIMARY','rotated-synthetic-token-1234567890',
    'synthetic_admin',NULL,true);
  SELECT public.atax_mcp_runtime_config_v1() INTO obj;
  IF NOT (obj->'accounts' @> '[{"provider":"github","alias":"PRIMARY","token":"rotated-synthetic-token-1234567890"}]'::jsonb)
  THEN RAISE EXCEPTION 'Vault rotation not effective'; END IF;
  PERFORM public.atax_mcp_set_provider_enabled_v1(
    'synthetic_owner','github','WORK',false,'synthetic_admin');
  SELECT public.atax_mcp_runtime_config_v1() INTO obj;
  IF obj->'accounts' @> '[{"provider":"github","alias":"WORK"}]'::jsonb THEN
    RAISE EXCEPTION 'Disabled GitHub WORK account still served';
  END IF;
  IF NOT (obj->'accounts' @> '[{"provider":"github","alias":"PRIMARY"}]'::jsonb) THEN
    RAISE EXCEPTION 'Disabling one provider account affected another';
  END IF;

  PERFORM public.atax_mcp_upsert_provider_v1(
    'synthetic_owner','github','WORK','rotated-github-work-123456',
    'synthetic_admin','work-org',true);
  SELECT public.atax_mcp_runtime_config_v1() INTO obj;
  IF NOT (obj->'accounts' @> '[{"provider":"github","alias":"WORK","token":"rotated-github-work-123456"}]'::jsonb) THEN
    RAISE EXCEPTION 'GitHub WORK rotation/reenable failed';
  END IF;

  BEGIN
    PERFORM public.atax_mcp_provider_summary_v1('attacker_owner');
    RAISE EXCEPTION 'Cross-owner provider lookup was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='Cross-owner provider lookup was accepted' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.atax_mcp_upsert_provider_v1(
      'attacker_owner','github','ATTACK','attacker-secret-123456',
      'attacker_owner',NULL,true);
    RAISE EXCEPTION 'Cross-owner provider write was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='Cross-owner provider write was accepted' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.atax_mcp_upsert_provider_v1(
      'synthetic_owner','vercel','PRIMARY','synthetic-vercel-token-123456',
      'synthetic_admin',NULL,true);
    RAISE EXCEPTION 'Unimplemented Vercel provider was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='Unimplemented Vercel provider was accepted' THEN RAISE; END IF;
  END;

  PERFORM public.atax_mcp_delete_provider_v1(
    'synthetic_owner','github','WORK','synthetic_admin');
  PERFORM public.atax_mcp_delete_provider_v1(
    'synthetic_owner','cloudflare','WORK','synthetic_admin');
  IF EXISTS (
    SELECT 1 FROM atax_private.provider_accounts
    WHERE owner_subject='synthetic_owner'
      AND ((provider='github' AND alias='WORK') OR (provider='cloudflare' AND alias='WORK'))
  ) THEN
    RAISE EXCEPTION 'Provider revoke did not remove targeted accounts';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM atax_private.provider_credential_audit
    WHERE owner_subject='synthetic_owner'
      AND provider='github'
      AND action='rotate'
  ) THEN
    RAISE EXCEPTION 'Provider rotation audit missing';
  END IF;
END $$;
ROLLBACK;
