-- Rollback-only regression: generic SQL writes cannot replace a live claim.
-- Simulates the normal service_role caller, not the privileged postgres fixture user.
begin;
do $fixture$
declare
  fixture_goal_id uuid;
  registered public.tasks;
  claimed public.tasks;
begin
  insert into public.goals(name,created_by_agent_id,status)
  values ('Lease CAS regression ' || replace(gen_random_uuid()::text,'-',''),
          'lease-cas-orchestrator','ready')
  returning id into fixture_goal_id;

  select * into registered from public.task_ledger_register(
    'lease-cas-regression','Lease CAS Regression','Protected active lease',
    'Disposable lease guard fixture', array['lease-cas-regression']::text[],
    'lease-cas-fixture','worker',3::smallint,'Verify direct update guard','{}'::jsonb,null
  );
  update public.tasks set goal_id=fixture_goal_id,
    target=(select target from public.goals where id=fixture_goal_id),
    required_capabilities=array['lease-cas-regression']::text[],
    task_role='loop_authoring'
  where id=registered.id;
  select * into claimed from public.task_ledger_claim_next(
    'lease-cas-original-worker','Original Worker','worker',
    array['lease-cas-regression']::text[],900
  );
  if claimed.id is distinct from registered.id then
    raise exception 'Fixture worker was not atomically claimed';
  end if;
  perform set_config('atax.claim_lease_fixture_id',claimed.id::text,true);
  perform set_config('atax.claim_lease_fixture_token',claimed.claim_token::text,true);
end;
$fixture$;

set local role service_role;
do $guarded$
declare
  task_id uuid := current_setting('atax.claim_lease_fixture_id')::uuid;
  original_token uuid := current_setting('atax.claim_lease_fixture_token')::uuid;
  current_task public.tasks;
begin
  begin
    update public.tasks set claimed_by_agent_id='lease-cas-intruder',
      claim_token=gen_random_uuid() where id=task_id;
    raise exception 'pre-expiry owner replacement unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;

  begin
    update public.tasks set claim_expires_at=now()-interval '1 minute'
    where id=task_id;
    raise exception 'pre-expiry lease shortening unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;

  select * into current_task from public.tasks where id=task_id;
  if current_task.claimed_by_agent_id<>'lease-cas-original-worker'
     or current_task.claim_token is distinct from original_token
     or current_task.claim_expires_at<=now() then
    raise exception 'Protected owner/token/lease were modified by direct SQL';
  end if;
  if (select count(*) from public.task_events e where e.task_id=task_id and e.event_type='claimed')<>1 then
    raise exception 'Direct SQL takeover altered append-only claim evidence';
  end if;
end;
$guarded$;
reset role;
rollback;
