#!/usr/bin/env node
/** Live ATAX remote MCP two-tenant OAuth test.
 * Put credentials ONLY in process environment (prefer local shell secret manager).
 * Never print tokens, HTTP response bodies, secrets, or raw canonical ledger state.
 * Always use disposable user-owned test Supabase projects and GitHub accounts.
 */
import {randomBytes,createHash} from 'node:crypto';
const prefix='ATAX_LIVE_',url=process.env[prefix+'WORKER_URL']||'';
function fail(message){throw Error(message);}
function check(cond,message){if(!cond)fail(message);}
function required(key){const value=process.env[prefix+key];if(!value)fail('Missing '+prefix+key);return value;}
function base64url(v){return Buffer.from(v).toString('base64url');}
function verifyUrl(value){
 const u=new URL(value);
 check(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash,'Worker URL must be one exact HTTPS origin');
 return u.origin;
}
const worker=verifyUrl(url);
const fetcher=async (path,init={})=>{
 const response=await fetch(worker+path,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});
 return response;
};
async function json(path,init={},expected=200){
 const response=await fetcher(path,init);
 check(response.status===expected,'Request failed ('+path.split('?')[0]+', HTTP '+response.status+')');
 try{return await response.json()}catch{fail('Invalid JSON for '+path.split('?')[0]);}
}
const form=(body)=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
async function githubIdentity(token){
 const response=await fetch('https://api.github.com/user',{redirect:'error',signal:AbortSignal.timeout(20000),
  headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','user-agent':'atax-live-e2e'}});
 check(response.ok,'GitHub test identity unavailable');
 const identity=await response.json();
 check(Number.isSafeInteger(identity.id)&&typeof identity.login==='string','Invalid GitHub identity');
 return {id:identity.id,login:identity.login};
}
async function establishClient(label){
 const githubToken=required('GITHUB_TOKEN_'+label),supabaseUrl=required('SUPABASE_URL_'+label),
  supabaseKey=required('SUPABASE_KEY_'+label);
 check(supabaseUrl.endsWith('.supabase.co')||supabaseUrl.endsWith('.supabase.co/'),'Use a dedicated hosted Supabase project HTTPS URL');
 const id=await githubIdentity(githubToken);
 const verifier=base64url(randomBytes(48)),challenge=base64url(createHash('sha256').update(verifier).digest());
 const redirectUri='http://127.0.0.1:8765/callback',state=base64url(randomBytes(18));
 const client=await json('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
  redirect_uris:[redirectUri],token_endpoint_auth_method:'none',client_name:'ATAX CLI E2E '+label,
  grant_types:['authorization_code','refresh_token'],response_types:['code']
 })},201);
 check(client.client_id&&client.redirect_uris.includes(redirectUri),'Dynamic client registration invalid');
 const authorization=new URL('/authorize',worker);
 const query={response_type:'code',client_id:client.client_id,redirect_uri:redirectUri,
  code_challenge:challenge,code_challenge_method:'S256',state,scope:'atax:read atax:github:read'};
 for(const [k,v] of Object.entries(query))authorization.searchParams.set(k,v);
 const page=await fetcher(authorization.pathname+authorization.search);
 check(page.status===200,'OAuth consent page unavailable');
 const html=await page.text(),nonce=html.match(/name="nonce" value="([^"]+)"/)?.[1],cookie=page.headers.get('set-cookie')?.split(';')[0];
 check(nonce&&cookie&&html.includes('Registered callback:'),'Consent CSRF or callback disclosure missing');
 const response=await fetcher('/authorize',{...form({
  nonce,github_token:githubToken,supabase_url:supabaseUrl,supabase_key:supabaseKey
 }),headers:{'content-type':'application/x-www-form-urlencoded',cookie}});
 check(response.status===303,'OAuth consent or provider enrollment failed (HTTP '+response.status+')');
 const destination=new URL(response.headers.get('location'));
 check(destination.origin==='http://127.0.0.1:8765'&&destination.searchParams.get('state')===state,
  'OAuth callback redirect or state mismatch');
 const code=destination.searchParams.get('code');
 check(code?.startsWith('atx_code_'),'Authorization code invalid');
 const tokens=await json('/token',form({grant_type:'authorization_code',client_id:client.client_id,
  code,redirect_uri:redirectUri,code_verifier:verifier}),200);
 check(tokens.access_token?.startsWith('atx_access_')&&tokens.refresh_token?.startsWith('atx_refresh_'),
  'OAuth token exchange invalid');
 return {label,id,client,token:tokens.access_token,refresh:tokens.refresh_token};
}
async function mcp(session,method,params={}){
 return json('/mcp',{method:'POST',headers:{authorization:'Bearer '+session.token,
  'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
}
async function inspect(session){
 const init=await mcp(session,'initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'atax-two-tenant-e2e',version:'1'},capabilities:{}});
 check(init.result?.protocolVersion==='2025-11-25','MCP protocol handshake failed');
 const list=await mcp(session,'tools/list');
 const names=new Set(list.result?.tools?.map(x=>x.name)||[]);
 check(names.has('atax_context')&&names.has('atax_github_repository_inspect'),'Core scoped tools missing');
 check(!names.has('atax_fmrl_create_run_dispose'),'Legacy ATAX operator FMRL exposed');
 const ctx=await mcp(session,'tools/call',{name:'atax_context',arguments:{}});
 check(ctx.result&&!ctx.result.isError,'Authenticated canonical Supabase ledger read failed');
 const account=await mcp(session,'tools/call',{name:'atax_provider_accounts_list',arguments:{}});
 check(account.result&&!account.result.isError,'Tenant GitHub account list failed');
 const raw=JSON.stringify(account.result);
 check(raw.includes('github')&&raw.includes('DEFAULT'),'No tenant-owned GitHub DEFAULT credential binding');
 return {toolCount:names.size,contextAvailable:true};
}
async function revoke(session){
 const response=await fetcher('/revoke',form({client_id:session.client.client_id,token:session.refresh}));
 check(response.status===200,'OAuth token family revocation failed');
 const denied=await fetcher('/mcp',{method:'POST',headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:4,method:'ping'})});
 check(denied.status===401,'Revoked access token was incorrectly accepted');
}
async function run(){
 await json('/.well-known/oauth-authorization-server');
 await json('/.well-known/oauth-protected-resource/mcp');
 const sessions=[];
 try{
  const a=await establishClient('A');sessions.push(a);
  const b=await establishClient('B');sessions.push(b);
  check(a.id.id!==b.id.id,'Independent test users require distinct GitHub identities');
  check(required('SUPABASE_URL_A')!==required('SUPABASE_URL_B'),'Tenants must use separate Supabase projects');
  const results=await Promise.all(sessions.map(inspect));
  check(results.every(x=>x.contextAvailable),'Tenant ledger validation incomplete');
  for(const s of sessions)await revoke(s);
  console.log(JSON.stringify({service:'ATAX',verification:'two-independent-real-tenants',
   status:'passed',tenants:2,toolCounts:results.map(x=>x.toolCount),revokedBoth:true}));
 }finally{
  for(const s of sessions){try{await revoke(s)}catch{/* Preserve original failure; report only public status. */}}
 }
}
run().catch(error=>{console.error('ATAX LIVE E2E FAILED: '+String(error.message).slice(0,180));process.exitCode=1;});
