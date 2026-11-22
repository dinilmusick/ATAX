-- Propagate the nonterminating lease-loss protocol into every active skill
-- that still contains the old generic "STOP" behaviour. New published
-- immutable versions preserve all other specialist instructions.
-- Idempotent: rerunning finds no outdated current skill version to replace.
WITH candidates AS MATERIALIZED (
  SELECT s.id,s.current_version_id,v.version,v.instructions,v.manifest
  FROM public.skills s
  JOIN public.skill_versions v ON v.id=s.current_version_id
  WHERE s.status='active'
    AND v.instructions LIKE '%ifFencedOut:appendHandoffFinalNote→STOP%'
  FOR UPDATE OF s
), revised AS (
  SELECT c.*,
    CASE WHEN c.version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'
      THEN split_part(c.version,'.',1)||'.'||split_part(c.version,'.',2)||'.'||
           (split_part(c.version,'.',3)::integer+1)::text
      ELSE c.version||'-socket-continuation-20261122'
    END AS next_version,
    replace(
      replace(
        c.instructions,
        'ifFencedOut:appendHandoffFinalNote→STOP',
        'ifFencedOut:STOP_OLD_TASK_ONLY→appendHandoff(oldFence,partialProgress,evidence,nextAction)→rehydrate→claimOtherFreeTask→CONTINUE_SAME_EXTERNAL_AGENT'
      ),
      'if fence is lost: append final handoff note, stop immediately, and never overwrite the new owner',
      'if fence is lost: stop only the former task, append a non-mutating handoff with old fence and evidence, rehydrate and claim another free task, continue the same external agent, and never overwrite the new owner'
    ) AS corrected
  FROM candidates c
), versions AS (
  INSERT INTO public.skill_versions
    (skill_id,version,instructions,manifest,changelog,is_published,published_at)
  SELECT r.id,r.next_version,
    replace(r.corrected,'version: '||r.version,'version: '||r.next_version),
    coalesce(r.manifest,'{}'::jsonb)||
      jsonb_build_object('version',r.next_version,'socket_forfeiture','handoff_then_other_work'),
    'ATAX task socket forfeiture is task-local; append handoff and continue with other eligible work',
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
