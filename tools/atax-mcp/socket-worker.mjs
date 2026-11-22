import {createSocketGateway} from './socket-gateway.mjs';

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
  const raw=await response.text();
  if(encoder.encode(raw).length>32768)return null;
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

export function createSocketWorker(env,fetcher=fetch){
  const database={
    async executeAtomically(command){
      // This MUST be a single canonical Postgres transaction (Agent B migration).
      // Missing RPC, invalid service role, or malformed receipt all fail closed.
      const base=String(env.SUPABASE_URL||'').replace(/\/$/,'');
      const secret=String(env.SUPABASE_SECRET_KEY||'');
      if(!/^https:\/\/[a-z0-9.-]+$/i.test(base)||!secret)
        throw Error('Canonical database unavailable');
      const headers={'content-type':'application/json','accept':'application/json','apikey':secret};
      if(!secret.startsWith('sb_secret_'))headers.authorization='Bearer '+secret;
      const response=await fetcher(base+'/rest/v1/rpc/atax_socket_execute_v1',{
        method:'POST',redirect:'error',headers,
        body:JSON.stringify({command_in:command})
      });
      if(!response.ok)throw Error('Canonical transaction unavailable');
      const body=await response.text();
      if(encoder.encode(body).length>16384)throw Error('Canonical response exceeds socket boundary');
      const result=JSON.parse(body);
      return Array.isArray(result)?null:result;
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
    // Conservative bootstrapping ceiling: 1 UTF-8 byte per charged token.
    // Agent A's trusted model meter replaces this at integration.
    meter:{count:text=>encoder.encode(text).length}
  });
}

export default {
  fetch(request,env){return createSocketWorker(env).fetch(request);}
};
