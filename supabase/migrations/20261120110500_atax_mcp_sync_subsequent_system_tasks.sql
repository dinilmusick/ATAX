-- Sync newly added goal tasks to their System as well as newly attached goals.
CREATE OR REPLACE FUNCTION public.atax_goal_attach_system(goal_key_in text, system_key_in text, agent_id_in text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare g public.goals%rowtype; s public.systems%rowtype;
begin
  if nullif(btrim(agent_id_in),'') is null then raise exception 'agent identity required'; end if;
  select * into s from public.systems where system_key=system_key_in;
  if s.id is null or s.status not in ('active','ready') then raise exception 'active System not found'; end if;
  select * into g from public.goals where goal_key=goal_key_in for update;
  if g.id is null then raise exception 'goal not found'; end if;
  if g.system_id is not null and g.system_id <> s.id then raise exception 'goal belongs to another System'; end if;
  if exists(select 1 from public.tasks t where t.goal_id=g.id and t.system_id is not null and t.system_id <> s.id) then
    raise exception 'task belongs to another System';
  end if;
  if g.system_id = s.id then
    update public.tasks set system_id=s.id,updated_at=now() where goal_id=g.id and system_id is distinct from s.id;
    return jsonb_build_object('goal_key',g.goal_key,'system_id',s.id,'already_linked',true);
  end if;
  if g.status not in ('planning','ready') or exists(
    select 1 from public.tasks t where t.goal_id=g.id and t.status='running'
  ) then raise exception 'cannot link an active or already running goal to a System'; end if;
  update public.goals set system_id=s.id,
    metadata=metadata||jsonb_build_object('system_id',s.id,'system_key',s.system_key),
    updated_at=now()
  where id=g.id;
  update public.tasks set system_id=s.id,updated_at=now() where goal_id=g.id;
  insert into public.goal_events(goal_id,event_type,agent_id,message,payload)
  values(g.id,'note',agent_id_in,'Linked goal and tasks to canonical ATAX System',
    jsonb_build_object('system_id',s.id,'system_key',s.system_key));
  return jsonb_build_object('goal_key',g.goal_key,'system_id',s.id,'already_linked',false);
end $function$;
revoke all on function public.atax_goal_attach_system(text,text,text) from public,anon,authenticated;
grant execute on function public.atax_goal_attach_system(text,text,text) to service_role;
notify pgrst,'reload schema';
