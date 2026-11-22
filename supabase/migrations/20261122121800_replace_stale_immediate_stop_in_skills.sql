-- Remove a second, older instruction variant in five canonical specialist skills:
-- "stop immediately" meant stop the task, not terminate a healthy agent.
-- Immutable-version update keeps previous published records for audit.
WITH candidates AS MATERIALIZED (
  SELECT s.id,s.current_version_id,v.version,v.instructions,v.manifest
  FROM public.skills s
  JOIN public.skill_versions v ON v.id=s.current_version_id
  WHERE s.status='active'
    AND v.instructions LIKE '%if fence is lost: append final handoff note, stop immediately%'
  FOR UPDATE OF s
), revised AS (
  SELECT c.*,
    CASE WHEN c.version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'
      THEN split_part(c.version,'.',1)||'.'||split_part(c.version,'.',2)||'.'||
           (split_part(c.version,'.',3)::integer+1)::text
      ELSE c.version||'-task-local-handoff-20261122'
    END AS next_version,
    replace(
      c.instructions,
      'if fence is lost: append final handoff note, stop immediately, and never overwrite the new owner',
      'if fence is lost: STOP ONLY THE FORFEITED TASK; append a non-mutating handoff note with old token, partial results, evidence, and next action; rehydrate and atomically claim another eligible free task; CONTINUE THE SAME EXTERNAL AGENT; never overwrite the new owner'
    ) AS corrected
  FROM candidates c
), versions AS (
  INSERT INTO public.skill_versions
    (skill_id,version,instructions,manifest,changelog,is_published,published_at)
  SELECT r.id,r.next_version,
    replace(r.corrected,'version: '||r.version,'version: '||r.next_version),
    coalesce(r.manifest,'{}'::jsonb)||
      jsonb_build_object('version',r.next_version,'socket_forfeiture','handoff_then_other_work'),
    'Remove legacy task-loss STOP wording; continue on another free task',
    true,now()
  FROM revised r
  WHERE NOT EXISTS (
    SELECT 1 FROM public.skill_versions old
    WHERE old.skill_id=r.id AND old.version=r.next_version
  )
  RETURNING skill_id,id,instructions
)
UPDATE public.skills s
SET current_version_id=v.id,instructions=v.instructions,updated_at=now()
FROM versions v,candidates c
WHERE s.id=v.skill_id AND s.id=c.id AND s.current_version_id=c.current_version_id;
