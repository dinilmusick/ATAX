import {loadMcpRuntimeConfig} from './ledger-config.mjs';
import {createSocketGateway,readBoundedText} from './socket-gateway.mjs';
import {resolveBudget,estimateTextTokens} from '../socket-budget/index.mjs';

const encoder = new TextEncoder();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unbase64 = value => {
  if(typeof value!=='string'||!/^[a-zA-Z0-9_-]+$/.test(value))throw Error('Invalid token');
  const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
};
const unpack = value => JSON.parse(new TextDecoder().decode(unbase64(value)));
const strictUrl = raw => {
  const url=new URL(raw);
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash)
    throw Error('Invalid identity provider configuration');
  return url.toString();
};
const tokenAudience=(aud,expected)=>aud===expected||Array.isArray(aud)&&aud.includes(expected);

export async function verifySocketJwt(request,env,fetcher=fetch){
  if(!env.SOCKET_AUTH_JWKS_URL||!env.SOCKET_AUTH_ISSUER||!env.SOCKET_AUTH_AUDIENCE||
    !env.SOCKET_AUTH_CLIENT_ID)throw Error('Identity provider not configured');
  const header=request.headers.get('authorization')||'';
  if(!/^Bearer [a-zA-Z0-9._-]{24,8192}$/.test(header))return null;
  const parts=header.slice(7).split('.');
  if(parts.length!==3)return null;
  let head,payload;
  try{head=unpack(parts[0]);payload=unpack(parts[1]);}catch{return null;}
  const now=Math.floor(Date.now()/1000);
  if(!head||head.typ!=='at+jwt'||head.alg!=='RS256'||
    typeof head.kid!=='string'||!head.kid||!payload||
    payload.iss!==env.SOCKET_AUTH_ISSUER||
    !tokenAudience(payload.aud,env.SOCKET_AUTH_AUDIENCE)||
    payload.azp!==env.SOCKET_AUTH_CLIENT_ID||
    typeof payload.sub!=='string'||!/^[a-zA-Z0-9_.@:-]{3,120}$/.test(payload.sub)||
    typeof payload.atax_session_id!=='string'||!/^[a-zA-Z0-9_.:-]{3,160}$/.test(payload.atax_session_id)||
    typeof payload.atax_task_id!=='string'||!UUID.test(payload.atax_task_id)||
    typeof payload.atax_claim_token!=='string'||!UUID.test(payload.atax_claim_token)||
    !Number.isInteger(payload.iat)||!Number.isInteger(payload.exp)||
    payload.exp<=now||payload.iat>now+30||payload.exp-payload.iat>1800||
    (payload.nbf!==undefined&&(!Number.isInteger(payload.nbf)||payload.nbf>now)))return null;
  const jwksUrl=strictUrl(env.SOCKET_AUTH_JWKS_URL);
  if(new URL(jwksUrl).origin!==new URL(strictUrl(env.SOCKET_AUTH_ISSUER)).origin)
    throw Error('JWKS issuer origin mismatch');
  const response=await fetcher(jwksUrl,{redirect:'error',headers:{accept:'application/json'}});
  if(!response.ok)return null;
  const raw=await readBoundedText(response,32768);
  if(raw===null)return null;
  let keys;
  try{keys=JSON.parse(raw).keys;}catch{return null;}
  const jwk=Array.isArray(keys)?keys.find(k=>k.kid===head.kid&&k.kty==='RSA'&&
    (!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig')):null;
  if(!jwk)return null;
  try{
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,unbase64(parts[2]),
      encoder.encode(parts[0]+'.'+parts[1]));
    return valid?{id:payload.sub,sessionId:payload.atax_session_id,taskId:payload.atax_task_id,
      claimToken:payload.atax_claim_token}:null;
  }catch{return null;}
}

function createConfiguredSocketWorker(env,fetcher=fetch){
  // Model-specific conservative budget is mandatory. Unknown models use Agent A's
  // 8192-token fallback, never an unbounded or self-declared capacity.
  const budgetProfile=resolveBudget(String(env.SOCKET_MODEL_ID||'unknown'));
  const database={
    async executeAtomically(command){
      if(!env.__ledgerDb)throw Error('Canonical PostgreSQL socket transaction unavailable');
      // One server-controlled PostgreSQL RPC, never a client-directed SQL tool.
      const result=await env.__ledgerDb.rpc('atax_socket_execute_v1',{command_in:command});
      if(!result||typeof result!=='object'||Array.isArray(result))
        throw Error('Canonical socket transaction unavailable');
      return result;
    }
  };
  let catalog={};
  try{
    catalog=JSON.parse(String(env.SOCKET_WORKFLOW_CATALOG_JSON||'{}'));
    if(!catalog||typeof catalog!=='object'||Array.isArray(catalog))catalog={};
  }catch{catalog={};}
  const githubDispatch={
    resolveWorkflow(key){
      const inputs=Object.hasOwn(catalog,key)?catalog[key]:null;
      const types=new Set(['sha','uuid','slug','integer','boolean']);
      return inputs&&typeof inputs==='object'&&!Array.isArray(inputs)&&
        Object.entries(inputs).every(([name,type])=>
          /^[a-z][a-z0-9_]{0,63}$/.test(name)&&types.has(type))
        ?{key,inputs}:null;
    }
  };
  return createSocketGateway({
    verifyPrincipal:request=>verifySocketJwt(request,env,fetcher),
    database, githubDispatch,
    budgetProfile,
    requireCanonicalReply:true,
    // Pinned Agent A byte-upper-bound tokenizer, including per-message overhead.
    // SQL independently verifies the raw wire byte count and enforces stored
    // quotas no larger than these signed-worker, versioned model limits.
    meter:{count:text=>estimateTextTokens(text)+budgetProfile.overhead}
  });
}

export function createSocketWorker(bootstrapEnv,fetcher=fetch,configLoader=loadMcpRuntimeConfig){
  return {async fetch(request){
    let policy;
    try{policy=await configLoader(bootstrapEnv);}
    catch{return Response.json({error:'ATAX task socket not configured'},{
      status:503,headers:{'cache-control':'no-store'}
    });}
    return createConfiguredSocketWorker(policy,fetcher).fetch(request);
  }};
}
export default {
  fetch(request,env){return createSocketWorker(env).fetch(request);}
};
