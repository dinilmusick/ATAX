-- Trusted typed input submission. Only privileged service role may invoke.
create or replace function public.atax_submit_typed_input(
 p_execution_id uuid, p_preparer text, p_payload jsonb,
 p_expected_revision integer, p_sha256 text
) returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare r public.typed_task_executions%rowtype; v_outbox uuid;
begin
 if p_preparer is null or length(trim(p_preparer))=0
    or p_sha256 !~ '^[0-9a-f]{64}$' then
   raise exception 'invalid submission';
 end if;
 select * into r from public.typed_task_executions
 where id=p_execution_id for update;
 if not found or r.stage <> 'initiated' or r.revision <> p_expected_revision then
   raise exception 'stale execution or invalid stage';
 end if;
 if r.initiator_id=p_preparer then raise exception 'separation of duties violated'; end if;
 if p_payload is null or pg_catalog.octet_length(p_payload::text)>4096 then
   raise exception 'payload exceeds hard byte limit';
 end if;
 if encode(extensions.digest(convert_to(p_payload::text,'UTF8'),'sha256'),'hex') <> p_sha256 then
   raise exception 'payload hash mismatch';
 end if;
 -- Trusted service must independently enforce pinned tokenizer and JSON Schema
 -- before calling. No direct untrusted grant is permitted.
 if r.contract->>'validated_schema' <> 'true'
    or r.contract->>'validated_token_budget' <> 'true' then
   raise exception 'unverified input contract';
 end if;
 update public.typed_task_executions
 set input_payload=p_payload,input_sha256=p_sha256,preparer_id=p_preparer,
 stage='dispatch_pending',updated_at=now()
 where id=p_execution_id;
 insert into public.typed_execution_outbox(execution_id,revision)
 values(p_execution_id,r.revision)
 on conflict(execution_id,revision) do update
 set updated_at=public.typed_execution_outbox.updated_at
 returning id into v_outbox;
 return v_outbox;
end $$;
revoke all on function public.atax_submit_typed_input(uuid,text,jsonb,integer,text) from public,anon,authenticated;
