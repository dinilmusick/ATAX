import test from 'node:test';
import assert from 'node:assert/strict';
import {availableAccounts,resolveProviderAccount,providerTools} from './provider-accounts.mjs';

const owner={id:'owner',authMethod:'shared'};
const client={id:'client',authMethod:'jwt'};
const env={
  MCP_SHARED_SUBJECT:'owner',
  MCP_SHARED_TOKEN_SHA256:'synthetic-owner-digest',
  GH_TOKEN_PERSONAL:'git-personal-secret',
  GH_TOKEN_WORK:'git-work-secret',
  CLOUDFLARE_TOKEN_PERSONAL:'cf-personal-secret',
  CLOUDFLARE_TOKEN_WORK:'cf-work-secret',
  CLOUDFLARE_ACCOUNT_ID_WORK:'abc12345',
  VERCEL_TOKEN_PERSONAL:'vercel-personal-secret',
  VERCEL_TOKEN_WORK:'vercel-work-secret',
  VERCEL_TEAM_ID_WORK:'team_work',
  MCP_PROVIDER_ACCOUNT_GRANTS:JSON.stringify({client:{github:['WORK'],cloudflare:['WORK'],vercel:['WORK']}})
};
const find=(name)=>providerTools.find(x=>x.name===name);
const invoke=(name,args,principal=owner,config=env,fetcher=async()=>Response.json({}))=>
  find(name).invoke(args,null,principal,{env:config,fetcher});

test('discover dynamic provider aliases without exposing their secret values',async()=>{
  assert.deepEqual(availableAccounts(env,owner,'github'),['PERSONAL','WORK']);
  assert.deepEqual(availableAccounts(env,client,'github'),['WORK']);
  assert.deepEqual(availableAccounts(env,client,'cloudflare'),['WORK']);
  const output=await invoke('atax_provider_accounts_list',{},client);
  assert.deepEqual(output.accounts.find(x=>x.provider==='github').aliases,['WORK']);
  assert.ok(!JSON.stringify(output).includes('secret'));
  assert.ok(!JSON.stringify(output).includes('token'));
});

test('account suffix selects exact credential and never falls back to different account',()=>{
  assert.equal(resolveProviderAccount(env,owner,'github','WORK').token,'git-work-secret');
  assert.throws(()=>resolveProviderAccount(env,owner,'github'),/Specify an account alias/);
  assert.throws(()=>resolveProviderAccount(env,client,'github','PERSONAL'),/not authorized/);
  assert.throws(()=>resolveProviderAccount(env,client,'github','../WORK'),/Invalid account/);
  assert.throws(()=>resolveProviderAccount(env,{id:'unauthorized'},'github','WORK'),/not authorized/);
  assert.throws(()=>resolveProviderAccount(env,client,'github','NO_SUCH_ACCOUNT'),/not authorized/);
});

test('single secret works without account argument; legacy token preserved for bootstrap',()=>{
  const single={...env,GH_TOKEN_WORK:undefined,CLOUDFLARE_TOKEN_WORK:undefined,VERCEL_TOKEN_WORK:undefined};
  assert.equal(resolveProviderAccount(single,owner,'github').alias,'PERSONAL');
  const legacy={MCP_SHARED_SUBJECT:'owner',MCP_SHARED_TOKEN_SHA256:'synthetic-owner-digest',GITHUB_REPOSITORY_TOKEN:'old-github-token'};
  assert.equal(resolveProviderAccount(legacy,owner,'github',undefined,{legacyKey:'GITHUB_REPOSITORY_TOKEN'}).token,'old-github-token');
  assert.throws(()=>resolveProviderAccount(legacy,client,'github',undefined,{legacyKey:'GITHUB_REPOSITORY_TOKEN'}));
});

test('JWT identity cannot impersonate bootstrap owner by reusing the same subject',()=>{
  const forgedOwner={id:'owner',authMethod:'jwt'};
  assert.deepEqual(availableAccounts(env,forgedOwner,'github'),[]);
  assert.deepEqual(availableAccounts(env,forgedOwner,'cloudflare'),[]);
  assert.deepEqual(availableAccounts(env,forgedOwner,'vercel'),[]);
  assert.throws(()=>resolveProviderAccount(env,forgedOwner,'github','WORK'),/not authorized/);
  assert.throws(()=>resolveProviderAccount(env,forgedOwner,'github','PERSONAL'),/not authorized/);
  assert.throws(()=>resolveProviderAccount(env,{id:'owner'},'github','PERSONAL'),/not authorized/);
  const legacy={MCP_SHARED_SUBJECT:'owner',MCP_SHARED_TOKEN_SHA256:'synthetic-owner-digest',GITHUB_REPOSITORY_TOKEN:'old-github-token'};
  assert.throws(()=>resolveProviderAccount(legacy,forgedOwner,'github',undefined,{legacyKey:'GITHUB_REPOSITORY_TOKEN'}),/not authorized/);
  assert.equal(resolveProviderAccount(legacy,owner,'github',undefined,{legacyKey:'GITHUB_REPOSITORY_TOKEN'}).token,'old-github-token');
});

test('Cloudflare calls selected token; response strips provider secrets and extra fields',async()=>{
  const requests=[];
  const fetcher=async(url,opts)=>{
    requests.push({url,opts});
    if(url.includes('/workers/scripts'))return Response.json({success:true,result:[{id:'example-worker',modified_on:'2026-11-20',secret:'NEVER_RETURN'}]});
    return Response.json({success:true,result:[{id:'abc12345',name:'My CF Account',secret:'NEVER_RETURN'}]});
  };
  const accounts=await invoke('atax_cloudflare_accounts_list',{account:'WORK'},client,env,fetcher);
  const workers=await invoke('atax_cloudflare_workers_list',{account:'WORK'},client,env,fetcher);
  assert.equal(accounts.accounts[0].id,'abc12345');
  assert.equal(workers.scripts[0].id,'example-worker');
  assert.ok(requests.every(r=>r.opts.headers.authorization==='Bearer cf-work-secret'));
  assert.ok(!JSON.stringify(workers).includes('NEVER_RETURN'));
  assert.throws(()=>resolveProviderAccount(env,client,'cloudflare','PERSONAL'),/not authorized/);
  await assert.rejects(invoke('atax_cloudflare_workers_list',{account:'WORK',account_id:'different'},client,env,fetcher),/differs/);
});

test('Vercel queries selected team and project, with bounded normalized results',async()=>{
  const requests=[];
  const fetcher=async(url,opts)=>{
    requests.push({url,opts});
    return Response.json(url.includes('/v6/')?{deployments:[{uid:'d1',name:'web',state:'ERROR',readyState:'ERROR',url:'web.example',untrustedCredential:'NEVER_RETURN'}]}:
      {projects:[{id:'prj_123',name:'web',framework:'nextjs',untrustedCredential:'NEVER_RETURN'}]});
  };
  const projects=await invoke('atax_vercel_projects_list',{account:'WORK'},client,env,fetcher);
  const deployments=await invoke('atax_vercel_deployments_list',{account:'WORK',project_id:'prj_123'},client,env,fetcher);
  assert.equal(projects.projects[0].name,'web');
  assert.equal(deployments.deployments[0].state,'ERROR');
  assert.ok(requests.every(r=>r.opts.headers.authorization==='Bearer vercel-work-secret'));
  assert.ok(requests.every(r=>r.url.includes('teamId=team_work')));
  assert.ok(requests.some(r=>r.url.includes('projectId=prj_123')));
  assert.ok(!JSON.stringify(projects).includes('NEVER_RETURN'));
});

test('expired permissions, missing bindings, provider errors and invalid responses fail closed',async()=>{
  const noGrant={...env,MCP_PROVIDER_ACCOUNT_GRANTS:'{}'};
  await assert.rejects(invoke('atax_vercel_projects_list',{account:'WORK'},client,noGrant),/not authorized/);
  await assert.rejects(invoke('atax_vercel_projects_list',{account:'WORK'},owner,env,async()=>Response.json({}, {status:403})),/HTTP 403/);
  await assert.rejects(invoke('atax_vercel_projects_list',{account:'WORK'},owner,env,async()=>new Response('garbage')),/invalid JSON/);
  await assert.rejects(invoke('atax_cloudflare_workers_list',{account:'PERSONAL'},owner,env),/account ID required/);
  assert.deepEqual(availableAccounts({...env,GH_TOKEN_HIDDEN:''},owner,'github'),['PERSONAL','WORK']);
});

test('Cloudflare Worker deployments and issue summary remain account pinned and return metadata only',async()=>{
 const requested=[];
 const fetcher=async(url,opts)=>{
  requested.push({url,opts});
  if(url.endsWith('/deployments'))return Response.json({success:true,result:{deployments:[{
   id:'deployment-1',created_on:'2026-11-20',source:'api',
   versions:[{version_id:'version-1',percentage:100,secret:'NEVER_RETURN'}],
   secret:'NEVER_RETURN'
  }]}});
  if(url.endsWith('/issues/summary'))return Response.json({success:true,result:{activeIssues:3,activeOccurrences:8,resolvedIssues:5,secret:'NEVER_RETURN'}});
  throw Error('Unexpected Cloudflare URL '+url);
 };
 const data=await invoke('atax_cloudflare_worker_deployments',{account:'WORK',script:'example-worker'},client,env,fetcher);
 assert.equal(data.deployments[0].versions[0].percentage,100);
 assert.ok(!JSON.stringify(data).includes('NEVER_RETURN'));
 assert.ok(requested.every(x=>x.url.includes('/accounts/abc12345/')));
 const errors=await invoke('atax_cloudflare_issue_summary',{account:'WORK'},client,env,fetcher);
 assert.equal(errors.active_issues,3);
 await assert.rejects(invoke('atax_cloudflare_worker_deployments',{account:'WORK',script:'../secret'},client,env,fetcher),/Invalid Cloudflare Worker/);
});
test('Vercel logs are bounded, redacted, and reject unapproved deployment identifiers',async()=>{
 const privateValue=['unit','private','never','print'].join('-');
 const fetcher=async(url,opts)=>{
  assert.ok(url.includes('/v3/deployments/dpl_12345678901234567/events?builds=1'));
  assert.ok(url.includes('teamId=team_work'));
  return Response.json([{type:'stderr',level:'error',text:'Build failed. token='+privateValue,created:3}]);
 };
 const logs=await invoke('atax_vercel_build_events',{account:'WORK',deployment_id:'dpl_12345678901234567'},client,env,fetcher);
 assert.equal(logs.events.length,1);
 assert.ok(!JSON.stringify(logs).includes(privateValue));
 assert.match(logs.events[0].message,/REDACTED/);
 await assert.rejects(invoke('atax_vercel_build_events',{account:'WORK',deployment_id:'../other'},client,env,fetcher),/Invalid Vercel deployment ID/);
});
