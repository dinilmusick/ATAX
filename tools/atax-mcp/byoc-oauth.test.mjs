import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHandler} from './worker.mjs';
import {seal,unseal,projectUrl} from './byoc-store.mjs';

class FakeD1 {
 constructor(){this.clients=new Map();this.requests=new Map();this.codes=new Map();this.tokens=new Map();this.rate=new Map();}
 prepare(sql){
  const db=this;
  return {bind(...args){
   const first=async()=>{
    if(sql.startsWith('INSERT INTO byoc_rate_limits')){
      const k=args[0]+'|'+args[1],hits=(db.rate.get(k)||0)+1;db.rate.set(k,hits);return {hits};
    }
    if(sql.startsWith('SELECT client_id')){const r=db.clients.get(args[0]);return r||null;}
    if(sql.startsWith('SELECT * FROM byoc_requests')){const r=db.requests.get(args[0]);return r?.expires_at>args[1]?r:null;}
    if(sql.startsWith('SELECT * FROM byoc_codes')){const r=db.codes.get(args[0]);return r?.expires_at>args[1]?r:null;}
    if(sql.startsWith('SELECT * FROM byoc_tokens')){const r=db.tokens.get(args[0]);return r&&r.token_type===args[1]&&r.revoked_at==null&&r.expires_at>args[2]?r:null;}
    throw Error('Unmatched D1 select: '+sql);
   };
   const run=async()=>{
    if(sql.startsWith('DELETE FROM byoc_rate_limits'))return {meta:{changes:0}};
    if(sql.startsWith('INSERT INTO byoc_clients')){const [client_id,redirects,client_name,created_at]=args;db.clients.set(client_id,{client_id,redirects,client_name,created_at});return {meta:{changes:1}};}
    if(sql.startsWith('INSERT INTO byoc_requests')){const [nonce_hash,client_id,redirect_uri,code_challenge,requested_scopes,state,expires_at]=args;db.requests.set(nonce_hash,{nonce_hash,client_id,redirect_uri,code_challenge,requested_scopes,state,expires_at});return {meta:{changes:1}};}
    if(sql.startsWith('INSERT INTO byoc_codes')){const [code_hash,client_id,redirect_uri,code_challenge,scopes,github_subject,github_owner,iv,encrypted,expires_at]=args;db.codes.set(code_hash,{code_hash,client_id,redirect_uri,code_challenge,scopes,github_subject,github_owner,iv,encrypted,expires_at});return {meta:{changes:1}};}
    if(sql.startsWith("UPDATE byoc_tokens SET expires_at")){
     const [expires_at,token_hash,client_id,now]=args;
     const row=db.tokens.get(token_hash);
     if(!row||row.client_id!==client_id||row.token_type!=='refresh'||row.revoked_at!=null||row.expires_at<=now)return {meta:{changes:0}};
     row.expires_at=expires_at;return {meta:{changes:1}};
    }
    if(sql.includes("SELECT ?,'access'")){
     const [token_hash,iv,encrypted,expires_at,refresh_hash,client_id,now]=args;
     const source=db.tokens.get(refresh_hash);
     if(!source||source.client_id!==client_id||source.token_type!=='refresh'||source.revoked_at!=null||source.expires_at<=now)return {meta:{changes:0}};
     db.tokens.set(token_hash,{...source,token_hash,token_type:'access',iv,encrypted,expires_at,revoked_at:null});
     return {meta:{changes:1}};
    }
    if(sql.startsWith('INSERT INTO byoc_tokens')){const [token_hash,token_type,client_id,subject,github_owner,scopes,iv,encrypted,expires_at,family_id]=args;db.tokens.set(token_hash,{token_hash,token_type,client_id,subject,github_owner,scopes,iv,encrypted,expires_at,family_id,revoked_at:null});return {meta:{changes:1}};}
    if(sql.startsWith('DELETE FROM byoc_requests'))return {meta:{changes:db.requests.delete(args[0])?1:0}};
    if(sql.startsWith('DELETE FROM byoc_codes'))return {meta:{changes:db.codes.delete(args[0])?1:0}};
    if(sql.startsWith('UPDATE byoc_tokens SET revoked_at')){
     if(sql.includes('token_hash=?')){const r=db.tokens.get(args[1]);if(r&&r.revoked_at==null){r.revoked_at=args[0];return {meta:{changes:1}}}return {meta:{changes:0}};}
     if(sql.includes('family_id=?')){let count=0;for(const r of db.tokens.values()){if(r.family_id===args[1]&&r.revoked_at==null){r.revoked_at=args[0];count++;}}return {meta:{changes:count}};}
    }
    throw Error('Unmatched D1 mutation: '+sql);
   };
   return {first,run};
  }};
 }
}
const domain='https://atax.example';
const db=new FakeD1(),env={ATAX_BYOC_MODE:'true',ATAX_TENANTS:db};
const fetcher=async(url,opts={})=>{
 const target=String(url);
 if(target==='https://api.github.com/user'){
  const token=opts.headers?.authorization||'';
  if(token.includes('github-token-for-user-a'))return Response.json({id:101,login:'user-a'});
  if(token.includes('github-token-for-user-b'))return Response.json({id:202,login:'user-b'});
  return Response.json({message:'bad token'},{status:401});
 }
 if(target==='https://api.cloudflare.com/client/v4/user/tokens/verify')
  return opts.headers?.authorization.includes('invalid')?
    Response.json({success:false},{status:401}):Response.json({success:true,result:{status:'active'}});
 if(target==='https://api.vercel.com/v2/user')
  return Response.json({user:{id:'user_123456789'}});
 if(target==='https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50')
  return Response.json({success:true,result:[{id:'a'.repeat(32),name:'My Account'}]});
 if(target.startsWith('https://api.vercel.com/v9/projects?'))
  return Response.json({projects:[{id:'prj_123',name:'site',framework:'nextjs'}]});
 if(target.endsWith('.supabase.co/rest/v1/'))return Response.json({openapi:'3.0.0'});
 if(target.includes('project-empty1.supabase.co/rest/v1/rpc/'))return Response.json({message:'RPC missing'},{status:404});
 if(target.includes('.supabase.co/rest/v1/rpc/'))return Response.json({project:target.split('.')[0],method:target.split('/').at(-1)});
 if(target.includes('.supabase.co/rest/v1/skills?'))return Response.json([]);
 throw Error('Unanticipated upstream '+target);
};
const app=createHandler(fetcher),j=async r=>r.json();
const verifier='a'.repeat(64);
const proof=createHash('sha256').update(verifier).digest('base64url');
const secretA='github-token-for-user-a-1234567890',secretB='github-token-for-user-b-1234567890';
const keyA='sb_secret_project-a-value-01234567890',keyB='sb_secret_project-b-value-01234567890';
async function form(path,fields,headers={}){
 return app(new Request(domain+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(fields)}),env);
}
async function register(){
 const r=await app(new Request(domain+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
 redirect_uris:['https://client.example/callback'],client_name:'Claude or Gemini',token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token']
 })}),env);
 assert.equal(r.status,201);return (await j(r)).client_id;
}
async function enroll(clientId,gitToken,supabaseUrl,key,scope,extra={}){
 const u=new URL(domain+'/authorize');
 Object.entries({response_type:'code',client_id:clientId,redirect_uri:'https://client.example/callback',
  code_challenge:proof,code_challenge_method:'S256',state:'csrf-client-state-123',scope}).forEach(([k,v])=>{if(v)u.searchParams.set(k,v)});
 const r=await app(new Request(u),env);
 assert.equal(r.status,200);
 const html=await r.text(),nonce=html.match(/name="nonce" value="([^"]+)"/)?.[1];
 assert.ok(html.includes('Registered callback:'));
 assert.ok(html.includes('client.example/callback'));
 assert.ok(html.includes('Unverified client:'));
 assert.ok(nonce);
 const posted=await form('/authorize',{nonce,github_token:gitToken,supabase_url:supabaseUrl,supabase_key:key,...extra},
  {cookie:'__Host-atax_byoc_nonce='+encodeURIComponent(nonce)});
 assert.equal(posted.status,303);const location=new URL(posted.headers.get('location'));
 assert.equal(location.host,'client.example');
 assert.equal(location.searchParams.get('state'),'csrf-client-state-123');
 return location.searchParams.get('code');
}
async function getTokens(clientId,code,override={}){
 const res=await form('/token',{grant_type:'authorization_code',client_id:clientId,
  redirect_uri:'https://client.example/callback',code,code_verifier:verifier,...override});
 return {status:res.status,data:await j(res)};
}
async function tool(token,method='tools/list',params={}){
 const r=await app(new Request(domain+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env);
 return {status:r.status,data:await j(r)};
}
test('cryptographic isolation and fixed Supabase origin restrictions',async()=>{
 const a=await seal('random-access-key',{token:'secret'} ,'client|access');
 assert.deepEqual(await unseal('random-access-key',a,'client|access'),{token:'secret'});
 await assert.rejects(unseal('wrong-key',a,'client|access'));
 await assert.rejects(unseal('random-access-key',a,'other-client|access'));
 assert.equal(projectUrl('https://abc-def123.supabase.co/'),'https://abc-def123.supabase.co');
 assert.throws(()=>projectUrl('https://169.254.169.254/'));
 assert.throws(()=>projectUrl('https://abc-def123.supabase.co.evil.test'));
});
test('OAuth discovery and 401 are public without operator secrets',async()=>{
 for(const url of ['/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource/mcp']){
  const r=await app(new Request(domain+url),env);assert.equal(r.status,200);
  const meta=await j(r);assert.ok(meta.registration_endpoint||meta.authorization_servers);
 }
 const denied=await tool('invalid');
 assert.equal(denied.status,401);
 const broken=await app(new Request(domain+'/mcp',{method:'POST',body:'{}'}),{ATAX_BYOC_MODE:'true'});
 assert.equal(broken.status,503);
});
test('full registration, PKCE consent, token, own-tenant RPC and persistent Gemini refresh linking',async()=>{
 const id=await register();
 const code=await enroll(id,secretA,'https://project-aaa1.supabase.co/',keyA);
 const wrong=await getTokens(id,code,{code_verifier:'b'.repeat(64)});
 assert.equal(wrong.status,400);
 const minted=await getTokens(id,code);
 assert.equal(minted.status,200);
 const {access_token,refresh_token}=minted.data;
 assert.ok(access_token.startsWith('atx_access_'));
 const invalidReplay=await getTokens(id,code);assert.equal(invalidReplay.status,400);
 const listed=await tool(access_token);assert.equal(listed.status,200);
 const names=listed.data.result.tools.map(t=>t.name);
 for(const required of ['atax_context','atax_task_claim_next','atax_github_actions_dispatch','atax_github_actions_workflow_create','atax_github_repository_create'])assert.ok(names.includes(required));
 assert.ok(!names.includes('atax_fmrl_create_run_dispose'));
 assert.ok(!names.includes('atax_verification_claim'));
 const called=await tool(access_token,'tools/call',{name:'atax_context',arguments:{}});
 assert.equal(called.status,200);
 assert.match(JSON.stringify(called.data),/project-aaa1/);
 assert.ok(!JSON.stringify(called.data).includes(keyA));
 const refreshed=await form('/token',{grant_type:'refresh_token',client_id:id,refresh_token});
 assert.equal(refreshed.status,200);
 const newer=await j(refreshed);
 assert.equal(newer.refresh_token,refresh_token,'Gemini persistent linking requires the same refresh token');
 assert.notEqual(newer.access_token,access_token);
 assert.equal((await tool(access_token)).status,200);
 assert.equal((await tool(newer.access_token)).status,200);
 const repeated=await form('/token',{grant_type:'refresh_token',client_id:id,refresh_token});
 assert.equal(repeated.status,200);
 const repeatedData=await j(repeated);
 assert.equal(repeatedData.refresh_token,refresh_token);
 assert.notEqual(repeatedData.access_token,newer.access_token);
 const revoked=await form('/revoke',{client_id:id,token:refresh_token});
 assert.equal(revoked.status,200);
 for(const t of [access_token,newer.access_token,repeatedData.access_token]){
  assert.equal((await tool(t)).status,401,'Revocation must invalidate every access token in the family');
 }
 const denied=await form('/token',{grant_type:'refresh_token',client_id:id,refresh_token});
 assert.equal(denied.status,400);
});
test('independent client must enroll its own GitHub and Supabase project',async()=>{
 const id=await register();
 const code=await enroll(id,secretB,'https://project-bbb2.supabase.co/',keyB,'atax:read atax:verify');
 const issued=await getTokens(id,code);
 const output=await tool(issued.data.access_token,'tools/call',{name:'atax_context',arguments:{}});
 assert.equal(output.status,200);
 assert.match(JSON.stringify(output.data),/project-bbb2/);
 assert.ok(!JSON.stringify(output.data).includes('project-aaa1'));
 const names=(await tool(issued.data.access_token)).data.result.tools.map(x=>x.name);
 assert.ok(names.includes('atax_verification_claim'));
 assert.ok(!names.includes('atax_task_claim_next'));
 assert.ok(!names.includes('atax_github_repository_create'));
});

test('registration rejects open redirects and mixed execute/verification roles',async()=>{
 const invalid=await app(new Request(domain+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
 redirect_uris:['http://example.org/callback'],token_endpoint_auth_method:'none'
 })}),env);
 assert.equal(invalid.status,400);
 const id=await register(),u=new URL(domain+'/authorize');
 for(const [k,v] of Object.entries({response_type:'code',client_id:id,redirect_uri:'https://client.example/callback',
 code_challenge:proof,code_challenge_method:'S256',scope:'atax:write atax:verify'}))u.searchParams.set(k,v);
 const r=await app(new Request(u),env);assert.equal(r.status,400);
});

test('browser MCP CORS preflight is bearer-independent, while actual cross-origin calls require bearer',async()=>{
 const options=await app(new Request(domain+'/mcp',{method:'OPTIONS',headers:{
  origin:'https://claude.ai','access-control-request-method':'POST',
  'access-control-request-headers':'authorization,content-type'
 }}),env);
 assert.equal(options.status,204);
 assert.equal(options.headers.get('Access-Control-Allow-Origin'),'https://claude.ai');
 assert.ok(options.headers.get('Access-Control-Allow-Headers').includes('Authorization'));
 const absent=await app(new Request(domain+'/mcp',{method:'POST',headers:{
  origin:'https://gemini.google.com','content-type':'application/json'
 },body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})}),env);
 assert.equal(absent.status,401);
 assert.equal(absent.headers.get('Access-Control-Allow-Origin'),'https://gemini.google.com');
 const invalid=await app(new Request(domain+'/mcp',{method:'OPTIONS',headers:{origin:'null'}}),env);
 assert.equal(invalid.status,403);
 const own=await app(new Request(domain+'/authorize',{method:'OPTIONS',headers:{origin:'https://evil.example'}}),env);
 assert.notEqual(own.headers.get('Access-Control-Allow-Origin'),'https://evil.example');
});


test('an empty Supabase project authorizes only bootstrap and run inspection, not ledger writes',async()=>{
 const id=await register();
 const code=await enroll(id,secretA,'https://project-empty1.supabase.co/',keyA);
 const mint=await getTokens(id,code);
 assert.equal(mint.status,200);
 const access=mint.data.access_token,listed=await tool(access);
 assert.equal(listed.status,200);
 const names=listed.data.result.tools.map(x=>x.name);
 assert.ok(names.includes('atax_supabase_bootstrap_workflow_create'));
 assert.ok(names.includes('atax_github_actions_run_status'));
 for(const denied of ['atax_context','atax_task_claim_next','atax_github_repository_create','atax_fmrl_public_start']){
  assert.ok(!names.includes(denied),'Unexpected bootstrap privilege: '+denied);
 }
 const attempts=await tool(access,'tools/call',{name:'atax_task_claim_next',arguments:{}});
 assert.equal(attempts.data.result.isError,true);
 assert.match(JSON.stringify(attempts.data),/not authorized/i);
});
test('OAuth identities are stable across different clients for the same verified GitHub account',async()=>{
 const first=await register(),second=await register();
 const codeA=await enroll(first,secretA,'https://project-aaa1.supabase.co/',keyA,'atax:read atax:verify');
 const codeB=await enroll(second,secretA,'https://project-aaa1.supabase.co/',keyA,'atax:read atax:verify');
 const a=await getTokens(first,codeA),b=await getTokens(second,codeB);
 assert.equal(a.status,200);assert.equal(b.status,200);
 const rowA=db.tokens.get(await (async()=>{
  const enc=new TextEncoder().encode(a.data.access_token);
  const hash=await crypto.subtle.digest('SHA-256',enc);
  return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
 })());
 const rowB=[...db.tokens.values()].find(x=>x.client_id===second&&x.token_type==='access');
 assert.equal(rowA.subject,'gh-101');
 assert.equal(rowA.subject,rowB.subject,'Different OAuth client IDs must not invent a second independent verifier');
});


test('per-user optional Cloudflare and Vercel credentials are scoped and never disclosed to tools',async()=>{
 const id=await register();
 const cf=['cloudflare','safe','test','token','value','1234567'].join('_');
 const ve=['vercel','safe','test','token','value','1234567'].join('_');
 const code=await enroll(id,secretB,'https://project-bbb2.supabase.co/',keyB,undefined,{
  cloudflare_token:cf,cloudflare_account_id:'a'.repeat(32),vercel_token:ve,vercel_team_id:'team_work'
 });
 const issued=await getTokens(id,code);assert.equal(issued.status,200);
 const access=issued.data.access_token;
 const names=(await tool(access)).data.result.tools.map(x=>x.name);
 for(const required of ['atax_cloudflare_accounts_list','atax_vercel_projects_list','atax_cloudflare_build_logs','atax_vercel_build_events']){
  assert.ok(names.includes(required),'Provider tool missing '+required);
 }
 const response=await tool(access,'tools/call',{name:'atax_provider_accounts_list',arguments:{}});
 assert.equal(response.status,200);
 const result=response.data.result.structuredContent?.result??JSON.parse(response.data.result.content[0].text);
 assert.deepEqual(result.accounts.find(x=>x.provider==='cloudflare').aliases,['DEFAULT']);
 assert.deepEqual(result.accounts.find(x=>x.provider==='vercel').aliases,['DEFAULT']);
 assert.ok(!JSON.stringify(response.data).includes(cf));
 assert.ok(!JSON.stringify(response.data).includes(ve));
 const cloudflare=await tool(access,'tools/call',{name:'atax_cloudflare_accounts_list',arguments:{}});
 assert.match(JSON.stringify(cloudflare.data),/My Account/);
 const vercel=await tool(access,'tools/call',{name:'atax_vercel_projects_list',arguments:{}});
 assert.match(JSON.stringify(vercel.data),/prj_123/);
});


test('Gemini unlink revokes a token family without requiring client_id',async()=>{
 const id=await register(),otherClient=await register();
 const auth=await enroll(id,secretA,'https://project-aaa1.supabase.co/',keyA);
 const tokens=(await getTokens(id,auth)).data;
 const mismatched=await form('/revoke',{client_id:otherClient,token:tokens.access_token});
 assert.equal(mismatched.status,400,'An unrelated OAuth client cannot revoke another client session');
 assert.equal((await tool(tokens.access_token)).status,200);
 const revoked=await form('/revoke',{token:tokens.access_token});
 assert.equal(revoked.status,200,'Gemini may omit client ID during unlink');
 assert.equal((await tool(tokens.access_token)).status,401);
 const refresh=await form('/token',{grant_type:'refresh_token',client_id:id,refresh_token:tokens.refresh_token});
 assert.equal(refresh.status,400);
 const duplicate=await form('/revoke',{token:tokens.access_token});
 assert.equal(duplicate.status,200,'RFC7009 revocation of an already revoked token is idempotent');
 const id2=await register();
 const code2=await enroll(id2,secretB,'https://project-bbb2.supabase.co/',keyB);
 const token2=(await getTokens(id2,code2)).data;
 const revokeRefresh=await form('/revoke',{token:token2.refresh_token});
 assert.equal(revokeRefresh.status,200);
 assert.equal((await tool(token2.access_token)).status,401);
});
