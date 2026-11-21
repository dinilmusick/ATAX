-- Fail-closed atomic release gate regression. Disposable DB only; all writes rolled back.
begin;
do $fixture$
declare sid uuid; uid uuid; i integer; sha text:=repeat('a',40);
begin
  select id into sid from public.systems where system_key='atax';
  if sid is null then
    select id into uid from public.universes where status='active' limit 1;
    if uid is null then
      insert into public.universes(universe_key,name,status,description)
      values('release-gate-fixture-'||replace(gen_random_uuid()::text,'-',''),
             'Release gate fixture Universe','active','rollback-only')
      returning id into uid;
    end if;
    insert into public.systems(system_key,name,system_type,status,description,universe_id)
    values('atax','ATAX disposable release fixture','service','active',
           'No production release',uid) returning id into sid;
  end if;
  for i in 1..5 loop
    insert into public.github_check_runs(system_id,github_id,name,workflow_name,status,conclusion,sha,
      branch,url,synced_at)
    values(sid,100000000+i,'release-gate-check-'||i,'Fixture','completed','success',sha,
      'main','https://github.com/dinilmusick/ATAX/actions/runs/'||i,now());
  end loop;
end;
$fixture$;
set local role service_role;
do $tests$
declare claim1 jsonb; claim2 jsonb; claim3 jsonb; failed boolean;
  token1 uuid; token2 uuid; sha text:=repeat('a',40); note jsonb;
  github_evidence jsonb:=jsonb_build_object('source','github_rest','complete_ist_day',true,
    'repository','dinilmusick/ATAX','source_url','https://api.github.com/repos/dinilmusick/ATAX/commits?sha=main');
  cf_evidence jsonb:=jsonb_build_object('source','cloudflare_workers_deployments','complete_ist_day',true,
    'worker','atax-mcp','source_url','https://api.cloudflare.com/client/v4/accounts/fixture/workers/scripts/atax-mcp/deployments');
begin
  -- Unknown source counts MUST block release even with an exclusive lease.
  claim1:=public.atax_release_gate_acquire('release-owner-one',600);
  if claim1->>'acquired' <> 'true' then raise exception 'first lock acquisition failed'; end if;
  token1:=(claim1->>'claim_token')::uuid;
  claim2:=public.atax_release_gate_acquire('release-owner-two',600);
  if claim2->>'acquired' <> 'false' then raise exception 'concurrent lock was stolen'; end if;
  note:=jsonb_build_object('exact_head_sha',sha,'independent_verification','verified',
    'migration_compatibility','verified','evidence_url','https://github.com/dinilmusick/ATAX/pull/fixture');
  failed:=false;
  begin perform public.atax_release_gate_reserve('release-owner-one',token1,'main_update',sha,note);
  exception when others then failed:=true; end;
  if not failed then raise exception 'reservation passed without complete audited day counts'; end if;

  -- Same agent cannot sign their own audited day totals.
  failed:=false;
  begin
    perform public.atax_release_gate_attest('release-owner-one',0,0,github_evidence,cf_evidence);
  exception when others then failed:=true; end;
  if not failed then raise exception 'self-attestation unexpectedly accepted'; end if;

  perform public.atax_release_gate_attest('release-independent-auditor',0,0,github_evidence,cf_evidence);

  -- Exact head, independent compatibility and matching fresh CI are required.
  failed:=false;
  begin
    perform public.atax_release_gate_reserve('release-owner-one',token1,'main_update',
       repeat('b',40),note);
  exception when others then failed:=true; end;
  if not failed then raise exception 'mismatched exact-head evidence unexpectedly accepted'; end if;

  if (public.atax_release_gate_reserve('release-owner-one',token1,'main_update',sha,note))->>'reserved'<>'true'
  then raise exception 'first main slot not reserved'; end if;
  if (public.atax_release_gate_reserve('release-owner-one',token1,'main_update',sha,note))->>'reserved'<>'true'
  then raise exception 'second main slot not reserved'; end if;
  failed:=false;
  begin perform public.atax_release_gate_reserve('release-owner-one',token1,'main_update',sha,note);
  exception when others then failed:=true; end;
  if not failed then raise exception 'third main-branch update bypassed two-per-day budget'; end if;

  if (public.atax_release_gate_reserve('release-owner-one',token1,'worker_deployment',sha,note))->>'reserved'<>'true'
  then raise exception 'worker slot not reserved'; end if;
  if (public.atax_release_gate_reserve('release-owner-one',token1,'worker_deployment',sha,note))->>'reserved'<>'true'
  then raise exception 'second worker slot not reserved'; end if;
  failed:=false;
  begin perform public.atax_release_gate_reserve('release-owner-one',token1,'worker_deployment',sha,note);
  exception when others then failed:=true; end;
  if not failed then raise exception 'third Worker deployment bypassed two-per-day budget'; end if;

  if public.atax_release_gate_release('release-owner-two',token1) then
    raise exception 'wrong owner released lock'; end if;
  if not public.atax_release_gate_release('release-owner-one',token1) then
    raise exception 'owner could not release lock'; end if;
  claim3:=public.atax_release_gate_acquire('release-owner-two',600);
  if claim3->>'acquired'<>'true' then raise exception 'lock not reacquired'; end if;
  token2:=(claim3->>'claim_token')::uuid;
  if token2=token1 then raise exception 'fencing token did not rotate'; end if;
  failed:=false;
  begin perform public.atax_release_gate_reserve('release-owner-one',token1,'main_update',sha,note);
  exception when others then failed:=true; end;
  if not failed then raise exception 'previous owner retained release authority'; end if;
  if (select count(*) from public.atax_release_gate_events where event_type='reserved')<>4 then
    raise exception 'append-only release reservations not preserved'; end if;
  raise notice 'PASS: exclusive release lock, source-backed unknown-state hold, exact-head acceptance, both daily budgets, fencing and append-only receipts';
end;
$tests$;
reset role;
rollback;
