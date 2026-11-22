-- Completion receipts and independent verification are fenced by correlation and stage.
create or replace function public.atax_record_typed_execution(
 p_execution uuid,p_correlation uuid,p_status text,p_receipt jsonb
) returns boolean language plpgsql security definer
set search_path=pg_catalog,public as $$
declare e public.typed_task_executions%rowtype;
begin
 if p_status not in ('executed','failed','outcome_unknown') then raise exception 'invalid execution result'; end if;
 if p_receipt is null or octet_length(p_receipt::text)>8192 then raise exception 'invalid receipt'; end if;
 select * into e from public.typed_task_executions where id=p_execution for update;
 if not found or e.stage not in ('dispatch_pending','dispatched','executing') then
  raise exception 'invalid execution stage';
 end if;
 if not exists(select 1 from public.typed_execution_outbox
 where execution_id=p_execution and correlation_id=p_correlation) then
  raise exception 'correlation mismatch';
 end if;
 update public.typed_task_executions set stage=case when p_status='executed'
 then 'verification_pending' else p_status end,
 execution_receipt=p_receipt,dispatch_correlation=p_correlation,updated_at=now()
 where id=p_execution;
 update public.typed_execution_outbox set status=case when p_status='executed'
 then 'dispatched' else 'reconcile' end,updated_at=now()
 where execution_id=p_execution and correlation_id=p_correlation;
 return true;
end $$;
revoke all on function public.atax_record_typed_execution(uuid,uuid,text,jsonb)
 from public,anon,authenticated;
create or replace function public.atax_verify_typed_execution(
 p_execution uuid,p_verifier text,p_accepted boolean,p_receipt jsonb
) returns boolean language plpgsql security definer
set search_path=pg_catalog,public as $$
declare e public.typed_task_executions%rowtype;
begin
 if p_verifier is null or trim(p_verifier)='' or p_receipt is null
 or octet_length(p_receipt::text)>8192 then raise exception 'invalid verification'; end if;
 select * into e from public.typed_task_executions where id=p_execution for update;
 if not found or e.stage <> 'verification_pending' then raise exception 'invalid verification stage'; end if;
 if p_verifier in (e.initiator_id,e.preparer_id) then raise exception 'independent verifier required'; end if;
 update public.typed_task_executions set verifier_id=p_verifier,
 stage=case when p_accepted then 'verified' else 'rejected' end,
 verification_receipt=p_receipt,updated_at=now() where id=p_execution;
 return true;
end $$;
revoke all on function public.atax_verify_typed_execution(uuid,text,boolean,jsonb)
 from public,anon,authenticated;
