/**
 * Direct TLS PostgreSQL adapter for the one ATAX ledger connection URI.
 * No Supabase REST API key, Cloudflare-specific binding, or generic SQL MCP tool.
 * Never expose connection strings or database errors to agent-facing results.
 */
const NAME=/^[a-z][a-z0-9_]{0,100}$/;
const TEXT_ARRAY=new Set(['tags_in','capabilities_in']);
const pools=new Map();

export function parseConnectionUri(env) {
  const raw=env?.ATAX_SUPABASE_CONNECTION_URL;
  if(typeof raw!=='string'||raw.length<48||raw.length>8192)
    throw Error('Canonical PostgreSQL connection unavailable');
  let url;
  try{url=new URL(raw);}catch{throw Error('Invalid PostgreSQL connection URL');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||
     !url.hostname||!url.username||!url.password||url.hash||
     !url.pathname||url.pathname==='/'||
     !(url.hostname.endsWith('.supabase.co')||url.hostname.endsWith('.supabase.com'))||
     !['require','verify-full'].includes(url.searchParams.get('sslmode'))||
     [...url.searchParams.keys()].some(key=>key!=='sslmode'))
    throw Error('ATAX requires a canonical TLS Supabase PostgreSQL URL');
  return raw;
}

function textArray(values) {
  if(!Array.isArray(values)||values.some(x=>typeof x!=='string'))
    throw Error('Invalid PostgreSQL text array');
  return '{'+values.map(value=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"').join(',')+'}';
}
function pgParameter(name,value) {
  if(value===undefined)throw Error('Undefined PostgreSQL argument');
  if(value===null)return null;
  if(TEXT_ARRAY.has(name))return textArray(value);
  if(typeof value==='object')return JSON.stringify(value);
  if(typeof value==='string'||typeof value==='boolean'||typeof value==='number')return value;
  throw Error('Unsupported PostgreSQL argument');
}

export function createLedgerDb(sql) {
  if(!sql||typeof sql.unsafe!=='function')throw Error('Invalid PostgreSQL driver');
  const metaCache=new Map();
  async function metadata(name){
    if(metaCache.has(name))return metaCache.get(name);
    const rows=await sql.unsafe(
      "SELECT p.proretset AS is_set, t.typtype AS kind FROM pg_catalog.pg_proc p "+
      "JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace "+
      "JOIN pg_catalog.pg_type t ON t.oid=p.prorettype "+
      "WHERE n.nspname='public' AND p.proname=$1",
      [name]);
    if(!rows.length)throw Error('Canonical PostgreSQL function missing');
    const shape={isSet:rows[0].is_set===true,kind:rows[0].kind};
    if(rows.some(row=>row.is_set!==shape.isSet||row.kind!==shape.kind))
      throw Error('Ambiguous canonical PostgreSQL result type');
    metaCache.set(name,shape);
    return shape;
  }
  async function rpc(name,params={}){
    if(!NAME.test(name)||params===null||typeof params!=='object'||Array.isArray(params))
      throw Error('Invalid canonical RPC');
    const args=Object.entries(params);
    if(args.length>40||args.some(([arg])=>!NAME.test(arg)))
      throw Error('Invalid canonical RPC arguments');
    const meta=await metadata(name);
    const call='public.'+name+'('+args.map(([key],i)=>key+' => $'+(i+1)).join(',')+')';
    const values=args.map(([key,value])=>pgParameter(key,value));
    let query;
    if(meta.isSet)
      query="SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS value FROM "+call+" AS t";
    else if(meta.kind==='c'||meta.kind==='p')
      query="SELECT to_jsonb(t) AS value FROM "+call+" AS t LIMIT 1";
    else
      query="SELECT "+call+" AS value";
    const rows=await sql.unsafe(query,values);
    return rows[0]?.value??(meta.isSet?[]:null);
  }
  async function skills(term){
    const safe=String(term).replace(/[%_\\]/g,' ').slice(0,120);
    return sql.unsafe(
      "SELECT id,name,slug,description,status,current_version_id "+
      "FROM public.skills WHERE status='active' "+
      "AND (slug ILIKE $1 OR name ILIKE $1) LIMIT 30",
      ['%'+safe+'%']);
  }
  async function skill(slug){
    const rows=await sql.unsafe(
      "SELECT s.id,s.name,s.slug,s.status,s.current_version_id,"+
      "v.version,v.instructions FROM public.skills s "+
      "JOIN public.skill_versions v ON v.id=s.current_version_id "+
      "WHERE s.slug=$1 AND v.is_published=true LIMIT 1",
      [slug]);
    if(!rows.length)throw Error('Canonical skill unavailable');
    return rows[0];
  }
  async function request(path){
    // Only the one legacy MCP skills resource is supported, never arbitrary SQL.
    if(!path.startsWith('skills?select='))throw Error('Unsupported canonical resource');
    return sql.unsafe(
      "SELECT id,slug,name,description,status,current_version_id "+
      "FROM public.skills WHERE status='active' LIMIT 200",[]);
  }
  return {rpc,skills,skill,request};
}

async function defaultClient(uri) {
  let postgres;
  try{postgres=(await import('postgres')).default;}
  catch{throw Error('PostgreSQL transport unavailable');}
  return postgres(uri,{
    ssl:'require',max:2,prepare:false,
    connect_timeout:8,idle_timeout:20
  });
}
export async function openLedger(bootstrapEnv,clientFactory=defaultClient) {
  const uri=parseConnectionUri(bootstrapEnv);
  if(clientFactory!==defaultClient)return createLedgerDb(await clientFactory(uri));
  let promise=pools.get(uri);
  if(!promise){
    promise=defaultClient(uri).then(createLedgerDb);
    pools.set(uri,promise);
    promise.catch(()=>{if(pools.get(uri)===promise)pools.delete(uri);});
  }
  return promise;
}
