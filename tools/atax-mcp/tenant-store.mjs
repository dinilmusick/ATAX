/** ATAX hosted MCP tenant boundary: JWT principal, D1 allowlist, encrypted BYO credentials.
 * No credentials are placed in MCP tool schemas/results or persistent logs.
 * This module does not spawn, run or schedule agents.
 */
const encoder=new TextEncoder(), decoder=new TextDecoder();
const VALID_SUBJECT=/^[\w.@:-]{3,120}$/;
const ALIAS=/^[A-Z][A-Z0-9_]{0,47}$/;
const PROVIDERS=new Set(['supabase','github','cloudflare','vercel']);
const SCOPES=new Set(['atax:read','atax:write','atax:verify','atax:github:read','atax:github:create','atax:github:ci','atax:cloudflare:read','atax:vercel:read','atax:vercel:deploy']);
export const INVITABLE_SCOPES=Object.freeze([...SCOPES]);
const PREFIX={github:'GH_TOKEN_',cloudflare:'CLOUDFLARE_TOKEN_',vercel:'VERCEL_TOKEN_'};
const b64=bytes=>btoa(Array.from(bytes,x=>String.fromCharCode(x)).join(''));
const unb64=value=>Uint8Array.from(atob(value),x=>x.charCodeAt(0));
const fail=message=>{throw new Error(message)};
const validName=x=>typeof x==='string' && ALIAS.test(x);
const safeUrl=url=>{
  const u=new URL(String(url||''));
  if(u.protocol!=='https:'||u.port||u.pathname!=='/'||u.search||u.hash||u.username||u.password||
     !/^[a-z0-9-]{8,40}\.supabase\.co$/.test(u.hostname))fail('Supabase URL must be an exact hosted project HTTPS origin');
  return u.origin;
};
export const isHosted=env=>env.MCP_MULTI_TENANT_ENABLED==='true';
export function hostedConfigured(env){
  const oauth=VALID_SUBJECT.test(String(env.MCP_ADMIN_SUBJECT||'')) &&
    !!(env.MCP_AUTH_JWKS_URL && env.MCP_AUTH_ISSUER && env.MCP_AUTH_AUDIENCE);
  const inviteMode=env.MCP_INVITATIONS_ENABLED==='true';
  return !!(env.ATAX_TENANTS && env.MCP_VAULT_KEY_B64 && (oauth || inviteMode));
}
function dbFor(env){if(!hostedConfigured(env))fail('Hosted ATAX configuration incomplete');return env.ATAX_TENANTS;}
function guardSubject(subject){if(!VALID_SUBJECT.test(String(subject||'')))fail('Invalid principal subject');return subject;}
function guardProvider(provider,alias){
  if(!PROVIDERS.has(provider))fail('Unsupported provider');
  if(!validName(alias))fail('Invalid provider alias');
  if(provider==='supabase' && alias!=='DEFAULT')fail('Supabase connection must use DEFAULT alias');
}
async function cipherKey(env){
  let raw;try{raw=unb64(env.MCP_VAULT_KEY_B64);}catch{fail('Invalid tenant encryption key');}
  if(raw.byteLength!==32)fail('Tenant encryption key must contain 32 random bytes');
  return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
async function protect(env,subject,provider,alias,payload){
  const iv=crypto.getRandomValues(new Uint8Array(12)),key=await cipherKey(env);
  const additionalData=encoder.encode(subject+'|'+provider+'|'+alias+'|1');
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},key,encoder.encode(JSON.stringify(payload)));
  return {iv:b64(iv),ciphertext:b64(new Uint8Array(encrypted))};
}
async function reveal(env,row){
  const key=await cipherKey(env);
  try{
    const plaintext=await crypto.subtle.decrypt(
      {name:'AES-GCM',iv:unb64(row.iv),additionalData:encoder.encode(row.subject+'|'+row.provider+'|'+row.alias+'|1')},
      key,unb64(row.ciphertext));
    return JSON.parse(decoder.decode(plaintext));
  }catch{fail('Credential decryption failed');}
}
function scopeList(scopes){
  if(!Array.isArray(scopes)||!scopes.length||scopes.length>12||scopes.some(s=>!SCOPES.has(s)))fail('Invalid invited principal scopes');
  return [...new Set(scopes)];
}
async function audit(env,subject,action,provider=null,alias=null){
  await dbFor(env).prepare('INSERT INTO atax_audit(subject,action,provider,alias) VALUES(?,?,?,?)').bind(subject,action,provider,alias).run();
}
export async function authorizeHostedPrincipal(env,principal){
  if(!isHosted(env))return principal;
  const db=dbFor(env);
  if(!principal || !['jwt','invitation'].includes(principal.authMethod))return null;
  guardSubject(principal.id);
  if(principal.authMethod==='jwt' && principal.id===env.MCP_ADMIN_SUBJECT && principal.scopes.has('atax:admin'))return principal;
  const record=await db.prepare('SELECT scopes,active FROM atax_principals WHERE subject=?').bind(principal.id).first();
  if(!record||Number(record.active)!==1)return null;
  const grants=scopeList(JSON.parse(record.scopes));
  const limited=new Set([...principal.scopes].filter(scope=>grants.includes(scope)));
  if(!limited.size)return null;
  return {...principal,scopes:limited};
}
/** Owner-provisioned invitations use 256+ bits of entropy; only SHA-256 digests reside in D1.
 * No server secret or owner credentials are accepted as an invitation.
 * Access keys are revocable and may have an optional expiry date.
 */
const INVITE_KEY=/^atax_[A-Za-z0-9_-]{56,128}$/;
export async function authenticateHostedInviteKey(env,token){
  if(!isHosted(env) || env.MCP_INVITATIONS_ENABLED!=='true' || !INVITE_KEY.test(String(token||'')))return null;
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(token)));
  const hash=Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('');
  const row=await dbFor(env).prepare(
    'SELECT subject,scopes FROM atax_access_keys WHERE key_hash=? AND active=1 AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)'
  ).bind(hash).first();
  if(!row)return null;
  const principal={id:guardSubject(row.subject),authMethod:'invitation',scopes:new Set(scopeList(JSON.parse(row.scopes)))};
  return authorizeHostedPrincipal(env,principal); // current invitation also limits the key's permissions
}
function admin(p,env){
  if(p?.authMethod!=='jwt'||p.id!==env.MCP_ADMIN_SUBJECT||!p.scopes.has('atax:admin'))fail('Administrator identity and scope required');
}
export async function invite(env,p,{subject,scopes}){
  dbFor(env);admin(p,env);guardSubject(subject);
  if(subject===env.MCP_ADMIN_SUBJECT)fail('Administrator is managed through the identity provider');
  const allowed=scopeList(scopes);
  await env.ATAX_TENANTS.prepare(
    'INSERT INTO atax_principals(subject,active,scopes) VALUES(?,1,?) ON CONFLICT(subject) DO UPDATE SET active=1,scopes=excluded.scopes,updated_at=CURRENT_TIMESTAMP'
  ).bind(subject,JSON.stringify(allowed)).run();
  await audit(env,p.id,'invite',null,null);
  return {subject,active:true,scopes:allowed};
}
export async function revokeInvite(env,p,subject){
  dbFor(env);admin(p,env);guardSubject(subject);
  if(subject===env.MCP_ADMIN_SUBJECT)fail('Cannot revoke configured administrator');
  // Delete dependent credentials even if the principal is re-invited later.
  await env.ATAX_TENANTS.prepare('DELETE FROM atax_connections WHERE subject=?').bind(subject).run();
  await env.ATAX_TENANTS.prepare('DELETE FROM atax_access_keys WHERE subject=?').bind(subject).run();
  await env.ATAX_TENANTS.prepare('UPDATE atax_principals SET active=0,updated_at=CURRENT_TIMESTAMP WHERE subject=?').bind(subject).run();
  await audit(env,p.id,'revoke_invite');
  return {subject,active:false,credentials_deleted:true};
}
export async function listInvites(env,p){
  dbFor(env);admin(p,env);
  const out=await env.ATAX_TENANTS.prepare('SELECT subject,active,scopes,updated_at FROM atax_principals ORDER BY updated_at DESC LIMIT 100').all();
  return {principals:(out.results||[]).map(x=>({subject:x.subject,active:!!x.active,scopes:JSON.parse(x.scopes),updated_at:x.updated_at}))};
}
export async function listConnections(env,p){
  dbFor(env);guardSubject(p.id);
  const out=await env.ATAX_TENANTS.prepare('SELECT provider,alias,metadata,updated_at FROM atax_connections WHERE subject=? ORDER BY provider,alias').bind(p.id).all();
  return {connections:(out.results||[]).map(x=>({provider:x.provider,alias:x.alias,metadata:JSON.parse(x.metadata||'{}'),updated_at:x.updated_at}))};
}
export async function saveConnection(env,p,data,fetcher=fetch){
  dbFor(env);guardSubject(p.id);
  const {provider,alias='DEFAULT'}=data||{};
  guardProvider(provider,alias);
  const token=data?.token;
  if(typeof token!=='string'||token.length<20||token.length>8192||/\s/.test(token))fail('Provider credential invalid');
  let payload={token},meta={};
  if(provider==='supabase'){
    payload.url=safeUrl(data.url);
    meta={project_url:payload.url};
  }else if(provider==='github'){
    const response=await fetcher('https://api.github.com/user',{headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','user-agent':'atax-mcp'},redirect:'error'});
    if(!response.ok)fail('GitHub credential identity check failed (HTTP '+response.status+')');
    const identity=await response.json();
    if(!/^[A-Za-z0-9-]{1,39}$/.test(String(identity.login||'')))fail('GitHub credential returned invalid login');
    meta={github_owner:identity.login};
  }else if(provider==='cloudflare'){
    if(data.account_id!==undefined && !/^[a-f0-9]{32}$/.test(data.account_id))fail('Invalid Cloudflare account ID');
    meta=data.account_id?{account_id:data.account_id}:{};
  }else if(provider==='vercel'){
    if(data.team_id!==undefined && !/^(?:team_[A-Za-z0-9_-]{5,100}|[A-Za-z0-9_-]{3,100})$/.test(data.team_id))fail('Invalid Vercel team ID');
    meta=data.team_id?{team_id:data.team_id}:{};
  }
  const sealed=await protect(env,p.id,provider,alias,payload);
  await env.ATAX_TENANTS.prepare(
    'INSERT INTO atax_connections(subject,provider,alias,ciphertext,iv,metadata) VALUES(?,?,?,?,?,?) ON CONFLICT(subject,provider,alias) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,metadata=excluded.metadata,updated_at=CURRENT_TIMESTAMP'
  ).bind(p.id,provider,alias,sealed.ciphertext,sealed.iv,JSON.stringify(meta)).run();
  await audit(env,p.id,'credential_upsert',provider,alias);
  return {provider,alias,metadata:meta,stored:true}; // never include a token, hash or ciphertext
}
export async function deleteConnection(env,p,provider,alias){
  dbFor(env);guardSubject(p.id);guardProvider(provider,alias);
  await env.ATAX_TENANTS.prepare('DELETE FROM atax_connections WHERE subject=? AND provider=? AND alias=?').bind(p.id,provider,alias).run();
  await audit(env,p.id,'credential_delete',provider,alias);
  return {provider,alias,deleted:true};
}
/** Request-local derived environment: NEVER inherit the owner's tokens or DB fallback. */
export async function scopedTenantEnvironment(env,principal){
  if(!isHosted(env))return env;
  dbFor(env);guardSubject(principal.id);
  const out=await env.ATAX_TENANTS.prepare('SELECT subject,provider,alias,iv,ciphertext,metadata FROM atax_connections WHERE subject=?').bind(principal.id).all();
  const scoped={MCP_MULTI_TENANT_ENABLED:'true',MCP_SHARED_SUBJECT:'__tenant_shared_token_disabled__',MCP_PROVIDER_ACCOUNT_GRANTS:'{}',MCP_FMRL_ALLOWED_TARGETS:''};
  const grants={github:[],cloudflare:[],vercel:[]};
  for(const row of out.results||[]){
    guardProvider(row.provider,row.alias);
    const payload=await reveal(env,row),meta=JSON.parse(row.metadata||'{}');
    if(row.provider==='supabase'){
      scoped.SUPABASE_URL=safeUrl(payload.url);
      scoped.SUPABASE_SECRET_KEY=payload.token;
    }else{
      scoped[PREFIX[row.provider]+row.alias]=payload.token;
      grants[row.provider].push(row.alias);
      if(row.provider==='github')scoped['MCP_GITHUB_OWNER_'+row.alias]=meta.github_owner;
      if(row.provider==='cloudflare' && meta.account_id)scoped['CLOUDFLARE_ACCOUNT_ID_'+row.alias]=meta.account_id;
      if(row.provider==='vercel' && meta.team_id)scoped['VERCEL_TEAM_ID_'+row.alias]=meta.team_id;
    }
  }
  scoped.MCP_PROVIDER_ACCOUNT_GRANTS=JSON.stringify({[principal.id]:grants});
  return scoped;
}
