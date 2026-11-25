/**
 * Canonical ATAX ledger transport.
 * Uses one confidential PostgreSQL connection URI in every trusted runtime.
 * The existing named RPC contract remains the persistence boundary.
 */
import postgres from 'postgres';

const SAFE_HOST = /(^|\.)supabase\.co$|(^|\.)supabase\.com$/i;
const PARAM_KEY_REGEX = /^[a-z][a-z0-9_]{0,100}$/;
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PARAM_COUNT = 40;
const MAX_PAYLOAD_BYTES = 1048576;

export const CANONICAL_RPC_ALLOWLIST = Object.freeze(new Set([
  'agent_context_overview','atax_context_snapshot','system_improvement_context',
  'goal_ledger_overview','goal_ledger_get_by_key','goal_ledger_resume_by_key','goal_ledger_blocker_overview',
  'goal_ledger_set_priority','goal_ledger_add_dependency','goal_ledger_finalize_by_key',
  'atax_goal_create_system_bounded','vision_ledger_create','vision_ledger_add_target',
  'vision_ledger_attach_tldraw','atax_goal_create_system_omni','task_ledger_claim_next',
  'atax_goal_claim_safe','task_ledger_check_claim','task_ledger_record_handoff',
  'task_ledger_heartbeat_claim','task_ledger_record_loop_iteration','task_ledger_submit_result',
  'task_ledger_release_claim','task_ledger_add_dependency','task_ledger_finalize_loop_script',
  'task_ledger_pending_verification','task_ledger_claim_verification',
  'task_ledger_claim_verification_for_task','task_ledger_verify_result_claimed',
  'atax_socket_execute_v1','atax_mcp_skills_search_v1','atax_mcp_skill_get_v1',
  'atax_mcp_skills_catalog_v1','atax_mcp_runtime_config_v1','atax_mcp_socket_config_v1'
]));
export const ALLOWED_RPCS = CANONICAL_RPC_ALLOWLIST;

export class LedgerError extends Error {
  constructor(message, code='LEDGER_ERROR', status=500, rpcName=null) {
    super(message);
    this.name='LedgerError';
    this.code=code;
    this.status=status;
    this.rpcName=rpcName;
  }
}

export function sanitizeErrorMessage(raw) {
  if(typeof raw!=='string'||!raw.trim()) return 'Canonical operation denied or unavailable';
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi,'[REDACTED_URI]')
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi,'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi,'[REDACTED_URL]')
    .replace(/[\r\n\t]+/g,' ')
    .trim().slice(0,300);
}

export function assertAllowedRpc(name) {
  if(typeof name!=='string'||!CANONICAL_RPC_ALLOWLIST.has(name))
    throw new LedgerError('Invalid canonical RPC','RPC_NOT_ALLOWED',400,name);
}

function validateValue(value, path, seen, depth=0) {
  if(depth>16) throw new LedgerError('Parameter recursion depth exceeded','INVALID_ARGUMENTS',400);
  if(value===undefined) throw new LedgerError('Undefined parameter value not permitted','INVALID_ARGUMENTS',400);
  if(value===null) return;
  const t=typeof value;
  if(t==='string'||t==='boolean') return;
  if(t==='number'){ if(!Number.isFinite(value)) throw new LedgerError('Invalid non-finite number','INVALID_ARGUMENTS',400); return; }
  if(t!=='object') throw new LedgerError('Non-serializable parameter type rejected','INVALID_ARGUMENTS',400);
  if(seen.has(value)) throw new LedgerError('Cyclic reference rejected','INVALID_ARGUMENTS',400);
  seen.add(value);
  if(Array.isArray(value)){ for(let i=0;i<value.length;i++) validateValue(value[i],path+'['+i+']',seen,depth+1); }
  else {
    const proto=Object.getPrototypeOf(value);
    if(proto!==Object.prototype&&proto!==null) throw new LedgerError('Non-plain object rejected','INVALID_ARGUMENTS',400);
    for(const [key,val] of Object.entries(value)){
      if(BANNED_KEYS.has(key)||!PARAM_KEY_REGEX.test(key)) throw new LedgerError('Invalid canonical parameter key','INVALID_ARGUMENTS',400);
      validateValue(val,path+'.'+key,seen,depth+1);
    }
  }
  seen.delete(value);
}

export function validateRpcParams(params) {
  if(params===null||typeof params!=='object'||Array.isArray(params)) throw new LedgerError('RPC parameters must be an object','INVALID_ARGUMENTS',400);
  const entries=Object.entries(params);
  if(entries.length>MAX_PARAM_COUNT) throw new LedgerError('RPC parameter count exceeds limit','INVALID_ARGUMENTS',400);
  const seen=new Set();
  for(const [key,val] of entries){
    if(BANNED_KEYS.has(key)||!PARAM_KEY_REGEX.test(key)) throw new LedgerError('Invalid canonical parameter key','INVALID_ARGUMENTS',400);
    validateValue(val,key,seen);
  }
  const serialized=JSON.stringify(params);
  if(new TextEncoder().encode(serialized).length>MAX_PAYLOAD_BYTES) throw new LedgerError('RPC parameter payload too large','INVALID_ARGUMENTS',400);
  return serialized;
}

export function parseDataApiConfig(env) {
  const raw=env?.ATAX_SUPABASE_CONNECTION_URL;
  if(typeof raw!=='string'||!raw.trim())
    throw new LedgerError('ATAX_SUPABASE_CONNECTION_URL is not configured','CONFIG_ERROR',503);
  if(raw.length>4096) throw new LedgerError('ATAX_SUPABASE_CONNECTION_URL is too long','CONFIG_ERROR',503);
  let url;
  try{ url=new URL(raw.trim()); }catch{ throw new LedgerError('Invalid PostgreSQL connection URI','CONFIG_ERROR',503); }
  if(!['postgres:','postgresql:'].includes(url.protocol))
    throw new LedgerError('ATAX_SUPABASE_CONNECTION_URL must be a PostgreSQL URI','CONFIG_ERROR',503);
  if(!url.username||!url.password||!url.hostname||!url.pathname)
    throw new LedgerError('ATAX_SUPABASE_CONNECTION_URL must include database credentials','CONFIG_ERROR',503);
  if(!SAFE_HOST.test(url.hostname))
    throw new LedgerError('ATAX_SUPABASE_CONNECTION_URL must use a Supabase PostgreSQL hostname','CONFIG_ERROR',503);
  for(const [key,value] of url.searchParams.entries()){
    if(key!=='sslmode'||value!=='require') throw new LedgerError('Only sslmode=require is permitted in the database URI','CONFIG_ERROR',503);
  }
  return {connectionString:raw.trim(),hostLabel:url.hostname};
}

export const parseSupabaseConfig=parseDataApiConfig;

export function createLedgerDb(config) {
  if(!config||typeof config.connectionString!=='string') throw new LedgerError('Invalid ledger configuration','CONFIG_ERROR',503);
  const connectionString=config.connectionString;
  async function withDb(operation){
    const sql=postgres(connectionString,{prepare:false,max:1,connect_timeout:15});
    try{return await operation(sql);}catch(err){
      const safe=sanitizeErrorMessage(err instanceof Error?err.message:'Canonical ledger transport error');
      throw new LedgerError(safe,'NETWORK_ERROR',503);
    }finally{
      try{await sql.end({timeout:1});}catch{}
    }
  }
  async function query(text, values=[]){
    return withDb(async sql=>{
      const rows=await sql.unsafe(text,values);
      return Array.from(rows);
    });
  }
  async function rpc(name,params={}){
    assertAllowedRpc(name);
    const body=validateRpcParams(params);
    return withDb(async sql=>{
      try{
        const rows=await sql`select public.atax_mcp_execute_rpc_v1(${name},${body}::jsonb) as value`;
        return rows[0]?.value ?? null;
      }catch(err){
        const message=sanitizeErrorMessage(err instanceof Error?err.message:'Canonical RPC failed');
        if(/authorization|owner/i.test(message)) throw new LedgerError('Canonical ledger authorization failed','UNAUTHORIZED',403,name);
        if(/not found|argument count mismatch|RPC/i.test(message)) throw new LedgerError('Canonical ledger function not found or parameter mismatch','RPC_NOT_FOUND',404,name);
        throw new LedgerError(message,'RPC_ERROR',502,name);
      }
    });
  }
  async function ping(){
    return withDb(async sql=>{ await sql`select 1 as ok`; return true; });
  }
  async function skills(term){ return rpc('atax_mcp_skills_search_v1',{term_in:String(term??'').slice(0,120)}); }
  async function skill(slug){ return rpc('atax_mcp_skill_get_v1',{slug_in:String(slug??'').slice(0,120)}); }
  async function skillsCatalog(){ return rpc('atax_mcp_skills_catalog_v1',{}); }
  return {rpc,skills,skill,skillsCatalog,ping,query};
}

export async function openLedger(bootstrapEnv){
  const config=parseDataApiConfig(bootstrapEnv);
  return createLedgerDb(config);
}
