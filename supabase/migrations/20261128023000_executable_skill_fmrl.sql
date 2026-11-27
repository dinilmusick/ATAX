-- Executable skills: a published skill may bind to a public or authorized private repository
-- and describe a bounded command to run in a disposable FMRL workspace.
create or replace function public.atax_mcp_skill_get_v1(slug_in text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
as $function$
  select to_jsonb(s) from (
    select k.id,k.name,k.slug,k.status,k.current_version_id,
           v.version,v.instructions,v.manifest
    from public.skills k
    join public.skill_versions v on v.id=k.current_version_id
    where k.slug=slug_in and k.status='active' and v.is_published=true
    limit 1
  ) s;
$function$;

create or replace function public.atax_mcp_skill_executable_spec_v1(slug_in text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $function$
declare m jsonb; e jsonb; repo text; rev text; cmd text; install_cmd text;
workdir text; output_path text; account text;
begin
  select v.manifest into m from public.skills k
  join public.skill_versions v on v.id=k.current_version_id
  where k.slug=slug_in and k.status='active' and v.is_published=true limit 1;
  if m is null then return jsonb_build_object('status','not_found','code','SKILL_NOT_FOUND'); end if;
  e := m->'executable';
  if e is null or jsonb_typeof(e) <> 'object' then
    return jsonb_build_object('status','not_executable','code','SKILL_NOT_EXECUTABLE');
  end if;
  repo := e->>'repository'; rev := lower(coalesce(e->>'revision','')); cmd := e->>'command';
  install_cmd := coalesce(e->>'install',''); workdir := coalesce(e->>'working_directory','');
  output_path := coalesce(e->>'output_path',''); account := nullif(e->>'account','');
  if repo is null or repo !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
     or rev !~ '^[0-9a-f]{40}$' or cmd is null or length(cmd) not between 1 and 2000
     or cmd ~ E'[\r\n]' or install_cmd ~ E'[\r\n]'
     or (workdir <> '' and (length(workdir)>180 or workdir !~ '^[A-Za-z0-9_./-]+$'))
     or (output_path <> '' and (length(output_path)>300 or output_path !~ '^[A-Za-z0-9_./-]+$'))
     or (account is not null and account !~ '^[A-Z][A-Z0-9_]{0,47}$')
  then return jsonb_build_object('status','invalid','code','SKILL_EXECUTABLE_SPEC_INVALID'); end if;
  return jsonb_build_object('status','ok','repository',repo,'revision',rev,'command',cmd,
    'install',install_cmd,'working_directory',workdir,'output_path',output_path,'account',account,
    'execution','fmrl','cleanup','required_and_independently_verified');
end;
$function$;
