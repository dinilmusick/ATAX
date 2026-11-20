import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {authenticateHostedInviteKey,authorizeHostedPrincipal,hostedConfigured} from './tenant-store.mjs';
import {createHandler} from './worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const token='atax_'+('A'.repeat(64)),digest=createHash('sha256').update(token).digest('hex');
const scopes=['atax:read','atax:github:read'];
function makeEnv(){
 const users=new Map([['guest-principal',{active:1,scopes:JSON.stringify(scopes)}]]);
 const keys=new Map([[digest,{subject:'guest-principal',scopes:JSON.stringify(scopes),active:1}]]);
 const db={prepare(sql){
  let args=[];
  return {bind(...a){args=a;return this;},
   async first(){
    if(sql.startsWith('SELECT subject,scopes FROM atax_access_keys')){
     const record=keys.get(args[0]);return record?.active?record:null;
    }
    if(sql.startsWith('SELECT scopes,active FROM atax_principals'))return users.get(args[0])||null;
    throw Error('Unknown D1 query '+sql);
   },
   async all(){
    if(sql.startsWith('SELECT subject,provider,alias'))return {results:[]};
    throw Error('Unknown D1 all query '+sql);
   }
  };
 }};
 return {users,keys,env:{ATAX_TENANTS:db,MCP_MULTI_TENANT_ENABLED:'true',MCP_INVITATIONS_ENABLED:'true',
  MCP_VAULT_KEY_B64:Buffer.alloc(32,8).toString('base64'),
  SUPABASE_URL:'https://owner-should-not-be-used.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY:'owner-key-never-selected',
  MCP_SHARED_TOKEN_SHA256:createHash('sha256').update('legacy-owner-auth').digest('hex'),
  MCP_SHARED_SUBJECT:'owner-principal'}};
}
test('invitation mode needs no external OAuth; it binds only invited subject and scopes',async()=>{
 const {env,users,keys}=makeEnv();
 assert.equal(hostedConfigured(env),true);
 const p=await authenticateHostedInviteKey(env,token);
 assert.equal(p.id,'guest-principal');
 assert.equal(p.authMethod,'invitation');
 assert.deepEqual([...p.scopes],scopes);
 assert.equal(await authenticateHostedInviteKey(env,'atax_'+('B'.repeat(64))),null);
 assert.equal(await authenticateHostedInviteKey(env,'legacy-owner-auth'),null);
 keys.get(digest).active=0;
 assert.equal(await authenticateHostedInviteKey(env,token),null);
 keys.get(digest).active=1;
 users.get('guest-principal').active=0;
 assert.equal(await authenticateHostedInviteKey(env,token),null);
});
test('actual MCP accepts invited access key, hides canonical owner FMRL, denies revoked key',async()=>{
 const {env,users}=makeEnv(),handle=createHandler(async()=>{throw Error('Unexpected network call')});
 async function request(bearer,method='tools/list',params={}){
  const r=await handle(new Request('https://atax.example/mcp',{method:'POST',
   headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env);
  return {status:r.status,body:await r.json()};
 }
 const allowed=await request(token);
 assert.equal(allowed.status,200);
 const names=allowed.body.result.tools.map(t=>t.name);
 assert.ok(names.includes('atax_context'));
 assert.ok(names.includes('atax_provider_accounts_list'));
 assert.ok(!names.includes('atax_fmrl_create_run_dispose'));
 const accounts=await request(token,'tools/call',{name:'atax_provider_accounts_list',arguments:{}});
 assert.equal(accounts.status,200);
 assert.ok(accounts.body.result.structuredContent);
 assert.deepEqual(accounts.body.result.structuredContent.result.accounts.find(x=>x.provider==='github').aliases,[]);
 const denied=await request(token,'tools/call',{name:'atax_fmrl_create_run_dispose',arguments:{}});
 assert.equal(denied.body.result.isError,true);
 assert.equal((await request('legacy-owner-auth')).status,401);
 users.get('guest-principal').active=0;
 assert.equal((await request(token)).status,401);
});
test('JWT owner cannot bypass invite-key mode; user key expiry and malformed hashes deny',async()=>{
 const {env,keys}=makeEnv();
 assert.equal(await authenticateHostedInviteKey({...env,MCP_INVITATIONS_ENABLED:'false'},token),null);
 assert.equal(await authenticateHostedInviteKey(env,'atax_'+('A'.repeat(23))),null);
 const fake={id:'owner-principal',authMethod:'shared',scopes:new Set(['atax:admin'])};
 assert.equal(await authorizeHostedPrincipal(env,fake),null);
 keys.delete(digest);assert.equal(await authenticateHostedInviteKey(env,token),null);
});
