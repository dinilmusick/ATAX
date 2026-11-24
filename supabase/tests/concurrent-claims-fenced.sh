#!/usr/bin/env bash
# Rollback-only real two-client PostgreSQL claim race.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must point at disposable local PostgreSQL}"
case "$DATABASE_URL" in
  *127.0.0.1:54322/postgres*|*localhost:54322/postgres*) ;;
  *) echo "Refusing claim race outside disposable Supabase 54322" >&2; exit 2 ;;
esac

cap="atax-fenced-race-$(date +%s)-$$"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$fixture\$
DECLARE goal_uuid uuid; task_row public.tasks;
BEGIN
  INSERT INTO public.goals(name,created_by_agent_id,status)
  VALUES ('Disposable claim race ${cap}','race-fixture-orchestrator','ready')
  RETURNING id INTO goal_uuid;

  SELECT * INTO task_row FROM public.task_ledger_register(
    'race-fixture-agent','Race Fixture','Single-claim regression',
    'Temporary runner fixture',ARRAY['${cap}']::text[],
    'race-fixture-session','worker',3::smallint,
    'Atomic claim concurrency','{}'::jsonb,NULL
  );

  UPDATE public.tasks t
  SET goal_id=goal_uuid,
      target=(SELECT g.target FROM public.goals g WHERE g.id=goal_uuid),
      required_capabilities=ARRAY['${cap}']::text[],
      task_role='loop_authoring'
  WHERE t.id=task_row.id;
END;
\$fixture\$;
SQL

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c \
  "SELECT id::text FROM public.task_ledger_claim_next('race-agent-alpha','Alpha','worker',ARRAY['${cap}']::text[],120)" \
  >"$tmpdir/alpha" 2>"$tmpdir/alpha.err" &
p1=$!

psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c \
  "SELECT id::text FROM public.task_ledger_claim_next('race-agent-beta','Beta','worker',ARRAY['${cap}']::text[],120)" \
  >"$tmpdir/beta" 2>"$tmpdir/beta.err" &
p2=$!

wait "$p1"
wait "$p2"

actual="$(cat "$tmpdir/alpha" "$tmpdir/beta" | grep -cE '^[0-9a-f-]{36}$' || true)"
if [[ "$actual" != 1 ]]; then
  echo "Expected exactly one successful concurrent claimant; saw $actual" >&2
  cat "$tmpdir/alpha.err" "$tmpdir/beta.err" >&2
  exit 1
fi

pass="$(psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c \
 "SELECT CASE WHEN
   (SELECT count(*) FROM public.tasks t WHERE t.required_capabilities=ARRAY['${cap}']::text[])=1
   AND EXISTS(SELECT 1 FROM public.tasks t
      WHERE t.required_capabilities=ARRAY['${cap}']::text[]
        AND t.claim_token IS NOT NULL AND t.status='running'
        AND (SELECT count(*) FROM public.task_events e
            WHERE e.task_id=t.id AND e.event_type='claimed')=1)
   THEN 'PASS' ELSE 'FAIL' END" 2>/dev/null)"

test "$pass" = PASS
echo "PASS: exactly one concurrent owner, one fencing token and one claim event"
