/** BYOC encrypted token store. Cloudflare D1 holds ciphertext and token hashes only.
 * The random token itself supplies the AES-GCM key for that one envelope.
 * No operator key, cross-tenant fallback or resident agent is required.
 */
const encoder=new TextEncoder(),decoder=new TextDecoder();
const TOKEN=/^atx_(access|refresh|code)_[A-Za-z0-9_-]{43}$/;
const bytes=n=>crypto.getRandomValues(new Uint8Array(n));
export const randomToken=kind=>'atx_'+kind+'_'+b64url(bytes(32));
function b64url(v){return btoa(String.fromCharCode(...v)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function from64(s){const raw=s.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(raw.padEnd(Math.ceil(raw.length/4)*4,'=')),c=>c.charCodeAt(0));}
export async function digest(s){const out=await crypto.subtle.digest('SHA-256',encoder.encode(s));return [...new Uint8Array(out)].map(v=>v.toString(16).padStart(2,'0')).join('');}
async function key(token){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(token)),'AES-GCM',false,['encrypt','decrypt']);}
export async function seal(token,payload,aad){
 const iv=bytes(12);
 const result=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(aad)},await key(token),encoder.encode(JSON.stringify(payload)));
 return {iv:b64url(iv),encrypted:b64url(new Uint8Array(result))};
}
export async function unseal(token,row,aad){
 try{const result=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(row.iv),additionalData:encoder.encode(aad)},await key(token),from64(row.encrypted));
 return JSON.parse(decoder.decode(result));}catch{throw Error('Credential envelope verification failed');}
}
export function db(env){
 if(!env.ATAX_TENANTS||typeof env.ATAX_TENANTS.prepare!=='function')throw Error('BYOC tenant registry unavailable');
 return env.ATAX_TENANTS;
}
export function projectUrl(v){
 const u=new URL(String(v||''));
 if(u.protocol!=='https:'||u.port||u.pathname!=='/'||u.search||u.hash||u.username||u.password||
 !/^[a-z0-9-]{8,40}\.supabase\.co$/.test(u.hostname))throw Error('Invalid Supabase project URL');
 return u.origin;
}
export async function registerCode(env,details,credentials){
 const code=randomToken('code'),sealed=await seal(code,credentials,details.client_id+'|code');
 await db(env).prepare('INSERT INTO byoc_codes(code_hash,client_id,redirect_uri,code_challenge,scopes,github_subject,github_owner,iv,encrypted,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .bind(await digest(code),details.client_id,details.redirect_uri,details.code_challenge,details.scopes,details.github_subject,details.github_owner,sealed.iv,sealed.encrypted,Math.floor(Date.now()/1000)+300).run();
 return code;
}
export async function redeemCode(env,code,clientId,redirectUri,verifier){
 if(!TOKEN.test(code)||!code.startsWith('atx_code_'))throw Error('Invalid authorization code');
 const database=db(env),hash=await digest(code);
 const row=await database.prepare('SELECT * FROM byoc_codes WHERE code_hash=? AND expires_at>?').bind(hash,Math.floor(Date.now()/1000)).first();
 if(!row||row.client_id!==clientId||row.redirect_uri!==redirectUri)throw Error('Authorization code invalid or expired');
 if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))throw Error('PKCE verifier invalid');
 const challenge=b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier))));
 if(challenge!==row.code_challenge)throw Error('PKCE challenge mismatch');
 const removed=await database.prepare('DELETE FROM byoc_codes WHERE code_hash=?').bind(hash).run();
 if(removed.meta?.changes!==1)throw Error('Authorization code already redeemed');
 const credentials=await unseal(code,row,clientId+'|code');
 return {credentials,scopes:row.scopes,subject:row.github_subject,github_owner:row.github_owner};
}
async function insertToken(database,token,kind,clientId,subject,owner,scopes,credentials,family,expiry){
 const sealed=await seal(token,credentials,clientId+'|'+kind);
 await database.prepare('INSERT INTO byoc_tokens(token_hash,token_type,client_id,subject,github_owner,scopes,iv,encrypted,expires_at,family_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .bind(await digest(token),kind,clientId,subject,owner,scopes,sealed.iv,sealed.encrypted,expiry,family).run();
}
export async function issueTokens(env,clientId,info,familyId){
 const database=db(env),now=Math.floor(Date.now()/1000),family=familyId||crypto.randomUUID();
 const access=randomToken('access'),refresh=randomToken('refresh');
 await insertToken(database,access,'access',clientId,info.subject,info.github_owner,info.scopes,info.credentials,family,now+900);
 await insertToken(database,refresh,'refresh',clientId,info.subject,info.github_owner,info.scopes,info.credentials,family,now+2592000);
 return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:900,scope:info.scopes};
}
export async function readToken(env,token,kind='access'){
 if(typeof token!=='string'||!TOKEN.test(token)||!token.startsWith('atx_'+kind+'_'))return null;
 const database=db(env);
 const row=await database.prepare('SELECT * FROM byoc_tokens WHERE token_hash=? AND token_type=? AND revoked_at IS NULL AND expires_at>?')
 .bind(await digest(token),kind,Math.floor(Date.now()/1000)).first();
 if(!row)return null;
 const credentials=await unseal(token,row,row.client_id+'|'+kind);
 if(!credentials||typeof credentials!=='object'||!credentials.github_token||!credentials.supabase_key)return null;
 return {row,credentials};
}
/** Gemini persistent linking keeps the original refresh bearer stable.
 * A short-lived access token is added only while its refresh family is valid.
 * The SELECT/INSERT is atomic: a concurrent family revocation cannot
 * resurrect a newly issued access token after the disconnect completes.
 */
export async function refreshTokens(env,token,clientId){
 const valid=await readToken(env,token,'refresh');
 if(!valid||valid.row.client_id!==clientId)throw Error('Refresh token invalid');
 const database=db(env),now=Math.floor(Date.now()/1000),refreshHash=await digest(token);
 const extended=await database.prepare(
  "UPDATE byoc_tokens SET expires_at=? WHERE token_hash=? AND client_id=? AND token_type='refresh' AND revoked_at IS NULL AND expires_at>?"
 ).bind(now+2592000,refreshHash,clientId,now).run();
 if(extended.meta?.changes!==1)throw Error('Refresh token revoked or expired');
 const access=randomToken('access'),sealed=await seal(access,valid.credentials,clientId+'|access');
 const issued=await database.prepare(
  "INSERT INTO byoc_tokens(token_hash,token_type,client_id,subject,github_owner,scopes,iv,encrypted,expires_at,family_id) "+
  "SELECT ?,'access',client_id,subject,github_owner,scopes,?,?,?,family_id FROM byoc_tokens "+
  "WHERE token_hash=? AND token_type='refresh' AND client_id=? AND revoked_at IS NULL AND expires_at>?"
 ).bind(await digest(access),sealed.iv,sealed.encrypted,now+900,refreshHash,clientId,now).run();
 if(issued.meta?.changes!==1)throw Error('Refresh token no longer authorized');
 return {access_token:access,refresh_token:token,token_type:'Bearer',expires_in:900,scope:valid.row.scopes};
}
export async function revokeToken(env,token){
 const found=await readToken(env,token,token?.startsWith('atx_refresh_')?'refresh':'access');
 if(!found)return;
 await db(env).prepare('UPDATE byoc_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL').bind(Math.floor(Date.now()/1000),found.row.family_id).run();
}
export function sessionEnvironment(env,found){
 const {row,credentials}=found;
 const owner=row.github_owner;
 if(!/^[A-Za-z0-9-]{1,39}$/.test(owner))throw Error('Session GitHub owner invalid');
 const url=projectUrl(credentials.supabase_url);
 const principal={id:row.subject,authMethod:'byoc',scopes:new Set(row.scopes.split(' ').filter(Boolean))};
 const scoped={
  ATAX_BYOC_MODE:'true',ATAX_BYOC_SESSION:row.subject,
  ATAX_BYOC_LEDGER_READY:credentials.ledger_ready===true?'true':'false',ATAX_TENANTS:env.ATAX_TENANTS,
  SUPABASE_URL:url,SUPABASE_SECRET_KEY:credentials.supabase_key,
  MCP_GITHUB_OWNER:owner,GH_TOKEN_DEFAULT:credentials.github_token,
  GITHUB_REPOSITORY_TOKEN:credentials.github_token,
  MCP_FMRL_ALLOWED_TARGETS:''
 };
 const grants={github:['DEFAULT'],cloudflare:[],vercel:[]};
 if(credentials.cloudflare_token){
  scoped.CLOUDFLARE_TOKEN_DEFAULT=credentials.cloudflare_token;
  grants.cloudflare=['DEFAULT'];
  if(credentials.cloudflare_account_id)scoped.CLOUDFLARE_ACCOUNT_ID_DEFAULT=credentials.cloudflare_account_id;
 }
 if(credentials.vercel_token){
  scoped.VERCEL_TOKEN_DEFAULT=credentials.vercel_token;
  grants.vercel=['DEFAULT'];
  if(credentials.vercel_team_id)scoped.VERCEL_TEAM_ID_DEFAULT=credentials.vercel_team_id;
 }
 scoped.MCP_PROVIDER_ACCOUNT_GRANTS=JSON.stringify({[row.subject]:grants});
 return {principal,scoped};
}
