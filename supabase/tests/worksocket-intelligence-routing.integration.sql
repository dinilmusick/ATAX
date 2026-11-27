-- WorkSocket intelligence is deterministic, explainable and advisory only.
-- It must not claim tasks or mutate lease/status/fence state.
BEGIN;
DO $test$
DECLARE
  fixture_task uuid;
  actor text := 'service:worksocket-intelligence-test';
  first_result jsonb;
  second_result jsonb;
  first_ids text[];
  second_ids text[];
  first_scores jsonb;
  second_scores jsonb;
  task_status_before text;
  task_claim_before uuid;
  required_caps text[];
  task_kind text;
  candidate_present boolean;
  task_actor_before text;
BEGIN
  SELECT id,status,claim_token,claimed_by_agent_id
  INTO fixture_task,task_status_before,task_claim_before,task_actor_before
  FROM public.tasks
  WHERE goal_id IS NOT NULL
  ORDER BY updated_at DESC
  LIMIT 1;
  IF fixture_task IS NULL THEN
    RAISE NOTICE 'SKIP: no goal-linked task available for suitability integration fixture';
    RETURN;
  END IF;

  SELECT coalesce(required_capabilities,'{}'::text[]),coalesce(nullif(task_type,''),'default')
    INTO required_caps,task_kind FROM public.tasks WHERE id=fixture_task;
  PERFORM public.atax_worker_intelligence_profile_upsert_v1(
    'worksocket-profile-test','WorkSocket Profile Fixture','mcp-external',
    required_caps,jsonb_build_object(task_kind,0.95),
    ARRAY['test:tool-familiarity']::text[],
    CASE WHEN jsonb_typeof((SELECT target->'resources' FROM public.tasks WHERE id=fixture_task))='object'
      THEN (SELECT target->'resources' FROM public.tasks WHERE id=fixture_task)
      ELSE '{}'::jsonb END,
    ARRAY['unknown']::text[],
    jsonb_build_object('source','rollback-only integration fixture')
  );

  first_result:=public.atax_worker_suitability_v1(fixture_task,actor,10);
  second_result:=public.atax_worker_suitability_v1(fixture_task,actor,10);

  IF first_result->>'task_id' IS DISTINCT FROM fixture_task::text
     OR first_result->>'suitability_only'<>'true'
     OR jsonb_typeof(first_result->'candidates')<>'array'
     OR (first_result->>'candidate_count')::integer <>
          jsonb_array_length(first_result->'candidates') THEN
    RAISE EXCEPTION 'Suitability response shape or count is invalid: %',first_result;
  END IF;

  SELECT coalesce(array_agg(item->>'agent_id' ORDER BY ordinality),'{}'::text[])
  INTO first_ids
  FROM jsonb_array_elements(first_result->'candidates') WITH ORDINALITY candidate(item,ordinality);
  SELECT coalesce(array_agg(item->>'agent_id' ORDER BY ordinality),'{}'::text[])
  INTO second_ids
  FROM jsonb_array_elements(second_result->'candidates') WITH ORDINALITY candidate(item,ordinality);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'agent_id',item->>'agent_id',
      'score',item->'suitability_score',
      'components',item->'components',
      'evidence',item->'evidence'
    ) ORDER BY ordinality),'[]'::jsonb)
  INTO first_scores
  FROM jsonb_array_elements(first_result->'candidates') WITH ORDINALITY candidate(item,ordinality);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'agent_id',item->>'agent_id',
      'score',item->'suitability_score',
      'components',item->'components',
      'evidence',item->'evidence'
    ) ORDER BY ordinality),'[]'::jsonb)
  INTO second_scores
  FROM jsonb_array_elements(second_result->'candidates') WITH ORDINALITY candidate(item,ordinality);

  IF first_ids IS DISTINCT FROM second_ids
     OR first_scores IS DISTINCT FROM second_scores THEN
    RAISE EXCEPTION 'Suitability ordering or component scores are not deterministic';
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM jsonb_array_elements(first_result->'candidates') candidate(item)
    WHERE item->>'agent_id'='worksocket-profile-test'
  ) INTO candidate_present;
  IF NOT candidate_present THEN
    RAISE EXCEPTION 'Authenticated principal profile was not included as a suitability candidate: %',first_result;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(first_result->'candidates') candidate(item)
    WHERE jsonb_typeof(item->'components')<>'object'
       OR jsonb_typeof(item->'evidence')<>'object'
       OR item->>'suitability_score' IS NULL
       OR item->>'capability_complete' NOT IN ('true','false')
       OR item->'components'->>'capability' IS NULL
       OR item->'components'->>'reliability' IS NULL
       OR item->'components'->>'domain_affinity' IS NULL
       OR item->'components'->>'tool_familiarity' IS NULL
       OR item->'components'->>'verification' IS NULL
       OR item->'components'->>'latency' IS NULL
       OR item->'components'->>'context_efficiency' IS NULL
       OR item->'components'->>'resource_fit' IS NULL
  ) THEN
    RAISE EXCEPTION 'Suitability candidate is missing an explainable score component';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_routing_evaluations
    WHERE task_id=fixture_task
      AND requested_by_actor=actor
      AND evaluated_at>now()-interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'Suitability evaluation evidence was not persisted';
  END IF;

  IF (SELECT status FROM public.tasks WHERE id=fixture_task) IS DISTINCT FROM task_status_before
     OR (SELECT claim_token FROM public.tasks WHERE id=fixture_task) IS DISTINCT FROM task_claim_before
     OR (SELECT claimed_by_agent_id FROM public.tasks WHERE id=fixture_task) IS DISTINCT FROM task_actor_before THEN
    RAISE EXCEPTION 'Suitability evaluation mutated task claim/execution state';
  END IF;

  IF first_result->>'authorization_note' NOT ILIKE '%does not authorize%' THEN
    RAISE EXCEPTION 'Suitability response does not clearly state its advisory-only nature';
  END IF;

  RAISE NOTICE 'PASS: suitability deterministic, explainable, persisted and non-authorizing; % candidates',jsonb_array_length(first_result->'candidates');
END
$test$;
ROLLBACK;
