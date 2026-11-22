#!/usr/bin/env bash
# Two PostgreSQL connections racing for one child claim.
# Requires a dedicated/disposable ATAX test database and psql.
set -euo pipefail
: "$SOCKET_TEST_DATABASE_URL"
if [[ "$SOCKET_TEST_DISPOSABLE" != "YES" ]]; then
  echo "Set SOCKET_TEST_DISPOSABLE=YES only for an isolated test database" >&2
  exit 2
fi
command -v psql >/dev/null
root="$(cd "$(dirname "$0")/../.." && pwd)"
db="$SOCKET_TEST_DATABASE_URL"
psql "$db" -v ON_ERROR_STOP=1 -q -f "$root/supabase/migrations/20261122170000_socket_atomization_v1.sql" >/dev/null

id="race-$RANDOM-$(date +%s)"
name="socket-$id"
author="atom-$id"
worker1="exec-a-$id"
worker2="exec-b-$id"
psql "$db" -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
INSERT INTO public.socket_invocations(agent_id,session_id,authenticated_subject,role,expires_at)
VALUES ('$author','$author','test:atom','atomizer',now()+interval '1 hour'),
       ('$worker1','$worker1','test:exec-a','executor',now()+interval '1 hour'),
       ('$worker2','$worker2','test:exec-b','executor',now()+interval '1 hour');
INSERT INTO public.tasks(agent_id,agent_name,task_name,status,claimed_by_agent_id,
  claimed_by_agent_name,claimed_session_id,claim_token,claim_expires_at,task_definition)
VALUES('race-origin','race-origin','$name','running',
 '$author','$author','$author',gen_random_uuid(),now()+interval '1 hour',
 jsonb_build_object('name','$name','general_pattern','read to split to verify',
   'actions',jsonb_build_array(jsonb_build_object('description','Split work'))));
INSERT INTO public.socket_task_budgets(task_id,max_input,max_output,max_total)
SELECT id,100,100,150 FROM public.tasks WHERE task_name='$name';
SELECT public.socket_atomize_task(t.id,i.id,i.secret,t.claim_token,'split-$id',
 jsonb_build_array(
  jsonb_build_object('name','race-child-1-$id',
   'actions',jsonb_build_array(jsonb_build_object('description','Produce artifact')),
   'inputs',jsonb_build_object('seed','text'),'outputs',jsonb_build_object('artifact','text'),
   'outcome','Artifact one verified',
   'acceptance_criteria',jsonb_build_array(jsonb_build_object('description','Artifact one verified')),
   'verification',jsonb_build_object('method','independent-evidence'),
   'loop',jsonb_build_object('enabled',true,'objective','Produce artifact','max_iterations',1)),
  jsonb_build_object('name','race-child-2-$id',
   'actions',jsonb_build_array(jsonb_build_object('description','Produce other artifact')),
   'inputs',jsonb_build_object('seed','text'),'outputs',jsonb_build_object('artifact','text'),
   'outcome','Artifact two verified',
   'acceptance_criteria',jsonb_build_array(jsonb_build_object('description','Artifact two verified')),
   'verification',jsonb_build_object('method','independent-evidence'),
   'loop',jsonb_build_object('enabled',true,'objective','Produce other artifact','max_iterations',1))
 )) FROM public.tasks t JOIN public.socket_invocations i ON i.session_id='$author'
 WHERE t.task_name='$name';
SQL

child="$(psql "$db" -v ON_ERROR_STOP=1 -Atc "SELECT c.child_task_id FROM public.socket_atomization_children c JOIN public.tasks t ON t.id=c.parent_task_id WHERE t.task_name='$name' AND c.ordinal=1")"
if [[ -z "$child" ]]; then echo "Fixture child missing" >&2; exit 1; fi
sql1="SELECT (public.socket_claim_child('$child',i.id,i.secret)).id FROM public.socket_invocations i WHERE i.session_id='$worker1'"
sql2="SELECT (public.socket_claim_child('$child',i.id,i.secret)).id FROM public.socket_invocations i WHERE i.session_id='$worker2'"
PGOPTIONS="-c statement_timeout=10000" psql "$db" -v ON_ERROR_STOP=1 -Atc "$sql1" >/dev/null 2>&1 &
pid1=$!
PGOPTIONS="-c statement_timeout=10000" psql "$db" -v ON_ERROR_STOP=1 -Atc "$sql2" >/dev/null 2>&1 &
pid2=$!
rc1=0; rc2=0
wait "$pid1" || rc1=$?
wait "$pid2" || rc2=$?
if ! { [[ "$rc1" -eq 0 && "$rc2" -ne 0 ]] || [[ "$rc2" -eq 0 && "$rc1" -ne 0 ]]; }; then
  echo "FAIL: expected one winner and one denied claim (codes $rc1 and $rc2)" >&2
  exit 1
fi
psql "$db" -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
DO \$race\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks t JOIN public.socket_child_claim_grants g ON g.child_task_id=t.id
    JOIN public.socket_invocations i ON i.id=g.invocation_id
    WHERE t.id='$child'::uuid AND t.status='running' AND t.attempt_count=1
      AND t.claim_token=g.claim_token AND t.claimed_by_agent_id=i.agent_id
      AND t.claimed_session_id=i.session_id
  ) THEN RAISE EXCEPTION 'Competing claim violated exclusive fencing'; END IF;
END \$race\$;
SQL
echo "PASS: two independently authenticated connections, one fenced claim winner"
