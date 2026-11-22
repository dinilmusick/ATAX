-- Publish the 120-second lease and continued-agent policy to canonical Supabase.
-- Skill versions remain immutable. No agents are created or scheduled here.
-- Safe when the current task-ledger skill is already updated or the fixture
-- database does not contain this exact earlier instruction variant.
WITH current_skill AS MATERIALIZED (
  SELECT s.id,s.current_version_id,v.version,v.instructions,v.manifest
  FROM public.skills s
  JOIN public.skill_versions v ON v.id=s.current_version_id
  WHERE s.slug='task-ledger' AND s.status='active'
    AND v.instructions LIKE '%RECOVER=heartbeatSilence>=5minutes%'
  FOR UPDATE OF s
), corrected AS (
  SELECT c.*,
    CASE WHEN c.version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'
      THEN split_part(c.version,'.',1)||'.'||split_part(c.version,'.',2)||'.'||
           (split_part(c.version,'.',3)::integer+1)::text
      ELSE c.version||'-two-minute-lease-20261122'
    END AS next_version,
    replace(c.instructions,'RECOVER=heartbeatSilence>=5minutes',
      'RECOVER=heartbeatSilence>=120seconds') ||
      E'\n\n## 120-second task socket timeout (2026-11-22)\n' ||
      'TASK_LEASE_MAX=120s; HEARTBEAT_PERIOD=30..60s; OWNERSHIP_CHECK=beforeEveryMutation; ' ||
      'RECOVERY=heartbeatSilentFor120s AND leaseExpired; ' ||
      'FENCE_LOST=stopOldSocketOnly→appendVerifiedHandoff(oldToken,partialResults,evidence,nextStep)→rehydrate→claimAnotherEligibleSocket→CONTINUE; ' ||
      'NEVER=selfRenewExpiredLease|mutateLostTask|haltAgentSolelyForLostLease|scheduleAgentInATAX.' AS corrected_instructions
  FROM current_skill c
), published AS (
  INSERT INTO public.skill_versions
    (skill_id,version,instructions,manifest,changelog,is_published,published_at)
  SELECT c.id,c.next_version,c.corrected_instructions,
    coalesce(c.manifest,'{}'::jsonb)||
      jsonb_build_object('version',c.next_version,
        'task_lease_max_seconds',120,'heartbeat_interval_seconds',60,
        'socket_forfeiture','handoff_then_other_work'),
    'Enforce two-minute task sockets; forfeited external agents write handoff and claim different work',
    true,now()
  FROM corrected c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.skill_versions sv
    WHERE sv.skill_id=c.id AND sv.version=c.next_version
  )
  RETURNING skill_id,id,instructions
)
UPDATE public.skills s
SET current_version_id=p.id,instructions=p.instructions,updated_at=now()
FROM published p,current_skill c
WHERE s.id=p.skill_id AND s.id=c.id AND s.current_version_id=c.current_version_id;
