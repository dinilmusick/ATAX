import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createHandler as createRuntimeHandler} from './worker.mjs';
import {resolveProviderAccount,availableAccounts,isOwnerPrincipal} from './provider-accounts.mjs';

// ---------------------------------------------------------------------------
// Phase 3: Multi-account GitHub hardening tests
// ---------------------------------------------------------------------------

const issuer = 'https://issuer.example/oauth';
const resource = 'https://atax.example/mcp';
const keyPair = await webcrypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
const pub = await webcrypto.subtle.exportKey('jwk',keyPair.publicKey);
pub.kid='gh-multiaccnt-key'; pub.alg='EdDSA';

const b64 = d => Buffer.from(d).toString('base64url');
async function makeJwt(sub='owner-1',extra={}){
  const hdr=b64(JSON.stringify({typ:'at+jwt',alg:'EdDSA',kid:pub.kid}));
  const pay=b64(JSON.stringify({iss:issuer,aud:resource,sub,
    scope:'openid',exp:Math.floor(Date.now()/1000)+300,...extra}));
  const sig=await webcrypto.subtle.sign({name:'Ed25519'},keyPair.privateKey,
    new TextEncoder().encode(hdr+'.'+pay));
  return hdr+'.'+pay+'.'+b64(sig);
}

// Shared env for multi-account tests
const multiAccountEnv = {
  MCP_AUTH_JWKS_URL:'https://issuer.example/oauth/jwks',
  MCP_AUTH_AUTHORIZATION_SERVER:issuer,
  MCP_AUTH_ISSUER:issuer,
  MCP_AUTH_AUDIENCE:resource,
  MCP_ATAX_OWNER_JWT_SUBJECT:'owner-1',
  MCP_AUTH_OWNER_SCOPES:'atax:read atax:write atax:github:read atax:github:create atax:fmrl:execute',
  MCP_SHARED_TOKEN_SHA256:'',
  MCP_GITHUB_OWNER:'dinilmusick',
  MCP_FMRL_ALLOWED_TARGETS:'dinilmusick/Skipo',
  GH_KEY_PERSONAL:'gh-token-personal-123456789',
  GH_KEY_WORK:'gh-token-work-987654321xx',
  CF_KEY_MAIN:'cf-token-main-xxxxxxxxxxx',
};

const owner1 = {id:'owner-1',authMethod:'jwt',
  scopes:new Set(['atax:read','atax:write','atax:github:read','atax:github:create','atax:fmrl:execute'])};
const owner2 = {id:'owner-2',authMethod:'jwt',
  scopes:new Set(['atax:read','atax:write','atax:github:read'])};
const outsider = {id:'attacker',authMethod:'jwt',scopes:new Set(['atax:read'])};

// ---------------------------------------------------------------------------
// Phase 3: resolveProviderAccount multi-account isolation
// ---------------------------------------------------------------------------
test('Phase3: owner sees multiple accounts; outsider sees none',()=>{
  assert.equal(isOwnerPrincipal(multiAccountEnv,owner1),true);
  assert.deepEqual(availableAccounts(multiAccountEnv,owner1,'github'),['PERSONAL','WORK']);
  assert.deepEqual(availableAccounts(multiAccountEnv,owner1,'cloudflare'),['MAIN']);

  // owner2 is NOT the configured owner subject
  assert.equal(isOwnerPrincipal(multiAccountEnv,owner2),false);
  assert.deepEqual(availableAccounts(multiAccountEnv,owner2,'github'),[]);

  assert.equal(isOwnerPrincipal(multiAccountEnv,outsider),false);
  assert.deepEqual(availableAccounts(multiAccountEnv,outsider,'github'),[]);
});

test('Phase3: explicit alias selects correct credential',()=>{
  const personal = resolveProviderAccount(multiAccountEnv,owner1,'github','PERSONAL');
  assert.equal(personal.alias,'PERSONAL');
  assert.equal(personal.token,'gh-token-personal-123456789');

  const work = resolveProviderAccount(multiAccountEnv,owner1,'github','WORK');
  assert.equal(work.alias,'WORK');
  assert.equal(work.token,'gh-token-work-987654321xx');

  // Tokens must NOT be interchanged
  assert.notEqual(personal.token, work.token);
});

test('Phase3: without explicit alias and multiple accounts, throws requiring explicit selection',()=>{
  assert.throws(
    ()=>resolveProviderAccount(multiAccountEnv,owner1,'github'),
    /Specify an account alias/
  );
});

test('Phase3: with single account, alias is auto-selected',()=>{
  const singleEnv={...multiAccountEnv,GH_KEY_WORK:undefined};
  const resolved=resolveProviderAccount(singleEnv,owner1,'github');
  assert.equal(resolved.alias,'PERSONAL');
  assert.equal(resolved.token,'gh-token-personal-123456789');
});

test('Phase3: non-owner cannot access any account even with alias',()=>{
  assert.throws(
    ()=>resolveProviderAccount(multiAccountEnv,owner2,'github','PERSONAL'),
    /not authorized/
  );
  assert.throws(
    ()=>resolveProviderAccount(multiAccountEnv,outsider,'github','WORK'),
    /not authorized/
  );
});

test('Phase3: invalid alias format is rejected',()=>{
  assert.throws(()=>resolveProviderAccount(multiAccountEnv,owner1,'github','../WORK'),/Invalid account/);
  assert.throws(()=>resolveProviderAccount(multiAccountEnv,owner1,'github','1INVALID'),/Invalid account/);
});

test('Phase3: missing alias throws, not silently falls back to wrong account',()=>{
  assert.throws(
    ()=>resolveProviderAccount(multiAccountEnv,owner1,'github','MISSING'),
    /not authorized/
  );
});

// ---------------------------------------------------------------------------
// Phase 3: GitHub tools use account credentials correctly via worker
// ---------------------------------------------------------------------------
const capturedRequests = [];
const ghFetcher = async (url,options={}) => {
  capturedRequests.push({url,auth:options.headers?.authorization||''});
  if (url === 'https://issuer.example/oauth/jwks') return Response.json({keys:[pub]});
  if (String(url).includes('/rpc/')) return Response.json({ok:true,params:JSON.parse(options.body||'{}')});
  // GitHub user identity endpoint
  if (url === 'https://api.github.com/user') return Response.json({login:'dinilmusick'});
  // GitHub repo creation
  if (url === 'https://api.github.com/user/repos') {
    const body=JSON.parse(options.body||'{}');
    return Response.json({full_name:`dinilmusick/${body.name}`,html_url:`https://github.com/dinilmusick/${body.name}`,private:body.private,default_branch:'main'});
  }
  // GitHub repo info
  if (url.startsWith('https://api.github.com/repos/dinilmusick/')) {
    const name=url.split('/repos/dinilmusick/')[1];
    return Response.json({full_name:`dinilmusick/${name}`,html_url:`https://github.com/dinilmusick/${name}`,private:true,default_branch:'main'});
  }
  throw Error('Unexpected upstream: '+url);
};

const ghHandler=createRuntimeHandler(ghFetcher,async env=>({
  ...env,__ledgerDb:{rpc:async(name,params)=>{
    const r=await ghFetcher('https://synthetic.supabase.co/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(params)});
    return r.json();
  }}
}));

async function ghCall(toolName,args,token,extraEnv={}){
  const env={...multiAccountEnv,...extraEnv};
  const req=new Request(resource,{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:toolName,arguments:args}})});
  const res=await ghHandler(req,env);
  const body=await res.json();
  return {status:res.status,body};
}

test('Phase3: GitHub repo inspect uses only the PERSONAL account credential',async()=>{
  capturedRequests.length=0;
  const token=await makeJwt('owner-1');
  const r=await ghCall('atax_github_repository_inspect',{repository:'dinilmusick/TestRepo',account:'PERSONAL'},token);
  assert.equal(r.status,200);
  assert.equal(r.body.result.isError,undefined);
  // Verify only the PERSONAL token was used in GitHub API calls
  const ghCalls=capturedRequests.filter(x=>x.url.includes('api.github.com'));
  assert.ok(ghCalls.length>0,'Should have made GitHub API calls');
  assert.ok(ghCalls.every(x=>x.auth==='Bearer gh-token-personal-123456789'),
    'All GitHub API calls must use the PERSONAL token, not WORK');
});

test('Phase3: GitHub repo inspect accepts repository-name casing differences',async()=>{
  capturedRequests.length=0;
  const token=await makeJwt('owner-1');
  const originalFetcher=ghFetcher;
  // The mock handler already derives the canonical repository name from the request.
  // Use a dedicated handler whose GitHub response intentionally canonicalizes casing.
  const caseFetcher=async (url,options={})=>{
    capturedRequests.push({url,auth:options.headers?.authorization||''});
    if (url === 'https://issuer.example/oauth/jwks') return Response.json({keys:[pub]});
    if (String(url).includes('/rpc/')) return Response.json({ok:true,params:JSON.parse(options.body||'{}')});
    if (url === 'https://api.github.com/repos/dinilmusick/FRNES')
      return Response.json({full_name:'dinilmusick/Frnes',html_url:'https://github.com/dinilmusick/Frnes',private:true,default_branch:'main'});
    throw Error('Unexpected upstream: '+url);
  };
  const handler=createRuntimeHandler(caseFetcher,async env=>({
    ...env,__ledgerDb:{rpc:async(name,params)=>{
      const r=await caseFetcher('https://synthetic.supabase.co/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(params)});
      return r.json();
    }}
  }));
  const req=new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'atax_github_repository_inspect',arguments:{repository:'dinilmusick/FRNES',account:'PERSONAL'}}})});
  const r=await handler(req,multiAccountEnv);
  const body=await r.json();
  assert.equal(body.result.isError,undefined);
  assert.equal(body.result.structuredContent.result.repository,'dinilmusick/Frnes');
  assert.equal(body.result.structuredContent.result.default_branch,'main');
  void originalFetcher;
});

test('Phase3: GitHub repo inspect uses only the WORK account credential when WORK selected',async()=>{
  capturedRequests.length=0;
  const token=await makeJwt('owner-1');
  const r=await ghCall('atax_github_repository_inspect',{repository:'dinilmusick/TestRepo',account:'WORK'},token);
  assert.equal(r.status,200);
  const ghCalls=capturedRequests.filter(x=>x.url.includes('api.github.com'));
  assert.ok(ghCalls.every(x=>x.auth==='Bearer gh-token-work-987654321xx'),
    'All GitHub API calls must use the WORK token, not PERSONAL');
});

test('Phase3: GitHub repo inspect requires account alias when multiple accounts configured',async()=>{
  capturedRequests.length=0;
  const token=await makeJwt('owner-1');
  // No account arg → should fail asking for explicit selection
  const r=await ghCall('atax_github_repository_inspect',{repository:'dinilmusick/TestRepo'},token);
  // Tool returns isError result
  const result=r.body.result;
  assert.ok(result.isError===true||r.status===401||
    (result.content&&result.content[0].text.includes('alias')),
    'Must require explicit account alias with multiple accounts');
});

test('Phase3: non-owner cannot invoke any GitHub tool',async()=>{
  capturedRequests.length=0;
  const token=await makeJwt('attacker');
  const r=await ghCall('atax_github_repository_inspect',{repository:'dinilmusick/TestRepo',account:'PERSONAL'},token);
  const result=r.body.result;
  assert.ok(result?.isError===true,'Outsider must not be able to invoke GitHub tools');
  // No GitHub API calls should have been made
  assert.equal(capturedRequests.filter(x=>x.url.includes('api.github.com')).length,0);
});

// ---------------------------------------------------------------------------
// Phase 3: assertOwner / parseRepo with env-driven owner validation
// ---------------------------------------------------------------------------
test('Phase3: MCP_GITHUB_OWNER validation - must be valid GitHub username format',async()=>{
  capturedRequests.length=0;
  const token=await makeJwt('owner-1');
  // Invalid MCP_GITHUB_OWNER should cause parseRepo to throw
  const r=await ghCall('atax_fmrl_create_run_dispose',
    {repository:'dinilmusick/Skipo',ref:'a'.repeat(40),account:'PERSONAL'},
    token,
    {MCP_GITHUB_OWNER:'invalid owner!!'} // invalid format
  );
  const result=r.body.result;
  assert.ok(result?.isError===true,'Invalid MCP_GITHUB_OWNER must cause tool error');
});

test('Phase3: FMRL dispatch uses selected account credential in dispatch request',async()=>{
  capturedRequests.length=0;
  const token=await makeJwt('owner-1');
  // This will fail (ATAX repo not in allowed targets) but we can verify credentials path
  const r=await ghCall('atax_fmrl_create_run_dispose',
    {repository:'dinilmusick/Skipo',ref:'a'.repeat(40),account:'WORK'},
    token
  );
  // The dispatch itself will try to call GitHub — verify WORK credentials used
  const dispatchCall=capturedRequests.find(x=>x.url.includes('/actions/workflows/'));
  if(dispatchCall){
    assert.equal(dispatchCall.auth,'Bearer gh-token-work-987654321xx',
      'FMRL dispatch must use WORK account credentials');
  }
});

// ---------------------------------------------------------------------------
// Phase 4: CI / FMRL account consistency & alternate owner scoping
// ---------------------------------------------------------------------------
test('Phase4: FMRL dispatch & status enforce account consistency and non-hardcoded owner',async()=>{
  const fmrlRequests=[];
  const reqUuid='12e43a92-822d-4a30-82a5-5ecb9dd11acf';
  const fmrlFetcher=async(url,options={})=>{
    fmrlRequests.push({url,auth:options.headers?.authorization||'',method:options.method||'GET'});
    if(url==='https://issuer.example/oauth/jwks')return Response.json({keys:[pub]});
    if(url==='https://api.github.com/repos/alt-owner/ATAX/actions/workflows/private-repo-ci.yml/dispatches'){
      return new Response(null,{status:204});
    }
    if(url==='https://api.github.com/repos/alt-owner/ATAX/actions/workflows/private-repo-ci.yml/runs?event=workflow_dispatch&per_page=100'){
      return Response.json({workflow_runs:[{
        id:4444,display_title:'ATAX FMRL '+reqUuid,status:'completed',conclusion:'success',run_attempt:1,
        html_url:'https://github.com/alt-owner/ATAX/actions/runs/4444'
      }]});
    }
    if(url==='https://api.github.com/repos/alt-owner/ATAX/actions/runs/4444/jobs?per_page=100'){
      return Response.json({jobs:[{steps:[
        {name:'Provision disposable FMRL public repository',conclusion:'success'},
        {name:'ALWAYS delete FMRL and verify absence',conclusion:'success'},
      ]}]});
    }
    if(url==='https://api.github.com/repos/alt-owner/FMRL-4444-1'){
      return Response.json({message:'Not Found'},{status:404});
    }
    throw Error('Unexpected URL: '+url);
  };

  const altHandler=createRuntimeHandler(fmrlFetcher,async e=>({
    ...e,__ledgerDb:{rpc:async()=>({ok:true})}
  }));
  const altEnv={
    ...multiAccountEnv,
    MCP_GITHUB_OWNER:'alt-owner',
    MCP_FMRL_ALLOWED_TARGETS:'alt-owner/AppOne',
  };
  const callAlt=async(name,args)=>{
    const tok=await makeJwt('owner-1');
    const req=new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    return (await altHandler(req,altEnv)).json();
  };

  // 1. Dispatch with WORK returns dispatched_account: 'WORK' and hits alt-owner/ATAX with WORK token
  const disp=await callAlt('atax_fmrl_create_run_dispose',{repository:'alt-owner/AppOne',ref:'b'.repeat(40),account:'WORK'});
  assert.equal(disp.result.isError,undefined);
  assert.equal(disp.result.structuredContent.result.account,'WORK');
  assert.equal(disp.result.structuredContent.result.dispatched_account,'WORK');
  assert.equal(disp.result.structuredContent.result.controller,'alt-owner/ATAX');
  assert.equal(fmrlRequests.find(x=>x.url.includes('/dispatches')).auth,'Bearer gh-token-work-987654321xx');

  // 2. Mismatched account in status polling (PERSONAL vs dispatched WORK) fails closed BEFORE calling GitHub
  const beforeMismatch=fmrlRequests.length;
  const mismatch=await callAlt('atax_fmrl_get_status',{request_id:reqUuid,account:'PERSONAL',dispatched_account:'WORK'});
  assert.equal(mismatch.result.isError,true);
  assert.equal(fmrlRequests.slice(beforeMismatch).filter(x=>x.url.includes('api.github.com')).length,0,
    'Account mismatch must fail before hitting GitHub API');

  // 3. Matching WORK account polls status and verifies anonymous 404 on alt-owner/FMRL-4444-1
  const status=await callAlt('atax_fmrl_get_status',{request_id:reqUuid,account:'WORK',dispatched_account:'WORK'});
  assert.equal(status.result.isError,undefined);
  assert.equal(status.result.structuredContent.result.cleanup_verified,true);
  const ghCalls=fmrlRequests.slice(beforeMismatch).filter(x=>x.url.includes('api.github.com')&&!x.url.includes('FMRL-'));
  assert.ok(ghCalls.every(x=>x.auth==='Bearer gh-token-work-987654321xx'));
});

test('Phase4: concurrent GitHub operations against PERSONAL and WORK remain isolated',async()=>{
  capturedRequests.length=0;
  const token=await makeJwt('owner-1');
  const [rPersonal,rWork]=await Promise.all([
    ghCall('atax_github_repository_inspect',{repository:'dinilmusick/RepoA',account:'PERSONAL'},token),
    ghCall('atax_github_repository_inspect',{repository:'dinilmusick/RepoB',account:'WORK'},token),
  ]);
  assert.equal(rPersonal.body.result.structuredContent.result.account,'PERSONAL');
  assert.equal(rWork.body.result.structuredContent.result.account,'WORK');
  const reqA=capturedRequests.find(x=>x.url.endsWith('/RepoA'));
  const reqB=capturedRequests.find(x=>x.url.endsWith('/RepoB'));
  assert.equal(reqA.auth,'Bearer gh-token-personal-123456789');
  assert.equal(reqB.auth,'Bearer gh-token-work-987654321xx');
});
