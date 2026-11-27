-- MCP claims must never accept self-asserted capabilities from tool arguments.
-- Derive claim eligibility from the server-managed agent_registry for the
-- same authenticated principal. Intelligence/suitability profiles are not
-- consulted for authorization.
BEGIN;

CREATE OR REPLACE FUNCTION public.atax_mcp_task_claim_next_v1(
  actor_id_in text,
  lease_seconds_in integer DEFAULT 120
)
RETURNS SETOF public.tasks
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $function$
DECLARE
  authorized_capabilities text[]:='{}'::text[];
  actor_name text;
BEGIN
  IF nullif(btrim(actor_id_in),'') IS NULL OR length(actor_id_in)>120 THEN
    RAISE EXCEPTION 'Authenticated MCP principal is required';
  END IF;

  SELECT agent_name,capabilities
  INTO actor_name,authorized_capabilities
  FROM public.agent_registry
  WHERE agent_id=actor_id_in AND enabled=true;

  authorized_capabilities:=coalesce(authorized_capabilities,'{}'::text[]);
  actor_name:=coalesce(actor_name,actor_id_in);

  RETURN QUERY
  SELECT * FROM public.task_ledger_claim_next(
    actor_id_in,actor_name,'mcp-external',authorized_capabilities,
    greatest(30,least(coalesce(lease_seconds_in,120),120))
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.atax_mcp_goal_claim_task_v1(
  goal_key_in text,
  actor_id_in text,
  lease_seconds_in integer DEFAULT 120
)
RETURNS SETOF public.tasks
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $function$
DECLARE
  authorized_capabilities text[]:='{}'::text[];
  actor_name text;
BEGIN
  IF nullif(btrim(actor_id_in),'') IS NULL OR length(actor_id_in)>120 THEN
    RAISE EXCEPTION 'Authenticated MCP principal is required';
  END IF;
  IF nullif(btrim(goal_key_in),'') IS NULL THEN
    RAISE EXCEPTION 'Goal key is required';
  END IF;

  SELECT agent_name,capabilities
  INTO actor_name,authorized_capabilities
  FROM public.agent_registry
  WHERE agent_id=actor_id_in AND enabled=true;

  authorized_capabilities:=coalesce(authorized_capabilities,'{}'::text[]);
  actor_name:=coalesce(actor_name,actor_id_in);

  RETURN QUERY
  SELECT * FROM public.atax_goal_claim_safe(
    goal_key_in,actor_id_in,actor_name,'mcp-external',
    authorized_capabilities,actor_id_in,
    greatest(30,least(coalesce(lease_seconds_in,120),120))
  );
END
$function$;

REVOKE ALL ON FUNCTION public.atax_mcp_task_claim_next_v1(text,integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.atax_mcp_goal_claim_task_v1(text,text,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atax_mcp_task_claim_next_v1(text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.atax_mcp_goal_claim_task_v1(text,text,integer)
  TO service_role;

COMMENT ON FUNCTION public.atax_mcp_task_claim_next_v1(text,integer) IS
'Canonical MCP global claim. Actor ID is provided by the authenticated MCP adapter; required capabilities are derived only from the server-managed agent registry, never from caller arguments or intelligence profiles.';
COMMENT ON FUNCTION public.atax_mcp_goal_claim_task_v1(text,text,integer) IS
'Canonical MCP goal-scoped claim. Actor ID is provided by the authenticated MCP adapter; required capabilities are derived only from the server-managed agent registry, never from caller arguments or intelligence profiles.';

COMMIT;
