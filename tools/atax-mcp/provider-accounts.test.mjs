import test from 'node:test';
import assert from 'node:assert/strict';
import {availableAccounts,availableComputeAccounts,resolveProviderAccount,resolveComputeAccount,isOwnerPrincipal,providerTools} from './provider-accounts.mjs';

const owner={id:'owner',authMethod:'shared'};
const oauthOwner={id:'oauth-owner',authMethod:'jwt'};
const outsider={id:'outsider',authMethod:'jwt'};
const env={
  MCP_SHARED_SUBJECT:'owner',MCP_SHARED_TOKEN_SHA256:'test-digest',
  MCP_ATAX_OWNER_JWT_SUBJECT:'oauth-owner',
  GH_KEY_PERSONAL:'github-personal-test', GH_KEY_WORK:'github-work-test', FRNES_KEY_fly__DEV:'fly-dev-test',
  CF_KEY_PERSONAL:'cloudflare-personal-test', CF_KEY_WORK:'cloudflare-work-test',
  CLOUDFLARE_ACCOUNT_ID_WORK:'abc12345',
};
const find=name=>providerTools.find(x=>x.name===name);
const invoke=(name,args,principal=owner,config=env,fetcher=async()=>Response.json({}))=>
  find(name).invoke(args,null,principal,{env:config,fetcher});

test('single shared or pinned OAuth owner discovers named accounts; outsiders never do',async()=>{
  for(const user of [owner,oauthOwner]){
    assert.equal(isOwnerPrincipal(env,user),true);
    assert.deepEqual(availableAccounts(env,user,'github'),['PERSONAL','WORK']);
    assert.deepEqual(availableAccounts(env,user,'cloudflare'),['PERSONAL','WORK']);
  }
  assert.equal(isOwnerPrincipal(env,outsider),false);
  assert.deepEqual(availableAccounts(env,outsider,'github'),[]);
  assert.deepEqual(availableAccounts(env,outsider,'cloudflare'),[]);
  assert.deepEqual((await invoke('atax_provider_accounts_list',{},outsider)).accounts.map(x=>x.aliases),[[],[],undefined]);
  const listed=await invoke('atax_provider_accounts_list',{},oauthOwner);
  assert.deepEqual(listed.accounts.map(x=>x.provider),['github','cloudflare','compute']);
  assert.deepEqual(listed.accounts[2].providers,[{provider:'fly',aliases:['DEV']}]);
  assert.ok(!JSON.stringify(listed).includes('github-personal-test'));
  assert.ok(!JSON.stringify(listed).includes('cloudflare-work-test'));
  assert.ok(!providerTools.some(t=>t.name.includes('vercel')));
});

test('select exact named secret; no automatic choice with multiple accounts',()=>{
  assert.equal(resolveProviderAccount(env,owner,'github','work').token,'github-work-test');
  assert.equal(resolveProviderAccount(env,oauthOwner,'github','PERSONAL').token,'github-personal-test');
  assert.throws(()=>resolveProviderAccount(env,owner,'github'),/Specify an account alias/);
  assert.throws(()=>resolveProviderAccount(env,owner,'github','../WORK'),/Invalid account/);
  assert.throws(()=>resolveProviderAccount(env,outsider,'github','WORK'),/not authorized/);
  assert.throws(()=>resolveProviderAccount(env,{id:'owner',authMethod:'jwt'},'github','PERSONAL'),/not authorized/);
  assert.throws(()=>resolveProviderAccount(env,owner,'github','MISSING'),/not authorized/);
});

test('one secret works without account; old named prefixes migrate safely',()=>{
  const single={...env,GH_KEY_WORK:undefined,CF_KEY_WORK:undefined};
  assert.equal(resolveProviderAccount(single,owner,'github').alias,'PERSONAL');
  assert.equal(resolveProviderAccount(single,owner,'cloudflare').alias,'PERSONAL');
  const old={...env,GH_KEY_PERSONAL:undefined,GH_KEY_WORK:undefined,GH_TOKEN_OLD:'older-github-test',
    CF_KEY_PERSONAL:undefined,CF_KEY_WORK:undefined,CLOUDFLARE_TOKEN_OLD:'older-cloudflare-test'};
  assert.deepEqual(availableAccounts(old,owner,'github'),['OLD']);
  assert.equal(resolveProviderAccount(old,owner,'github').token,'older-github-test');
  assert.deepEqual(availableAccounts(old,oauthOwner,'cloudflare'),['OLD']);
  assert.throws(()=>resolveProviderAccount({...env,GH_TOKEN_WORK:'ambiguous'},owner,'github','WORK'),/Duplicate/);
});

test('Cloudflare provider calls use only requested credential; redact upstream extras',async()=>{
  const requests=[];
  const fetcher=async(url,options)=>{
    requests.push({url,options});
    if(url.includes('/builds/workers/'))return Response.json({success:true,result:[{build_uuid:'856f46e5-bac5-4733-ba7f-9362b70f778e',status:'stopped',build_outcome:'fail',build_trigger_metadata:{branch:'main',commit_hash:'301de643'},created_on:'2026-11-26T16:59:45Z',stopped_on:'2026-11-26T17:00:41Z',secret:'DO_NOT_RETURN'}]});
    if(url.includes('/builds/builds/'))return Response.json({success:true,result:{lines:['step 1 ok','ERR_PNPM_OUTDATED_LOCKFILE']}});
    if(url.includes('/workers/scripts'))return Response.json({success:true,result:[{id:'app',tag:'tag-app-123',modified_on:'2026-11-22',secret:'DO_NOT_RETURN'}]});
    return Response.json({success:true,result:[{id:'abc12345',name:'Account',secret:'DO_NOT_RETURN'}]});
  };
  const accounts=await invoke('atax_cloudflare_accounts_list',{account:'WORK'},oauthOwner,env,fetcher);
  const scripts=await invoke('atax_cloudflare_workers_list',{account:'WORK'},oauthOwner,env,fetcher);
  const builds=await invoke('atax_cloudflare_worker_builds_list',{account:'WORK',script_id:'app'},oauthOwner,env,fetcher);
  const logs=await invoke('atax_cloudflare_build_logs_get',{account:'WORK',build_uuid:'856f46e5-bac5-4733-ba7f-9362b70f778e',tail_lines:10},oauthOwner,env,fetcher);
  assert.equal(accounts.accounts[0].id,'abc12345');
  assert.equal(scripts.scripts[0].id,'app');
  assert.equal(scripts.scripts[0].tag,'tag-app-123');
  assert.equal(builds.worker_tag,'tag-app-123');
  assert.equal(builds.builds[0].build_outcome,'fail');
  assert.deepEqual(logs.lines,['step 1 ok','ERR_PNPM_OUTDATED_LOCKFILE']);
  assert.ok(requests.every(x=>x.options.headers.authorization==='Bearer cloudflare-work-test'));
  assert.ok(!JSON.stringify({accounts,scripts,builds,logs}).includes('DO_NOT_RETURN'));
  await assert.rejects(invoke('atax_cloudflare_workers_list',{account:'WORK',account_id:'wrong'},owner,env,fetcher),/differs/);
  await assert.rejects(invoke('atax_cloudflare_accounts_list',{account:'WORK'},outsider,env,fetcher),/not authorized/);
});

test('bad configuration, API failures and empty credentials fail closed',async()=>{
  assert.deepEqual(availableAccounts({...env,GH_KEY_BAD:''},owner,'github'),['PERSONAL','WORK']);
  assert.deepEqual(availableAccounts({...env,MCP_ATAX_OWNER_JWT_SUBJECT:''},oauthOwner,'github'),[]);
  await assert.rejects(invoke('atax_cloudflare_accounts_list',{account:'WORK'},owner,env,async()=>Response.json({}, {status:403})),/HTTP 403/);
  await assert.rejects(invoke('atax_cloudflare_accounts_list',{account:'WORK'},owner,env,async()=>new Response('invalid')),/invalid JSON/);
  await assert.rejects(invoke('atax_cloudflare_workers_list',{account:'PERSONAL'},owner,env),/account ID required/);
  assert.throws(()=>availableAccounts(env,owner,'vercel'),/Unknown provider/);
});

test('compute account resolution is owner-scoped and requires explicit alias when ambiguous',()=>{
  assert.deepEqual(availableComputeAccounts(env,owner,'fly'),['DEV']);
  assert.equal(resolveComputeAccount(env,owner,'fly','dev').token,'fly-dev-test');
  assert.throws(()=>resolveComputeAccount({...env,FRNES_KEY_fly__WORK:'fly-work-test'},owner,'fly'),/Specify a compute account alias/);
  assert.throws(()=>resolveComputeAccount(env,outsider,'fly','DEV'),/not authorized/);
});
