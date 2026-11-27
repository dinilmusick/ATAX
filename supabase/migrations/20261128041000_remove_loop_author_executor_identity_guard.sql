-- The loop-author/executor identity split is obsolete for the current ATAX
-- execution model. Bounded execution remains protected by task leases,
-- fencing tokens, checkpoint predicates and independent final verification.
CREATE OR REPLACE FUNCTION public.atax_goal_claim_safe(
  goal_key_in text,
  agent_id_in text,
  agent_name_in text,
  agent_type_in text DEFAULT 'mcp-external',
  capabilities_in text[] DEFAULT '{}',
  session_id_in text DEFAULT NULL,
  lease_seconds_in integer DEFAULT 900
)
RETURNS SETOF public.tasks
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
declare goal_uuid uuid;
begin
  select id into goal_uuid from public.goals where goal_key=goal_key_in;
  if goal_uuid is null then raise exception 'goal not found'; end if;

  return query select * from public.goal_ledger_claim_task_by_key(
    goal_key_in,agent_id_in,agent_name_in,agent_type_in,capabilities_in,session_id_in,lease_seconds_in
  );
end $function$;

NOTIFY pgrst,'reload schema';
