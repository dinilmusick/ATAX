create or replace function public.atax_mcp_instance_owner_subject_v1()
returns text language sql stable security definer
set search_path=pg_catalog,atax_private
as $$ select atax_private.instance_owner_subject_v1(); $$;
revoke all on function public.atax_mcp_instance_owner_subject_v1() from public,anon,authenticated;
grant execute on function public.atax_mcp_instance_owner_subject_v1() to atax_mcp_config_admin,atax_mcp_maintainer;

create or replace function atax_private.execute_mcp_rpc_v1(rpc_name_in text,args_in jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, atax_private
as $$
declare
  allowed_names constant text[]:=array[
    'agent_context_overview','atax_context_snapshot','system_improvement_context',
    'goal_ledger_overview','goal_ledger_get_by_key','goal_ledger_resume_by_key','goal_ledger_blocker_overview',
    'goal_ledger_set_priority','goal_ledger_add_dependency','goal_ledger_finalize_by_key','atax_goal_create_system_bounded',
    'vision_ledger_create','vision_ledger_add_target','vision_ledger_attach_tldraw','atax_goal_create_system_omni',
    'task_ledger_claim_next','atax_goal_claim_safe','task_ledger_check_claim','task_ledger_record_handoff',
    'task_ledger_heartbeat_claim','task_ledger_record_loop_iteration','task_ledger_submit_result','task_ledger_release_claim',
    'task_ledger_add_dependency','task_ledger_finalize_loop_script','task_ledger_pending_verification',
    'task_ledger_claim_verification','task_ledger_claim_verification_for_task','task_ledger_verify_result_claimed',
    'atax_socket_execute_v1','atax_mcp_skills_search_v1','atax_mcp_skill_get_v1','atax_mcp_skills_catalog_v1',
    'atax_mcp_runtime_config_v1','atax_mcp_socket_config_v1',
    'atax_mcp_verify_instance_passkey_v1','atax_mcp_create_instance_session_v1',
    'atax_mcp_validate_instance_session_v1','atax_mcp_revoke_instance_session_v1',
    'atax_mcp_instance_' || 'auth_status_v1','atax_mcp_instance_' || 'owner_subject_v1',
    'atax_mcp_audit_' || 'provider_test_v1'
  ];
  p_oid oid; p_retset boolean; names text[]; types oid[]; modes "char"[];
  input_names text[]; input_indexes int[]; supplied_count int; args_sql text:=''; input_count int:=0; i int; idx int; type_name text; arg_name text; value_json jsonb; result jsonb;
begin
  if rpc_name_in is null or not (rpc_name_in=any(allowed_names)) then raise exception 'Invalid canonical RPC'; end if;
  if args_in is null or jsonb_typeof(args_in)<>'object' then raise exception 'RPC arguments must be an object'; end if;
  supplied_count:=(select count(*) from jsonb_object_keys(args_in));
  select p.oid,p.proretset,p.proargnames,coalesce(p.proallargtypes,p.proargtypes::oidvector::oid[]),p.proargmodes
    into p_oid,p_retset,names,types,modes
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname=rpc_name_in and p.pronargs=supplied_count
   order by p.oid limit 1;
  if p_oid is null then raise exception 'Canonical RPC not found or argument count mismatch'; end if;
  input_names:=array[]::text[]; input_indexes:=array[]::int[];
  if names is not null then
    for i in 1..array_length(names,1) loop
      if modes is null or modes[i] in ('i','b','v') then
        input_count:=input_count+1; input_names:=input_names||names[i]; input_indexes:=input_indexes||i;
      end if;
    end loop;
  end if;
  if input_count<>supplied_count then raise exception 'Canonical RPC input count mismatch'; end if;
  for i in 1..input_count loop
    arg_name:=input_names[i]; idx:=input_indexes[i]; value_json:=args_in->arg_name;
    if i>1 then args_sql:=args_sql||', '; end if;
    type_name:=format_type(types[idx],null);
    if value_json is null or jsonb_typeof(value_json)='null' then
      args_sql:=args_sql||format('NULL::%s',type_name);
    elsif right(type_name,2)='[]' then
      args_sql:=args_sql||format('ARRAY(SELECT jsonb_array_elements_text(%L::jsonb))::%s',value_json::text,type_name);
    elsif type_name in ('jsonb','json') then
      args_sql:=args_sql||format('%L::%s',value_json::text,type_name);
    else
      args_sql:=args_sql||format('%L::%s',value_json#>>'{}',type_name);
    end if;
  end loop;
  if p_retset then
    execute format('select coalesce(jsonb_agg(to_jsonb(row_data)),''[]''::jsonb) from public.%I(%s) row_data',rpc_name_in,args_sql) into result;
  else
    execute format('select to_jsonb(public.%I(%s))',rpc_name_in,args_sql) into result;
  end if;
  return coalesce(result,'null'::jsonb);
end; $$;

create or replace function public.atax_mcp_execute_rpc_v1(rpc_name_in text,args_in jsonb)
returns jsonb language sql security definer set search_path=pg_catalog,atax_private
as $$ select atax_private.execute_mcp_rpc_v1(rpc_name_in,args_in); $$;
revoke all on function public.atax_mcp_execute_rpc_v1(text,jsonb) from public,anon,authenticated;
grant execute on function public.atax_mcp_execute_rpc_v1(text,jsonb) to atax_mcp_maintainer,atax_mcp_config_admin;
