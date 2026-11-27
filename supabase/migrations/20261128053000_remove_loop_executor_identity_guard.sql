-- Remove obsolete loop-author/executor identity separation.
CREATE OR REPLACE FUNCTION public.task_ledger_claim_next(agent_id_in text, agent_name_in text, agent_type_in text DEFAULT 'worker', capabilities_in text[] DEFAULT '{}', lease_seconds_in integer DEFAULT 900)
RETURNS SETOF public.tasks LANGUAGE plpgsql SET search_path='public' AS $function$
DECLARE candidate_id uuid; previous_status text; previous_agent_id text; previous_heartbeat timestamptz; previous_claim_token uuid; previous_heartbeat_context jsonb; task_out public.tasks; lease_value integer:=greatest(30,least(coalesce(lease_seconds_in,120),120)); goal_key_value text;
BEGIN
IF nullif(btrim(agent_id_in),'') IS NULL OR nullif(btrim(agent_name_in),'') IS NULL THEN RAISE EXCEPTION 'agent identity is required'; END IF;
SELECT t.id,t.status,t.claimed_by_agent_id,t.heartbeat_at,t.claim_token,t.heartbeat_context,g.goal_key INTO candidate_id,previous_status,previous_agent_id,previous_heartbeat,previous_claim_token,previous_heartbeat_context,goal_key_value FROM public.tasks t JOIN public.goals g ON g.id=t.goal_id
WHERE t.status IN ('queued','running') AND t.attempt_count<t.max_attempts
AND (t.status='queued' OR (t.status='running' AND t.claim_expires_at IS NOT NULL AND t.claim_expires_at<=now() AND t.claim_token IS NOT NULL AND coalesce(t.heartbeat_at,'-infinity'::timestamptz)<=now()-interval '5 minutes' AND coalesce(t.claim_expires_at,'-infinity'::timestamptz)<=statement_timestamp()))
AND t.required_capabilities<@coalesce(capabilities_in,'{}'::text[]) AND NOT EXISTS(select 1 from public.tasks child where child.parent_task_id=t.id)
AND (t.parent_task_id IS NULL OR NOT EXISTS(select 1 from public.tasks p where p.id=t.parent_task_id AND p.status IN ('failed','cancelled','abandoned','blocked')))
AND g.status IN ('ready','active')
AND NOT EXISTS(select 1 from public.task_dependencies d join public.tasks dep on dep.id=d.depends_on_task_id where d.task_id=t.id AND d.dependency_type='blocking' AND (dep.status<>'completed' OR dep.verification_status<>'verified'))
ORDER BY coalesce(g.user_priority,0.5) DESC,coalesce(t.blocker_notoriety,0) DESC,t.priority ASC,t.started_at ASC FOR UPDATE SKIP LOCKED LIMIT 1;
IF candidate_id IS NULL THEN RETURN; END IF;
IF previous_status='running' AND previous_agent_id IS NOT NULL THEN
INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload) VALUES(candidate_id,'lease_recovered',agent_id_in,'Task reclaimed after heartbeat timeout.',jsonb_build_object('previous_agent_id',previous_agent_id,'previous_claim_token',previous_claim_token,'previous_heartbeat_at',previous_heartbeat,'previous_heartbeat_context',coalesce(previous_heartbeat_context,'{}'::jsonb),'recovery_reason','heartbeat_timeout','recovery_threshold_minutes',5));
END IF;
UPDATE public.tasks SET status='running',claimed_by_agent_id=agent_id_in,claimed_by_agent_name=agent_name_in,claim_token=gen_random_uuid(),claimed_at=now(),claim_expires_at=now()+make_interval(secs=>lease_value),attempt_count=attempt_count+1,heartbeat_at=now(),updated_at=now(),heartbeat_context=jsonb_build_object('activity','claimed','progress','Task claimed; continue the persisted execution loop.','notorious_blockers',public.goal_ledger_blocker_attention(goal_key_value),'next_action','Inspect the highest-notoriety active checkpoint blocker first.'),current_step='Claimed; inspect highest-notoriety blocker first' WHERE id=candidate_id RETURNING * INTO task_out;
INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload) VALUES(task_out.id,'claimed',agent_id_in,'Task claimed by worker',jsonb_build_object('lease_expires_at',task_out.claim_expires_at,'attempt_count',task_out.attempt_count,'task_role',task_out.task_role,'loop_script_status',task_out.loop_script_status,'blocker_notoriety',task_out.blocker_notoriety,'notorious_blockers',public.goal_ledger_blocker_attention(goal_key_value),'heartbeat_policy',public.task_ledger_heartbeat_policy()));
RETURN NEXT task_out;
END; $function$;

CREATE OR REPLACE FUNCTION public.task_ledger_finalize_loop_script(task_id_in uuid, agent_id_in text, claim_token_in uuid, loop_definition_in jsonb, parameter_contract_in jsonb, completion_parameters_in jsonb DEFAULT '[]', checkpoint_contract_in jsonb DEFAULT '{}')
RETURNS public.tasks LANGUAGE plpgsql SET search_path='public' AS $function$
DECLARE task_out public.tasks;
BEGIN
IF jsonb_typeof(loop_definition_in)<>'object' OR loop_definition_in='{}'::jsonb THEN RAISE EXCEPTION 'loop definition must be a non-empty JSON object'; END IF;
IF jsonb_typeof(parameter_contract_in)<>'object' OR parameter_contract_in='{}'::jsonb THEN RAISE EXCEPTION 'parameter contract must be a non-empty JSON object'; END IF;
IF jsonb_typeof(completion_parameters_in)<>'array' OR jsonb_array_length(completion_parameters_in)>4 THEN RAISE EXCEPTION 'completion parameters must be an array of at most 4 items'; END IF;
IF jsonb_typeof(checkpoint_contract_in)<>'object' THEN RAISE EXCEPTION 'checkpoint contract must be a JSON object'; END IF;
UPDATE public.tasks SET task_role='execution',loop_script_status='ready',loop_author_agent_id=agent_id_in,loop_author_claim_token=claim_token_in,loop_script_version=loop_script_version+1,loop_definition=loop_definition_in,parameter_contract=parameter_contract_in,completion_parameters=completion_parameters_in,metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{loop_checkpoint_contract}',checkpoint_contract_in,true),status='queued',claimed_by_agent_id=null,claimed_by_agent_name=null,claim_token=null,claimed_at=null,claim_expires_at=null,heartbeat_at=now(),heartbeat_context=jsonb_build_object('activity','loop_contract_ready','progress','Loop contract authored and persisted.','next_action','Execute the bounded loop.'),current_step='Loop contract ready; awaiting execution',updated_at=now()
WHERE id=task_id_in AND claimed_by_agent_id=agent_id_in AND claim_token=claim_token_in AND status='running' AND claim_expires_at>statement_timestamp() AND task_role='loop_authoring' RETURNING * INTO task_out;
IF task_out.id IS NULL THEN RAISE EXCEPTION 'Loop-authoring claim not found, expired, or not owned by agent'; END IF;
INSERT INTO public.task_events(task_id,event_type,agent_id,message,payload) VALUES(task_id_in,'note',agent_id_in,'Loop contract authored; task returned for execution.',jsonb_build_object('event_kind','loop_contract_ready','loop_script_version',task_out.loop_script_version,'executor_identity_restriction',false));
RETURN task_out;
END; $function$;