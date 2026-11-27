-- Deterministic worker intelligence profiles and explainable suitability routing.
-- Suitability is a recommendation signal only; it never grants claim authority.
-- Actual claims remain guarded by the canonical task claim RPCs and fencing.
BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_intelligence_profiles (
  agent_id text PRIMARY KEY REFERENCES public.agent_registry(agent_id) ON DELETE CASCADE,
  domain_affinities jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(domain_affinities)='object'),
  tool_familiarity text[] NOT NULL DEFAULT '{}'::text[],
  resource_capacity jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(resource_capacity)='object'),
  model_families text[] NOT NULL DEFAULT '{}'::text[],
  notes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(notes)='object'),
  profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_routing_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  requested_by_agent_id text NOT NULL,
  candidate_agent_id text REFERENCES public.agent_registry(agent_id) ON DELETE SET NULL,
  result_kind text NOT NULL CHECK (result_kind IN ('candidate','no_candidates')),
  suitability_score numeric(6,5),
  capability_complete boolean,
  component_scores jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(component_scores)='object'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence)='object'),
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_routing_evaluations_task_recent_idx
  ON public.agent_routing_evaluations(task_id,evaluated_at DESC);
CREATE INDEX IF NOT EXISTS agent_routing_evaluations_candidate_recent_idx
  ON public.agent_routing_evaluations(candidate_agent_id,evaluated_at DESC);

ALTER TABLE public.agent_intelligence_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_routing_evaluations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_intelligence_profiles FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.agent_routing_evaluations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.agent_intelligence_profiles TO service_role;
GRANT SELECT,INSERT ON public.agent_routing_evaluations TO service_role;
REVOKE UPDATE,DELETE,TRUNCATE ON public.agent_routing_evaluations FROM service_role;

CREATE OR REPLACE FUNCTION public.reject_agent_routing_evaluation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $guard$
BEGIN
  RAISE EXCEPTION 'Routing evaluation evidence is append-only';
END
$guard$;
DROP TRIGGER IF EXISTS agent_routing_evaluations_append_only ON public.agent_routing_evaluations;
CREATE TRIGGER agent_routing_evaluations_append_only
BEFORE UPDATE OR DELETE ON public.agent_routing_evaluations
FOR EACH ROW EXECUTE FUNCTION public.reject_agent_routing_evaluation_mutation();

CREATE OR REPLACE FUNCTION public.atax_worker_suitability_v1(
  task_id_in uuid,
  evaluator_agent_id_in text,
  limit_in integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $function$
DECLARE
  task_out public.tasks%ROWTYPE;
  candidate record;
  evaluation_id uuid;
  candidates jsonb:='[]'::jsonb;
  evaluated integer:=0;
  limit_value integer:=greatest(1,least(coalesce(limit_in,10),30));
BEGIN
  IF task_id_in IS NULL OR nullif(btrim(evaluator_agent_id_in),'') IS NULL THEN
    RAISE EXCEPTION 'Task ID and authenticated evaluator attribution are required';
  END IF;

  SELECT * INTO task_out FROM public.tasks WHERE id=task_id_in;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found'; END IF;

  FOR candidate IN
    WITH required AS (
      SELECT coalesce(task_out.required_capabilities,'{}'::text[]) capabilities,
        CASE WHEN jsonb_typeof(task_out.required_tools)='array'
          THEN task_out.required_tools ELSE '[]'::jsonb END tools,
        CASE WHEN jsonb_typeof(task_out.target->'resources')='object'
          THEN task_out.target->'resources' ELSE '{}'::jsonb END resources
    ),
    worker_signals AS (
      SELECT
        ar.agent_id,
        ar.agent_name,
        ar.agent_type,
        ar.capabilities,
        ar.enabled,
        ar.last_seen_at,
        coalesce(profile.domain_affinities,'{}'::jsonb) domain_affinities,
        coalesce(profile.tool_familiarity,'{}'::text[]) tool_familiarity,
        coalesce(profile.resource_capacity,'{}'::jsonb) resource_capacity,
        coalesce(profile.model_families,'{}'::text[]) model_families,
        coalesce(hist.claim_count,0)::integer claim_count,
        coalesce(hist.verified_count,0)::integer verified_count,
        coalesce(hist.avg_latency_ms,0)::numeric avg_latency_ms,
        coalesce(predicate_stats.predicate_count,0)::integer predicate_count,
        coalesce(predicate_stats.passed_count,0)::integer passed_count,
        coalesce(context_stats.context_samples,0)::integer context_samples,
        coalesce(context_stats.avg_context_fraction,0)::numeric avg_context_fraction,
        coalesce(cap_stats.required_count,0)::integer required_count,
        coalesce(cap_stats.matched_count,0)::integer matched_count,
        coalesce(tool_stats.required_tool_count,0)::integer required_tool_count,
        coalesce(tool_stats.matched_tool_count,0)::integer matched_tool_count,
        coalesce(resource_stats.resource_count,0)::integer resource_count,
        coalesce(resource_stats.resource_fit,0.5)::numeric resource_fit,
        coalesce((
          CASE
            WHEN profile.domain_affinities ? coalesce(nullif(task_out.task_type,''),'default')
             AND coalesce(profile.domain_affinities->>coalesce(nullif(task_out.task_type,''),'default'),'') ~ '^[0-9]*\.?[0-9]+$'
            THEN greatest(0,least(1,(profile.domain_affinities->>coalesce(nullif(task_out.task_type,''),'default'))::numeric))
            WHEN profile.domain_affinities ? 'default'
             AND coalesce(profile.domain_affinities->>'default','') ~ '^[0-9]*\.?[0-9]+$'
            THEN greatest(0,least(1,(profile.domain_affinities->>'default')::numeric))
            ELSE 0.5
          END
        ),0.5)::numeric affinity_score
      FROM public.agent_registry ar
      LEFT JOIN public.agent_intelligence_profiles profile ON profile.agent_id=ar.agent_id
      LEFT JOIN LATERAL (
        SELECT count(*) filter(where t.claimed_by_agent_id=ar.agent_id) claim_count,
          count(*) filter(where t.claimed_by_agent_id=ar.agent_id
             and t.status='completed' and t.verification_status='verified') verified_count,
          avg(extract(epoch from (t.completed_at-t.started_at))*1000)
            filter(where t.claimed_by_agent_id=ar.agent_id
              and t.completed_at is not null and t.started_at is not null
              and t.completed_at>=t.started_at) avg_latency_ms
        FROM public.tasks t
      ) hist ON true
      LEFT JOIN LATERAL (
        SELECT count(*) predicate_count,
          count(*) filter(where pe.passed=true) passed_count
        FROM public.predicate_executions pe
        WHERE pe.executor_id=ar.agent_id
      ) predicate_stats ON true
      LEFT JOIN LATERAL (
        SELECT count(*) context_samples,
          coalesce(avg(task_usage.context_fraction),0) avg_context_fraction
        FROM (
          SELECT u.task_id,
            least(1,sum(u.token_count)::numeric/nullif(b.max_total,0)) context_fraction
          FROM public.socket_usage_events u
          JOIN public.socket_invocations i ON i.id=u.invocation_id
          JOIN public.socket_task_budgets b ON b.task_id=u.task_id
          WHERE i.agent_id=ar.agent_id
          GROUP BY u.task_id,b.max_total
        ) task_usage
      ) context_stats ON true
      LEFT JOIN LATERAL (
        SELECT count(*) required_count,
          count(*) filter(where cap=ANY(coalesce(ar.capabilities,'{}'::text[]))) matched_count
        FROM required r
        CROSS JOIN LATERAL unnest(r.capabilities) cap
      ) cap_stats ON true
      LEFT JOIN LATERAL (
        SELECT count(*) required_tool_count,
          count(*) filter(where tool=ANY(coalesce(profile.tool_familiarity,'{}'::text[]))) matched_tool_count
        FROM required r
        CROSS JOIN LATERAL jsonb_array_elements_text(r.tools) tool
      ) tool_stats ON true
      LEFT JOIN LATERAL (
        SELECT count(*) resource_count,
          avg(CASE
            WHEN coalesce(profile.resource_capacity->>requested.key,'') ~ '^[0-9]*\.?[0-9]+$'
              AND requested.value ~ '^[0-9]*\.?[0-9]+$'
            THEN least(1,(profile.resource_capacity->>requested.key)::numeric/
                         nullif(requested.value::numeric,0))
            ELSE 0
          END) resource_fit
        FROM required r
        CROSS JOIN LATERAL jsonb_each_text(r.resources) requested
        WHERE requested.value ~ '^[0-9]*\.?[0-9]+$'
      ) resource_stats ON true
      WHERE ar.enabled=true
    ),
    scored AS (
      SELECT s.*,
        CASE WHEN required_count=0 THEN 1
          ELSE matched_count::numeric/required_count END capability_score,
        CASE WHEN claim_count=0 THEN 0.5
          ELSE verified_count::numeric/claim_count END reliability_score,
        CASE WHEN predicate_count=0 THEN 0.5
          ELSE passed_count::numeric/predicate_count END verification_score,
        CASE WHEN required_tool_count=0 THEN 1
          ELSE matched_tool_count::numeric/required_tool_count END tool_score,
        CASE WHEN claim_count=0 OR avg_latency_ms<=0 THEN 0.5
          ELSE 1/(1+avg_latency_ms/300000) END latency_score,
        CASE WHEN context_samples=0 THEN 0.5
          ELSE 1-least(1,greatest(0,avg_context_fraction)) END context_score,
        CASE WHEN resource_count=0 THEN 0.5
          ELSE least(1,greatest(0,resource_fit)) END resource_score
      FROM worker_signals s
    )
    SELECT *,
      round((
        capability_score*0.30 +
        reliability_score*0.20 +
        affinity_score*0.15 +
        tool_score*0.10 +
        verification_score*0.10 +
        latency_score*0.05 +
        context_score*0.05 +
        resource_score*0.05
      )::numeric,5) suitability_score
    FROM scored
    ORDER BY suitability_score DESC,agent_id ASC
    LIMIT limit_value
  LOOP
    INSERT INTO public.agent_routing_evaluations(
      task_id,requested_by_agent_id,candidate_agent_id,result_kind,
      suitability_score,capability_complete,component_scores,evidence
    )
    VALUES(
      task_id_in,evaluator_agent_id_in,candidate.agent_id,'candidate',
      candidate.suitability_score,
      candidate.matched_count=candidate.required_count,
      jsonb_build_object(
        'capability',candidate.capability_score,
        'reliability',candidate.reliability_score,
        'domain_affinity',candidate.affinity_score,
        'tool_familiarity',candidate.tool_score,
        'verification',candidate.verification_score,
        'latency',candidate.latency_score,
        'context_efficiency',candidate.context_score,
        'resource_fit',candidate.resource_score
      ),
      jsonb_build_object(
        'claim_count',candidate.claim_count,
        'verified_count',candidate.verified_count,
        'predicate_count',candidate.predicate_count,
        'predicate_passed_count',candidate.passed_count,
        'context_samples',candidate.context_samples,
        'average_latency_ms',candidate.avg_latency_ms,
        'required_capabilities',candidate.required_count,
        'matched_capabilities',candidate.matched_count,
        'required_tools',candidate.required_tool_count,
        'matched_tools',candidate.matched_tool_count,
        'resource_dimensions',candidate.resource_count
      )
    ) RETURNING id INTO evaluation_id;

    candidates:=candidates||jsonb_build_array(jsonb_build_object(
      'evaluation_id',evaluation_id,
      'agent_id',candidate.agent_id,
      'agent_name',candidate.agent_name,
      'agent_type',candidate.agent_type,
      'suitability_score',candidate.suitability_score,
      'capability_complete',candidate.matched_count=candidate.required_count,
      'components',jsonb_build_object(
        'capability',candidate.capability_score,
        'reliability',candidate.reliability_score,
        'domain_affinity',candidate.affinity_score,
        'tool_familiarity',candidate.tool_score,
        'verification',candidate.verification_score,
        'latency',candidate.latency_score,
        'context_efficiency',candidate.context_score,
        'resource_fit',candidate.resource_score
      ),
      'evidence',jsonb_build_object(
        'claim_count',candidate.claim_count,
        'verified_count',candidate.verified_count,
        'predicate_count',candidate.predicate_count,
        'predicate_passed_count',candidate.passed_count,
        'context_samples',candidate.context_samples,
        'average_latency_ms',candidate.avg_latency_ms,
        'required_capabilities',candidate.required_count,
        'matched_capabilities',candidate.matched_count,
        'required_tools',candidate.required_tool_count,
        'matched_tools',candidate.matched_tool_count,
        'resource_dimensions',candidate.resource_count
      )
    ));
    evaluated:=evaluated+1;
  END LOOP;

  IF evaluated=0 THEN
    INSERT INTO public.agent_routing_evaluations(
      task_id,requested_by_agent_id,candidate_agent_id,result_kind,
      component_scores,evidence
    )
    VALUES(task_id_in,evaluator_agent_id_in,NULL,'no_candidates','{}'::jsonb,
      jsonb_build_object('enabled_registry_entries',(
        SELECT count(*) FROM public.agent_registry WHERE enabled=true
      )));
  END IF;

  RETURN jsonb_build_object(
    'task_id',task_id_in,
    'evaluated_at',statement_timestamp(),
    'candidate_count',evaluated,
    'suitability_only',true,
    'authorization_note','Suitability does not authorize execution. Use the canonical atomic claim and fencing path.',
    'candidates',candidates
  );
END
$function$;

REVOKE ALL ON FUNCTION public.atax_worker_suitability_v1(uuid,text,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atax_worker_suitability_v1(uuid,text,integer)
  TO service_role;

COMMENT ON TABLE public.agent_intelligence_profiles IS
'Optional deterministic suitability metadata. It does not grant any claim or tool authority.';
COMMENT ON TABLE public.agent_routing_evaluations IS
'Append-only explainable routing evidence. Suitability recommendations are not authorization decisions.';
COMMENT ON FUNCTION public.atax_worker_suitability_v1(uuid,text,integer) IS
'Deterministic explainable worker suitability ranking using capabilities, history, domain/tool affinity, verification, latency, context efficiency and resource fit. It never authorizes a claim.';

COMMIT;
