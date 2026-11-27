-- Context pages are monotonic per task. The task row and cursor row are locked
-- by the canonical socket transaction; concurrent pulls with the same offset
-- serialize, so only the first can advance. A new live task claim can resume by
-- omitting cursor and receiving the server's stored next offset.

CREATE TABLE IF NOT EXISTS public.socket_context_cursors (
  task_id uuid PRIMARY KEY REFERENCES public.tasks(id) ON DELETE CASCADE,
  next_offset integer NOT NULL DEFAULT 0 CHECK (next_offset>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.socket_context_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.socket_context_cursors FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.socket_context_cursors TO service_role;

DO $migration$
DECLARE
  fn regprocedure:=to_regprocedure('public.atax_socket_execute_v1(jsonb)');
  source_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  matches integer;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'WorkSocket context cursor migration: socket gateway is missing';
  END IF;
  SELECT pg_get_functiondef(fn) INTO source_definition;

  old_fragment := $old$v_page integer; v_limit integer; v_idx text;$old$;
  new_fragment := $new$v_page integer; v_limit integer; v_idx text;
  v_context_cursor public.socket_context_cursors%ROWTYPE;$new$;
  matches := (length(source_definition)-length(replace(source_definition,old_fragment,''))) /
    greatest(length(old_fragment),1);
  IF matches<>1 THEN RAISE EXCEPTION 'Context cursor migration drift in declarations: % matches',matches; END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);

  old_fragment := $old$v_idx:=coalesce(v_payload->>'cursor','0');
      IF v_idx !~ '^[0-9]{1,4}$' THEN
        RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS');
      END IF;
      v_page:=v_idx::integer;$old$;
  new_fragment := $new$INSERT INTO public.socket_context_cursors(task_id)
        VALUES(v_task_id) ON CONFLICT(task_id) DO NOTHING;
      SELECT * INTO v_context_cursor FROM public.socket_context_cursors
        WHERE task_id=v_task_id FOR UPDATE;
      v_idx:=v_payload->>'cursor';
      IF v_idx IS NULL THEN
        v_page:=v_context_cursor.next_offset;
      ELSE
        IF v_idx !~ '^[0-9]{1,10}$' THEN
          RETURN jsonb_build_object('status','denied','code','INVALID_ARGUMENTS');
        END IF;
        v_page:=v_idx::integer;
        IF v_page<>v_context_cursor.next_offset THEN
          RETURN jsonb_build_object('status','denied','code','STALE_CURSOR',
            'expected_cursor',v_context_cursor.next_offset::text);
        END IF;
      END IF;$new$;
  matches := (length(source_definition)-length(replace(source_definition,old_fragment,''))) /
    greatest(length(old_fragment),1);
  IF matches<>1 THEN RAISE EXCEPTION 'Context cursor migration drift in pull branch: % matches',matches; END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);

  old_fragment := $old$  -- Side effects are performed only after the exact wire response is reserved.
  IF v_operation='atomisation_request' THEN$old$;
  new_fragment := $new$  -- Advance the cursor only after the page's exact response was reserved.
  -- The parent task row and cursor row are locked for this transaction, so a
  -- second simultaneous pull using the previous cursor observes STALE_CURSOR.
  IF v_operation='context_pull' THEN
    UPDATE public.socket_context_cursors
    SET next_offset=v_page+v_limit,updated_at=now()
    WHERE task_id=v_task_id AND next_offset=v_page;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status','denied','code','STALE_CURSOR');
    END IF;
  END IF;
  -- Side effects are performed only after the exact wire response is reserved.
  IF v_operation='atomisation_request' THEN$new$;
  matches := (length(source_definition)-length(replace(source_definition,old_fragment,''))) /
    greatest(length(old_fragment),1);
  IF matches<>1 THEN RAISE EXCEPTION 'Context cursor migration drift before side effects: % matches',matches; END IF;
  source_definition:=replace(source_definition,old_fragment,new_fragment);

  EXECUTE source_definition;
END
$migration$;

COMMENT ON TABLE public.socket_context_cursors IS
'Monotonic per-task cursor for bounded WorkSocket context pulls. Each pull must use the exact next offset; concurrent/stale offsets are rejected and a new authenticated claim may resume by omitting the cursor.';
