import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,randomBytes} from 'node:crypto';
import {createHandler,testToolDescriptors} from './worker.mjs';
import {invite,revokeInvite,saveConnection} from './tenant-store.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
class DB {
 constructor(){this.users=new Map();this.credentials=new Map();this.audit=[];}
 prepare(sql){const state=this;let args=[];
  return {bind(...v){args=v;return this;},
   async first(){return sql.startsWith('SELECT scopes,active')?state.users.get(args[0])||null:null;},
   async all(){
    if(sql.startsWith('SELECT subject,provider,alias'))return {results:[...state.credentials.values()].filter(x=>x.subject===args[0])};
    if(sql.startsWith('SELECT provider,alias,metadata'))return {results:[...state.credentials.values()].filter(x=>x.subject===args[0])};
    if(sql.startsWith('SELECT subject,active'))return {results:[...state.users.entries()].map(([subject,p])=>({subject,...p}))};
    throw Error('Unexpected DB query');
   },async run(){
    if(sql.startsWith('INSERT INTO atax_principals'))state.users.set(args[0],{active:1,scopes:args[1]});
    else if(sql.startsWith('DELETE FROM atax_access_keys WHERE subject=?')){ /* no invitation keys in this fixture */ }
        else if(sql.startsWith('UPDATE atax_principals'))state.users.get(args[0]).active=0;
    else if(sql.startsWith('INSERT INTO atax_connections')){
     const [subject,provider,alias,ciphertext,iv,metadata]=args;
     state.credentials.set([subject,provider,alias].join(':'),{subject,provider,alias,ciphertext,iv,metadata});
    }else if(sql.startsWith('DELETE FROM atax_connections WHERE subject=?')){
     for(const key of state.credentials.keys())if(key.startsWith(args[0]+':'))state.credentials.delete(key);
    }else if(sql.startsWith('INSERT INTO atax_audit'))state.audit.push(args);
    else throw Error('Unexpected DB mutation');
    return {success:true};
   }
  };
 }
}
test('hosted Worker refuses shared owner token and unrelated users; authorized users hydrate only own Supabase',async()=>{
 const keys=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const pub=await webcrypto.subtle.exportKey('jwk',keys.publicKey);Object.assign(pub,{kid:'test-kid',alg:'RS256'});
 const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-kid'})).toString('base64url');
 const sign=async(sub,scope='atax:read')=>{
  const payload=Buffer.from(JSON.stringify({iss:'https://id.example',aud:'atax',sub,scope,exp:Math.floor(Date.now()/1000)+1000})).toString('base64url');
  const sig=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(header+'.'+payload));
  return header+'.'+payload+'.'+Buffer.from(sig).toString('base64url');
 };
 const token=['unit','only','private','supabase','key','alice'].join('_');
 const url='https://abcdefghijklmnopqrst.supabase.co';
 const db=new DB();
 const env={ATAX_TENANTS:db,MCP_MULTI_TENANT_ENABLED:'true',
  MCP_VAULT_KEY_B64:randomBytes(32).toString('base64'),MCP_ADMIN_SUBJECT:'admin-principal',
  MCP_AUTH_JWKS_URL:'https://id.example/jwks',MCP_AUTH_ISSUER:'https://id.example',MCP_AUTH_AUDIENCE:'atax',
  SUPABASE_URL:'https://ownerprojectxxxxxxxx.supabase.co',SUPABASE_SERVICE_ROLE_KEY:['owner','global','key','must','never','be','used'].join('_'),
  MCP_SHARED_TOKEN_SHA256:'e'.repeat(64),MCP_SHARED_SUBJECT:'owner-principal',
  GH_TOKEN_OWNER:['owner','github','token','test','only'].join('_')};
 let observed=[];
 const fetcher=async(requestUrl,options={})=>{
  observed.push({url:requestUrl,headers:options.headers||{}});
  if(requestUrl==='https://id.example/jwks')return Response.json({keys:[pub]});
  if(requestUrl===url+'/rest/v1/rpc/agent_context_overview')return Response.json({source:'alice',isolated:true});
  throw Error('Unexpected external request');
 };
 const handler=createHandler(fetcher);
 const post=async(jwt,method='tools/list',params={})=>
  handler(new Request('https://atax.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env);
 assert.equal((await post('unusable-shared-bearer-token')).status,401);
 assert.equal((await post(await sign('not-invited'))).status,403);
 const admin={id:'admin-principal',authMethod:'jwt',scopes:new Set(['atax:admin'])};
 await invite(env,admin,{subject:'alice-principal',scopes:['atax:read','atax:write']});
 await invite(env,admin,{subject:'bob-principal',scopes:['atax:read']});
 await saveConnection(env,{id:'alice-principal'}, {provider:'supabase',alias:'DEFAULT',url,token});
 const alice=await sign('alice-principal');
 const init=await post(alice,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
 assert.equal(init.status,200);
 assert.ok(testToolDescriptors.some(x=>x.name==='atax_context' && x.scope==='atax:read'),JSON.stringify(testToolDescriptors.slice(0,5)));
 const listResult=await (await post(alice,'tools/list')).json(); assert.ok(listResult.result?.tools?.some(x=>x.name==='atax_context'),JSON.stringify(listResult));
 const call=await post(alice,'tools/call',{name:'atax_context',arguments:{}});
 assert.equal(call.status,200);const returned=await call.json();assert.ok(returned.result?.structuredContent,JSON.stringify(returned));assert.deepEqual(returned.result.structuredContent.result,{source:'alice',isolated:true});
 assert.equal(observed.some(x=>x.url.startsWith('https://ownerproject')),false);
 const bob=await sign('bob-principal');
 const blocked=await post(bob,'tools/call',{name:'atax_context',arguments:{}});
 assert.equal((await blocked.json()).result.isError,true);
 const noFmrl=await post(alice,'tools/call',{name:'atax_fmrl_create_run_dispose',arguments:{}});
 assert.equal((await noFmrl.json()).result.isError,true);
 await revokeInvite(env,admin,'alice-principal');
 assert.equal((await post(alice)).status,403);
 const missing={...env,MCP_VAULT_KEY_B64:undefined};
 const noConfig=await createHandler(fetcher)(new Request('https://atax.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+alice,'Content-Type':'application/json'},body:'{}'}),missing);
 assert.equal(noConfig.status,503);
 const page=await createHandler(fetcher)(new Request('https://atax.example/setup'),missing);
 assert.equal(page.status,200);
 assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
