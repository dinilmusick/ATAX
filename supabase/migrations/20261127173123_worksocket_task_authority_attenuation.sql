-- Durable task authority envelopes. Socket permissions are task-scoped and
-- children inherit a strict/equal subset from the parent. Repository/resource
-- scope is copied unchanged from the parent's target; child budgets are
-- independently constrained by the child-budget migration.
BEGIN;

CREATE TABLE IF NOT EXISTS public.socket_task_authority (
  task_id uuid PRIMARY KEY REFERENCES public.tasks(id) ON DELETE CASCADE,
  parent_task_id uuid REFERENCES public.tasks(id) ON DELETE RESTRICT,
  allowed_socket_capabilities text[] NOT NULL DEFAULT '{}'::text[],
  allowed_tool_scopes text[] NOT NULL DEFAULT '{}'::text[],
  repository_scope text[] NOT NULL DEFAULT '{}'::text[],
  resource_scope jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(resource_scope)='object'),
  authority_version integer NOT NULL DEFAULT 1 CHECK (authority_version>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS socket_task_authority_parent_idx
  ON public.socket_task_authority(parent_task_id);
ALTER TABLE public.socket_task_authority ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.socket_task_authority FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.socket_task_authority TO service_role;

CREATE OR REPLACE FUNCTION public.socket_task_authority_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $trigger$
DECLARE
  parent_authority public.socket_task_authority%ROWTYPE;
  socket_request jsonb;
  tool_request jsonb;
  requested_caps text[];
  requested_tools text[];
  root_caps text[];
  root_tools text[];
  root_repositories text[];
  root_resources jsonb;
  hard_socket_caps text[]:=ARRAY[
    'socket:context:read','socket:output:submit','socket:atomise:request',
    'socket:workflow:request','socket:task:status','socket:protocol'
  ]::text[];
  hard_tool_scopes text[]:=ARRAY['atax:read','atax:write','atax:verify']::text[];
BEGIN
  socket_request:=NEW.task_definition->'socket_authority'->'capabilities';
  tool_request:=NEW.task_definition->'socket_authority'->'tool_scopes';

  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT * INTO parent_authority
    FROM public.socket_task_authority
    WHERE task_id=NEW.parent_task_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent task has no canonical authority envelope';
    END IF;

    IF socket_request IS NULL THEN
      requested_caps:=parent_authority.allowed_socket_capabilities;
    ELSIF jsonb_typeof(socket_request)='array' THEN
      SELECT coalesce(array_agg(DISTINCT value ORDER BY value),'{}'::text[])
      INTO requested_caps FROM jsonb_array_elements_text(socket_request) value;
    ELSE
      RAISE EXCEPTION 'Child socket capability scope must be an array';
    END IF;

    IF NOT (requested_caps <@ parent_authority.allowed_socket_capabilities) THEN
      RAISE EXCEPTION 'Child socket capability scope exceeds parent authority';
    END IF;

    IF tool_request IS NULL THEN
      requested_tools:=parent_authority.allowed_tool_scopes;
    ELSIF jsonb_typeof(tool_request)='array' THEN
      SELECT coalesce(array_agg(DISTINCT value ORDER BY value),'{}'::text[])
      INTO requested_tools FROM jsonb_array_elements_text(tool_request) value;
    ELSE
      RAISE EXCEPTION 'Child tool scope must be an array';
    END IF;

    IF NOT (requested_tools <@ parent_authority.allowed_tool_scopes) THEN
      RAISE EXCEPTION 'Child tool scope exceeds parent authority';
    END IF;

    -- Resource/repository scope are never accepted from a child payload. The
    -- child task target is already copied from the parent by socket atomization.
    INSERT INTO public.socket_task_authority(
      task_id,parent_task_id,allowed_socket_capabilities,allowed_tool_scopes,
      repository_scope,resource_scope,authority_version
    ) VALUES (
      NEW.id,NEW.parent_task_id,requested_caps,requested_tools,
      parent_authority.repository_scope,parent_authority.resource_scope,
      parent_authority.authority_version+1
    );
    RETURN NEW;
  END IF;

  IF socket_request IS NULL THEN
    root_caps:=hard_socket_caps;
  ELSIF jsonb_typeof(socket_request)='array' THEN
    SELECT coalesce(array_agg(DISTINCT value ORDER BY value),'{}'::text[])
      INTO root_caps FROM jsonb_array_elements_text(socket_request) value;
  ELSE
    RAISE EXCEPTION 'Root socket capability scope must be an array';
  END IF;
  IF NOT (root_caps <@ hard_socket_caps) THEN
    RAISE EXCEPTION 'Root socket capability scope contains an unsupported operation';
  END IF;

  IF tool_request IS NULL THEN
    root_tools:=hard_tool_scopes;
  ELSIF jsonb_typeof(tool_request)='array' THEN
    SELECT coalesce(array_agg(DISTINCT value ORDER BY value),'{}'::text[])
      INTO root_tools FROM jsonb_array_elements_text(tool_request) value;
  ELSE
    RAISE EXCEPTION 'Root tool scope must be an array';
  END IF;
  IF NOT (root_tools <@ hard_tool_scopes) THEN
    RAISE EXCEPTION 'Root tool scope contains an unsupported permission';
  END IF;

  root_resources:=CASE
    WHEN jsonb_typeof(NEW.target->'resources')='object' THEN NEW.target->'resources'
    ELSE '{}'::jsonb END;
  root_repositories:=ARRAY[]::text[];
  IF jsonb_typeof(NEW.target->'repository')='string' THEN
    root_repositories:=array_append(root_repositories,NEW.target->>'repository');
  END IF;
  IF jsonb_typeof(NEW.target->'repositories')='array' THEN
    SELECT coalesce(array_agg(DISTINCT value ORDER BY value),root_repositories)
      INTO root_repositories
    FROM jsonb_array_elements_text(NEW.target->'repositories') value;
  END IF;

  INSERT INTO public.socket_task_authority(
    task_id,parent_task_id,allowed_socket_capabilities,allowed_tool_scopes,
    repository_scope,resource_scope,authority_version
  ) VALUES (
    NEW.id,NULL,root_caps,root_tools,root_repositories,root_resources,1
  );
  RETURN NEW;
END
$trigger$;

DROP TRIGGER IF EXISTS tasks_create_socket_authority ON public.tasks;
CREATE TRIGGER tasks_create_socket_authority
AFTER INSERT ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.socket_task_authority_on_insert();

-- Backfill the existing goal graph from roots down. Child capability/tool
-- requests are intersected with the parent ceiling, never unioned with it.
WITH RECURSIVE authority_tree AS (
  SELECT t.id,t.parent_task_id,
    CASE WHEN jsonb_typeof(t.task_definition->'socket_authority'->'capabilities')='array'
      THEN ARRAY(
        SELECT DISTINCT value
        FROM jsonb_array_elements_text(t.task_definition->'socket_authority'->'capabilities') value
        WHERE value=ANY(ARRAY[
          'socket:context:read','socket:output:submit','socket:atomise:request',
          'socket:workflow:request','socket:task:status','socket:protocol'
        ]::text[])
      )
      ELSE ARRAY[
        'socket:context:read','socket:output:submit','socket:atomise:request',
        'socket:workflow:request','socket:task:status','socket:protocol'
      ]::text[]
    END allowed_caps,
    CASE WHEN jsonb_typeof(t.task_definition->'socket_authority'->'tool_scopes')='array'
      THEN ARRAY(
        SELECT DISTINCT value
        FROM jsonb_array_elements_text(t.task_definition->'socket_authority'->'tool_scopes') value
        WHERE value=ANY(ARRAY['atax:read','atax:write','atax:verify']::text[])
      )
      ELSE ARRAY['atax:read','atax:write','atax:verify']::text[]
    END allowed_tools,
    CASE WHEN jsonb_typeof(t.target->'repository')='string'
      THEN ARRAY[t.target->>'repository']::text[]
      ELSE '{}'::text[] END repositories,
    CASE WHEN jsonb_typeof(t.target->'resources')='object'
      THEN t.target->'resources' ELSE '{}'::jsonb END resources,
    1::integer authority_version
  FROM public.tasks t
  WHERE t.parent_task_id IS NULL
  UNION ALL
  SELECT child.id,child.parent_task_id,
    CASE WHEN jsonb_typeof(child.task_definition->'socket_authority'->'capabilities')='array'
      THEN ARRAY(
        SELECT DISTINCT requested
        FROM jsonb_array_elements_text(child.task_definition->'socket_authority'->'capabilities') requested
        WHERE requested=ANY(parent.allowed_caps)
      )
      ELSE parent.allowed_caps END,
    CASE WHEN jsonb_typeof(child.task_definition->'socket_authority'->'tool_scopes')='array'
      THEN ARRAY(
        SELECT DISTINCT requested
        FROM jsonb_array_elements_text(child.task_definition->'socket_authority'->'tool_scopes') requested
        WHERE requested=ANY(parent.allowed_tools)
      )
      ELSE parent.allowed_tools END,
    parent.repositories,parent.resources,parent.authority_version+1
  FROM public.tasks child
  JOIN authority_tree parent ON child.parent_task_id=parent.id
)
INSERT INTO public.socket_task_authority(
  task_id,parent_task_id,allowed_socket_capabilities,allowed_tool_scopes,
  repository_scope,resource_scope,authority_version
)
SELECT id,parent_task_id,allowed_caps,allowed_tools,repositories,resources,authority_version
FROM authority_tree
ON CONFLICT(task_id) DO NOTHING;

-- Authority envelopes are immutable after creation. A new child receives its
-- own envelope only from the task-insert trigger, which validates attenuation.
CREATE OR REPLACE FUNCTION public.reject_socket_task_authority_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $guard$
BEGIN
  RAISE EXCEPTION 'Socket task authority envelopes are immutable';
END
$guard$;
DROP TRIGGER IF EXISTS socket_task_authority_append_only ON public.socket_task_authority;
CREATE TRIGGER socket_task_authority_append_only
BEFORE UPDATE OR DELETE ON public.socket_task_authority
FOR EACH ROW EXECUTE FUNCTION public.reject_socket_task_authority_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON public.socket_task_authority FROM service_role;
GRANT SELECT,INSERT ON public.socket_task_authority TO service_role;

-- Reject direct envelopes: every new envelope must be produced by the guarded
-- task insertion trigger above, never by a caller-supplied authority mutation.
CREATE OR REPLACE FUNCTION public.require_task_insert_for_socket_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $guard$
BEGIN
  IF pg_trigger_depth()=0 THEN
    RAISE EXCEPTION 'Socket task authority can only be created with a task';
  END IF;
  RETURN NEW;
END
$guard$;
DROP TRIGGER IF EXISTS socket_task_authority_insert_guard ON public.socket_task_authority;
CREATE TRIGGER socket_task_authority_insert_guard
BEFORE INSERT ON public.socket_task_authority
FOR EACH ROW EXECUTE FUNCTION public.require_task_insert_for_socket_authority();

-- No task may bootstrap a gateway capability beyond its immutable task ceiling.
DO $migration$
DECLARE
  fn regprocedure:=to_regprocedure('public.atax_socket_execute_v1(jsonb)');
  source_definition text;
  old_fragment text;
  new_fragment text;
  matches integer;
BEGIN
  IF fn IS NULL THEN RAISE EXCEPTION 'Canonical socket execution RPC is missing'; END IF;
  SELECT pg_get_functiondef(fn) INTO source_definition;
  old_fragment:=$old$  IF NOT FOUND OR v_task.status<>'running' OR v_task.task_role IS DISTINCT FROM 'execution'
     OR v_task.claim_token IS DISTINCT FROM v_claim
     OR v_task.claimed_by_agent_id IS DISTINCT FROM v_principal
     OR v_task.claimed_session_id IS DISTINCT FROM v_session
     OR v_task.claim_expires_at<=statement_timestamp()
  THEN RETURN jsonb_build_object('status','denied','code','STALE_FENCE'); END IF;$old$;
  new_fragment:=$new$  IF NOT FOUND OR v_task.status<>'running' OR v_task.task_role IS DISTINCT FROM 'execution'
     OR v_task.claim_token IS DISTINCT FROM v_claim
     OR v_task.claimed_by_agent_id IS DISTINCT FROM v_principal
     OR v_task.claimed_session_id IS DISTINCT FROM v_session
     OR v_task.claim_expires_at<=statement_timestamp()
  THEN RETURN jsonb_build_object('status','denied','code','STALE_FENCE'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.socket_task_authority authority
    WHERE authority.task_id=v_task_id
      AND v_capability=ANY(authority.allowed_socket_capabilities)
      AND 'atax:write'=ANY(authority.allowed_tool_scopes)
  ) THEN
    RETURN jsonb_build_object('status','denied','code','CAPABILITY_REVOKED');
  END IF;$new$;
  matches:=(length(source_definition)-length(replace(source_definition,old_fragment,'')))/
    greatest(length(old_fragment),1);
  IF matches<>1 THEN
    RAISE EXCEPTION 'Task authority gateway patch expected one exact fence block, found %',matches;
  END IF;
  EXECUTE replace(source_definition,old_fragment,new_fragment);
END
$migration$;

COMMENT ON TABLE public.socket_task_authority IS
'Immutable per-task maximum socket capability, tool scope, repository and resource envelope. Child tasks inherit the parent envelope or an explicit subset; they cannot widen it.';

COMMIT;
