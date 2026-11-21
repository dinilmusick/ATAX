/** ATAX-owned OAuth 2.1/DCR for remote Claude/Gemini MCP clients.
 * GitHub and Supabase identity/credentials are supplied in the first-party
 * authorization form, never in model-visible tool inputs or URL parameters.
 */
import {db,projectUrl,randomToken,digest,registerCode,redeemCode,issueTokens,
  readToken,refreshTokens,revokeToken,sessionEnvironment} from './byoc-store.mjs';
const now=()=>Math.floor(Date.now()/1000);
const headers={'cache-control':'no-store','pragma':'no-cache','x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer','x-frame-options':'DENY'};
const json=(body,status=200,extra={})=>new Response(JSON.stringify(body),{status,headers:{...headers,'content-type':'application/json; charset=utf-8',...extra}});
const error=(name,status=400)=>json({error:name},status);
const isObj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const identifier=/^[a-zA-Z0-9_-]{8,100}$/;
const challenge=/^[A-Za-z0-9_-]{43}$/;
const defaultScopes='atax:read atax:write atax:github:read atax:github:create atax:github:ci atax:github:workflow:write atax:fmrl:execute atax:cloudflare:read atax:vercel:read';
const allowed=new Set(['atax:read','atax:write','atax:verify','atax:github:read','atax:github:create','atax:github:ci','atax:github:workflow:write','atax:fmrl:execute','atax:cloudflare:read','atax:vercel:read']);
const safeRedirect=value=>{
 const u=new URL(value);
 const loopback=(u.hostname==='127.0.0.1'||u.hostname==='[::1]'||u.hostname==='localhost');
 if((u.protocol!=='https:' && !(loopback&&u.protocol==='http:'))||u.username||u.password||u.hash||value.length>2048)
  throw Error('Invalid registered redirect URI');
 return u.toString();
};
function validatedScopes(value){
 const items=String(value||defaultScopes).trim().split(/\s+/).filter(Boolean);
 if(!items.length||items.length>10||items.some(x=>!allowed.has(x)))throw Error('Unsupported OAuth scope');
 // A verifier must use a separate least-privilege client; never issue write+verify.
 if(items.includes('atax:verify')&&items.some(x=>['atax:write','atax:github:create','atax:github:ci','atax:github:workflow:write','atax:fmrl:execute'].includes(x)))throw Error('Verifier and executor scopes must be separate');
 return [...new Set(items)].join(' ');
}
async function boundedBody(req,max=16000,kind='form'){
 if(Number(req.headers.get('content-length')||0)>max)throw Error('Request too large');
 const body=await req.text();if(new TextEncoder().encode(body).length>max)throw Error('Request too large');
 if(kind==='json'){if(!req.headers.get('content-type')?.startsWith('application/json'))throw Error('JSON required');return JSON.parse(body);}
 if(!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw Error('Form body required');
 return new URLSearchParams(body);
}
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function rateLimit(req,env,purpose,limit){
 const raw=req.headers.get('cf-connecting-ip')||'unspecified';
 const minute=Math.floor(now()/60),hash=await digest(purpose+'|'+raw);
 const current=await db(env).prepare(
  'INSERT INTO byoc_rate_limits(bucket_hash,minute_bucket,hits) VALUES(?,?,1) ON CONFLICT(bucket_hash,minute_bucket) DO UPDATE SET hits=hits+1 RETURNING hits'
 ).bind(hash,minute).first();
 if(!current||current.hits>limit)throw Error('Rate limit exceeded');
 // Finite opportunistic maintenance, never spawn/schedule a background agent.
 if(crypto.getRandomValues(new Uint8Array(1))[0]===0)
  await db(env).prepare('DELETE FROM byoc_rate_limits WHERE minute_bucket<?').bind(minute-120).run();
}
const origin=req=>new URL(req.url).origin;
const mcpUrl=req=>origin(req)+'/mcp';
const challengeHeader=req=>({ 'www-authenticate':'Bearer resource_metadata="'+origin(req)+'/.well-known/oauth-protected-resource/mcp"' });
async function clientRow(env,clientId){return db(env).prepare('SELECT client_id,redirects,client_name FROM byoc_clients WHERE client_id=?').bind(clientId).first();}
async function oauthRegistration(req,env){
 await rateLimit(req,env,'register',12);
 const body=await boundedBody(req,10000,'json');
 if(!isObj(body)||!Array.isArray(body.redirect_uris)||body.redirect_uris.length<1||body.redirect_uris.length>10)throw Error('Redirect URIs required');
 if(body.token_endpoint_auth_method!==undefined&&body.token_endpoint_auth_method!=='none')throw Error('Only PKCE public clients are supported');
 if(body.grant_types && (!Array.isArray(body.grant_types)||body.grant_types.some(x=>!['authorization_code','refresh_token'].includes(x))))throw Error('Unsupported grant type');
 const redirects=[...new Set(body.redirect_uris.map(x=>safeRedirect(String(x))))];
 const clientId='atax_'+crypto.randomUUID().replace(/-/g,'');
 const clientName=String(body.client_name||'Unnamed MCP client').slice(0,100);
 await db(env).prepare('INSERT INTO byoc_clients(client_id,redirects,client_name,created_at) VALUES(?,?,?,?)').bind(clientId,JSON.stringify(redirects),clientName,now()).run();
 return json({client_id:clientId,client_name:clientName,
  redirect_uris:redirects,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],
  response_types:['code'],client_id_issued_at:now()},201);
}
async function authorizePage(req,env){
 await rateLimit(req,env,'authorize',24);
 const u=new URL(req.url),clientId=u.searchParams.get('client_id'),redirect=u.searchParams.get('redirect_uri'),
   codeChallenge=u.searchParams.get('code_challenge'),method=u.searchParams.get('code_challenge_method'),
   state=u.searchParams.get('state')||'';
 if(!identifier.test(clientId||'')||!challenge.test(codeChallenge||'')||method!=='S256'||u.searchParams.get('response_type')!=='code'||
   state.length>512)throw Error('Invalid OAuth authorization request');
 const client=await clientRow(env,clientId);
 if(!client||!JSON.parse(client.redirects).includes(safeRedirect(redirect)))throw Error('Unregistered redirect URI');
 const scopes=validatedScopes(u.searchParams.get('scope'));
 const nonce=randomToken('code'),hash=await digest(nonce);
 await db(env).prepare('INSERT INTO byoc_requests(nonce_hash,client_id,redirect_uri,code_challenge,requested_scopes,state,expires_at) VALUES(?,?,?,?,?,?,?)')
  .bind(hash,clientId,redirect,codeChallenge,scopes,state,now()+600).run();
 const body='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATAX authorization</title></head><body>'+
 '<main><h1>Authorize ATAX MCP connection</h1><p><strong>Unverified client:</strong> '+esc(client.client_name||'Unnamed MCP client')+'</p><p><strong>Registered callback:</strong> <code>'+esc(redirect)+'</code></p><p>Only proceed if you recognize this client and its callback address. A self-registered display name is not proof of publisher identity.</p><p>This client requests: <code>'+esc(scopes)+'</code></p>'+
 '<p>Your GitHub and Supabase credentials are used only for your own tenant. The server stores encrypted credential envelopes; you retain the unlocking bearer tokens.</p><p>If your Supabase project is empty, this session will expose ONLY the tenant bootstrap workflow tools until you initialize the database and reconnect.</p>'+
 '<form method="post" action="/authorize" autocomplete="off">'+
 '<input type="hidden" name="nonce" value="'+esc(nonce)+'">'+
 '<label>GitHub fine-grained token <input required type="password" name="github_token" autocomplete="off"></label>'+
 '<label>Supabase project HTTPS URL <input required name="supabase_url" placeholder="https://project-ref.supabase.co"></label>'+
 '<label>Supabase server-side project API key <input required type="password" name="supabase_key" autocomplete="off"></label>'+
 '<label>Cloudflare API token (optional) <input type="password" name="cloudflare_token" autocomplete="off"></label>'+
 '<label>Cloudflare account ID (optional) <input name="cloudflare_account_id" autocomplete="off"></label>'+
 '<label>Vercel API token (optional) <input type="password" name="vercel_token" autocomplete="off"></label>'+
 '<label>Vercel team ID (optional) <input name="vercel_team_id" autocomplete="off"></label>'+
 '<p>Only enter credentials on your trusted ATAX HTTPS domain. Never paste them into a chat.</p>'+
 '<button type="submit">Authorize this MCP client</button></form></main></body></html>';
 return new Response(body,{status:200,headers:{...headers,'content-type':'text/html; charset=utf-8',
  'set-cookie':'__Host-atax_byoc_nonce='+encodeURIComponent(nonce)+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600',
  'content-security-policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'none'"}});
}
function cookie(req,name){
 const val=req.headers.get('cookie')||'';const match=val.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
 return match?decodeURIComponent(match.slice(name.length+1)):'';
}
async function authorizeSubmit(req,env,fetcher){
 await rateLimit(req,env,'approve',12);
 const form=await boundedBody(req,18000);
 const nonce=form.get('nonce'),existing=cookie(req,'__Host-atax_byoc_nonce');
 if(typeof nonce!=='string'||!nonce||nonce!==existing)throw Error('Authorization CSRF check failed');
 const database=db(env),nonceHash=await digest(nonce);
 const pending=await database.prepare('SELECT * FROM byoc_requests WHERE nonce_hash=? AND expires_at>?').bind(nonceHash,now()).first();
 if(!pending)throw Error('Authorization request expired');
 const githubToken=form.get('github_token'),supabaseKey=form.get('supabase_key'),supabaseUrl=projectUrl(form.get('supabase_url'));
 if(typeof githubToken!=='string'||githubToken.length<20||githubToken.length>1000||
    typeof supabaseKey!=='string'||supabaseKey.length<20||supabaseKey.length>2000)throw Error('Invalid provider credential');
 const gh=await fetcher('https://api.github.com/user',{redirect:'error',headers:{authorization:'Bearer '+githubToken,accept:'application/vnd.github+json','user-agent':'atax-mcp'}});
 if(!gh.ok)throw Error('GitHub credential rejected');
 const identity=await gh.json();
 if(!Number.isSafeInteger(identity.id)||identity.id<1||!/^[A-Za-z0-9-]{1,39}$/.test(String(identity.login||'')))throw Error('GitHub identity invalid');
 const sbHeaders={'apikey':supabaseKey,'accept':'application/openapi+json'};
 if(!supabaseKey.startsWith('sb_secret_'))sbHeaders.authorization='Bearer '+supabaseKey;
 const sb=await fetcher(supabaseUrl+'/rest/v1/',{redirect:'error',headers:sbHeaders});
 if(!sb.ok)throw Error('Supabase project credential rejected');
 const ledger=await fetcher(supabaseUrl+'/rest/v1/rpc/agent_context_overview',{method:'POST',redirect:'error',
   headers:{...sbHeaders,'content-type':'application/json'},body:'{}'});
 // A new project may be empty. The session remains bootstrap-only and MUST be reauthorized
 // after the user's private GitHub Actions migration has successfully completed.
 const ledgerReady=ledger.ok;
 const claimed=await database.prepare('DELETE FROM byoc_requests WHERE nonce_hash=?').bind(nonceHash).run();
 if(claimed.meta?.changes!==1)throw Error('Authorization request already used');
 const cloudflareToken=form.get('cloudflare_token')||'';
 const cloudflareAccount=form.get('cloudflare_account_id')||'';
 const vercelToken=form.get('vercel_token')||'';
 const vercelTeam=form.get('vercel_team_id')||'';
 if(cloudflareAccount&&!/^[0-9a-f]{32}$/.test(cloudflareAccount))throw Error('Invalid Cloudflare account ID');
 if(vercelTeam&&!/^[A-Za-z0-9_-]{3,100}$/.test(vercelTeam))throw Error('Invalid Vercel team ID');
 for(const token of [cloudflareToken,vercelToken]){
  if(token&&(token.length<20||token.length>2048||/\s/.test(token)))throw Error('Invalid provider token');
 }
 if(cloudflareToken){
  const cf=await fetcher('https://api.cloudflare.com/client/v4/user/tokens/verify',{
   redirect:'error',headers:{authorization:'Bearer '+cloudflareToken,accept:'application/json'}});
  let verified;try{verified=await cf.json()}catch{}
  if(!cf.ok||verified?.success!==true||verified.result?.status!=='active')throw Error('Cloudflare credential rejected');
 }
 if(vercelToken){
  const v=await fetcher('https://api.vercel.com/v2/user',{
   redirect:'error',headers:{authorization:'Bearer '+vercelToken,accept:'application/json'}});
  let verified;try{verified=await v.json()}catch{}
  if(!v.ok||!verified?.user?.id)throw Error('Vercel credential rejected');
 }
 const credentials={github_token:githubToken,supabase_url:supabaseUrl,supabase_key:supabaseKey,
  ledger_ready:ledgerReady,
  ...(cloudflareToken?{cloudflare_token:cloudflareToken,cloudflare_account_id:cloudflareAccount}:{}),
  ...(vercelToken?{vercel_token:vercelToken,vercel_team_id:vercelTeam}:{})};
 const code=await registerCode(env,{...pending,scopes:pending.requested_scopes,github_subject:'gh-'+identity.id,github_owner:identity.login},credentials);
 const destination=new URL(pending.redirect_uri);destination.searchParams.set('code',code);
 if(pending.state)destination.searchParams.set('state',pending.state);
 return new Response(null,{status:303,headers:{...headers,location:destination.toString(),
  'set-cookie':'__Host-atax_byoc_nonce=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'}});
}
async function tokenRoute(req,env){
 const form=await boundedBody(req,12000),grant=form.get('grant_type'),clientId=form.get('client_id');
 if(!identifier.test(clientId||'')||!await clientRow(env,clientId))throw Error('Unknown OAuth client');
 const resource=form.get('resource');
 if(resource&&resource!==mcpUrl(req))throw Error('Wrong OAuth resource audience');
 if(grant==='authorization_code'){
  const data=await redeemCode(env,form.get('code'),clientId,form.get('redirect_uri'),form.get('code_verifier'));
  return json(await issueTokens(env,clientId,data));
 }
 if(grant==='refresh_token')return json(await refreshTokens(env,form.get('refresh_token'),clientId));
 throw Error('Unsupported grant type');
}
async function routeRequest(req,env,fetcher,handleMcp){
 const u=new URL(req.url),path=u.pathname,base=origin(req);
 try {
  db(env); // fail closed when the isolated user-session database is unavailable
  if(path==='/health'&&req.method==='GET')return json({service:'atax-mcp',status:'ok',mode:'byoc',protocol:'2025-11-25'});
  if((path==='/.well-known/oauth-protected-resource'||path==='/.well-known/oauth-protected-resource/mcp')&&req.method==='GET')
   return json({resource:base+'/mcp',authorization_servers:[base],bearer_methods_supported:['header'],scopes_supported:[...allowed]});
  if(path==='/.well-known/oauth-authorization-server'&&req.method==='GET')
   return json({issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',
    registration_endpoint:base+'/register',revocation_endpoint:base+'/revoke',
    response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
    code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:[...allowed]});
  if(path==='/register'&&req.method==='POST')return await oauthRegistration(req,env);
  if(path==='/authorize'&&req.method==='GET')return await authorizePage(req,env);
  if(path==='/authorize'&&req.method==='POST')return await authorizeSubmit(req,env,fetcher);
  if(path==='/token'&&req.method==='POST')return await tokenRoute(req,env);
  if(path==='/revoke'&&req.method==='POST'){
   const form=await boundedBody(req,12000);
   if(!await clientRow(env,form.get('client_id')))throw Error('Unknown OAuth client');
   await revokeToken(env,form.get('token'));return new Response(null,{status:200,headers});
  }
  if(path==='/mcp'){
    const match=(req.headers.get('authorization')||'').match(/^Bearer (atx_access_[A-Za-z0-9_-]{43})$/);
    const found=match?await readToken(env,match[1]):null;
    if(!found)return json({error:'Unauthorized'},401,challengeHeader(req));
    const {principal,scoped}=sessionEnvironment(env,found);
    return await handleMcp(scoped,principal);
  }
  return error('not_found',404);
 }catch(err){
  const message=String(err?.message||'BYOC request failed');
  const safe=/^(Invalid |Unknown OAuth|Unregistered |Unsupported |Wrong OAuth|Only PKCE|Redirect URIs|PKCE |Authorization |Request too large|Form body required|JSON required|GitHub credential rejected|Supabase project credential rejected|ATAX ledger schema unavailable|Cloudflare credential rejected|Vercel credential rejected|Refresh token invalid|Rate limit exceeded|Verifier and executor scopes must be separate)/.test(message);
  return json({error:safe?'invalid_request':'server_error',error_description:safe?message:'Request could not be completed'},safe?400:503);
 }
}

/** Standard remote browser MCP support without a trusted-origin registry.
 * Credential-less preflight is harmless; actual calls require a valid bearer.
 * Never allow cross-origin onboarding form requests or ambient cookies.
 */
function validCorsOrigin(value){
 if(!value)return null;
 try {
  const u=new URL(value);
  const loopback=u.hostname==='localhost'||u.hostname==='127.0.0.1'||u.hostname==='[::1]';
  if(u.origin!==value||u.username||u.password)return null;
  return (u.protocol==='https:'||(u.protocol==='http:'&&loopback))?value:null;
 }catch{return null;}
}
export async function byocRoute(req,env,fetcher,handleMcp){
 const path=new URL(req.url).pathname;
 const allowedPath=path==='/mcp'||path==='/register'||path==='/token'||
   path==='/.well-known/oauth-authorization-server'||
   path==='/.well-known/oauth-protected-resource'||
   path==='/.well-known/oauth-protected-resource/mcp';
 const supplied=req.headers.get('origin');
 const corsOrigin=validCorsOrigin(supplied);
 if(supplied&&!corsOrigin&&allowedPath)return json({error:'Invalid Origin'},403);
 if(allowedPath&&req.method==='OPTIONS'){
   if(!corsOrigin)return new Response(null,{status:204,headers:{allow:'GET, POST, OPTIONS'}});
   return new Response(null,{status:204,headers:{
    'Access-Control-Allow-Origin':corsOrigin,'Access-Control-Allow-Methods':'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers':'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Max-Age':'600','Vary':'Origin',...headers
   }});
 }
 const response=await routeRequest(req,env,fetcher,handleMcp);
 if(!allowedPath||!corsOrigin)return response;
 const outgoing=new Headers(response.headers);
 outgoing.set('Access-Control-Allow-Origin',corsOrigin);
 outgoing.set('Access-Control-Allow-Methods','POST, GET, OPTIONS');
 outgoing.set('Access-Control-Allow-Headers','Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
 outgoing.set('Vary','Origin');
 return new Response(response.body,{status:response.status,headers:outgoing});
}
