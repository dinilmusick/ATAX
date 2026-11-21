-- Disposable reset regression. No production release reservations.
begin;
do $test$
declare
  atax_id uuid;
  day_value text := (clock_timestamp() at time zone 'Asia/Kolkata')::date::text;
  evidence jsonb;
  reservation jsonb;
  finalized jsonb;
  lease_token uuid;
begin
  select id into atax_id from public.systems where system_key='atax' limit 1;
  if atax_id is null then
    insert into public.systems(system_key,name,status,work_priority)
    values('atax','ATAX disposable release fixture','active',95)
    returning id into atax_id;
  end if;
  -- SQL grants must not expose release authority to normal JWT clients.
  if has_function_privilege('authenticated',
       'public.atax_release_reserve(uuid,text,text,jsonb,integer)','EXECUTE')
     or has_function_privilege('anon',
       'public.atax_release_finalize(uuid,text,uuid,text,jsonb)','EXECUTE')
     or has_table_privilege('authenticated','public.atax_release_days','UPDATE')
     or has_table_privilege('service_role','public.atax_release_days','UPDATE') then
    raise exception 'release gate unexpectedly exposes direct writes or public RPC access';
  end if;
  if not has_function_privilege('service_role',
       'public.atax_release_reserve(uuid,text,text,jsonb,integer)','EXECUTE') then
    raise exception 'authorized control-plane service role cannot reserve';
  end if;
  perform set_config('atax.test_release_system_id',atax_id::text,true);
  evidence := jsonb_build_object(
    'ist_day',day_value,'verifier_agent_id','independent-release-checker',
    'verified_at',clock_timestamp(),'github_history_complete',true,
    'cloudflare_history_complete',true,'observed_main_sha',repeat('a',40),
    'main_updates',0,'worker_deployments',0,
    'source_links',jsonb_build_array('https://api.github.com/repos/dinilmusick/ATAX/commits',
                                   'https://api.cloudflare.com/client/v4/accounts/example/workers/scripts/atax-mcp/deployments')
  );
  reservation:=public.atax_release_reserve(atax_id,'release-agent','main_update',evidence,900);
  lease_token:=(reservation->>'token')::uuid;
  if lease_token is null then raise exception 'reservation returned no fencing token'; end if;
  begin
    perform public.atax_release_reserve(atax_id,'another-agent','main_update',evidence,900);
    raise exception 'second agent stole live release lock';
  exception when sqlstate '55000' then null;
  end;
  -- A second agent cannot finalize someone else's token.
  begin
    perform public.atax_release_finalize(atax_id,'another-agent',lease_token,'completed',
       evidence||jsonb_build_object('main_updates',1,'observed_main_sha',repeat('b',40)));
    raise exception 'another agent finalized this release';
  exception when sqlstate '55000' then null;
  end;
  finalized:=public.atax_release_finalize(atax_id,'release-agent',lease_token,'completed',
    evidence||jsonb_build_object('main_updates',1,'observed_main_sha',repeat('b',40)));
  if finalized->>'state'<>'completed' then raise exception 'main reservation did not complete'; end if;
  evidence:=evidence||jsonb_build_object('main_updates',1,'observed_main_sha',repeat('b',40));
  reservation:=public.atax_release_reserve(atax_id,'release-agent','worker_deployment',evidence,900);
  finalized:=public.atax_release_finalize(atax_id,'release-agent',(reservation->>'token')::uuid,
    'completed',evidence||jsonb_build_object('worker_deployments',1));
  if finalized->>'state'<>'completed' then raise exception 'deployment reservation failed'; end if;
  evidence:=evidence||jsonb_build_object('worker_deployments',1);
  reservation:=public.atax_release_reserve(atax_id,'release-agent','main_update',evidence,900);
  finalized:=public.atax_release_finalize(atax_id,'release-agent',(reservation->>'token')::uuid,
    'completed',evidence||jsonb_build_object('main_updates',2,'observed_main_sha',repeat('c',40)));
  if finalized->>'state'<>'completed' then raise exception 'second main update not counted'; end if;
  evidence:=evidence||jsonb_build_object('main_updates',2,'observed_main_sha',repeat('c',40));
  begin
    perform public.atax_release_reserve(atax_id,'release-agent','main_update',evidence,900);
    raise exception 'daily main budget was exceeded';
  exception when sqlstate '55000' then null;
  end;
  if (select count(*) from public.atax_release_events
      where system_id=atax_id and event_type='completed')<>3 then
    raise exception 'append-only release evidence count differs';
  end if;
  -- Recovery is possible only after timeout and independent re-observation.
  reservation:=public.atax_release_reserve(atax_id,'release-agent','worker_deployment',evidence,900);
  begin
    perform public.atax_release_reconcile(atax_id,'different-reconciler',evidence);
    raise exception 'an unexpired release lease was stolen during recovery';
  exception when sqlstate '55000' then null;
  end;
  update public.atax_release_days
  set lock_expires_at=now()-interval '1 second'
  where system_id=atax_id
    and ist_day=day_value::date and lock_token=(reservation->>'token')::uuid;
  finalized:=public.atax_release_reconcile(
    atax_id,'different-reconciler',
    evidence||jsonb_build_object('worker_deployments',2)
  );
  if finalized->>'state'<>'completed' then
    raise exception 'independent recovery did not count confirmed release';
  end if;
  evidence:=evidence||jsonb_build_object('worker_deployments',2);
  begin
    perform public.atax_release_reserve(atax_id,'release-agent','worker_deployment',evidence,900);
    raise exception 'daily deployment budget exceeded after independent recovery';
  exception when sqlstate '55000' then null;
  end;
  raise notice 'PASS: exclusive IST release lease, recovery, independent evidence, quotas and audit';
end;
$test$;
rollback;
