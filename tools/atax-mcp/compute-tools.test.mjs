import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeTools} from './compute-tools.mjs';
import {providerTools} from './provider-accounts.mjs';
import {getAccountUsage, resetAccountUsage} from './weighted-rotation.mjs';

const findCompute=(name)=>computeTools.find(x=>x.name===name);
const owner={id:'owner',authMethod:'shared'};
const baseEnv={
  FRNES_URL:'https://frnes.example',
  FRNES_SERVICE_TOKEN:'12345678901234567890',
  FRNES_COMPUTE_ACCOUNTS_JSON:JSON.stringify([
    {providerId:'fly',alias:'DEV',token:'fly-dev-secret-value'},
    {providerId:'fly',alias:'PROD',token:'fly-prod-secret-value'},
    {providerId:'render',alias:'A',token:'render-a-secret-value'},
    {providerId:'render',alias:'B',token:'render-b-secret-value'},
  ]),
  FRNES_KEY_railway__TEAM_A:'railway-a-secret-value',
  MCP_SHARED_SUBJECT:'owner',
  MCP_SHARED_TOKEN_SHA256:'test-hash',
};

test('ATAX exposes FRNES compute capability and lifecycle tools with strict schemas',()=>{
  assert.deepEqual(computeTools.map(x=>x.name),[
    'atax_compute_capabilities',
    'atax_compute_execute',
    'atax_compute_status',
    'atax_compute_destroy',
  ]);
  assert.equal(computeTools.every(x=>x.inputSchema.additionalProperties===false),true);
});

test('ATAX compute adapter rejects missing, non-HTTPS, and credential-bearing FRNES endpoints',async()=>{
  await assert.rejects(findCompute('atax_compute_capabilities').invoke({workspaceId:'ws'},null,owner,{env:{},fetcher:fetch}),/FRNES compute gateway is not configured/);
  await assert.rejects(findCompute('atax_compute_capabilities').invoke({workspaceId:'ws'},null,owner,{env:{FRNES_URL:'http://bad',FRNES_SERVICE_TOKEN:'1234567890123456'},fetcher:fetch}),/FRNES compute gateway is not configured/);
  await assert.rejects(findCompute('atax_compute_capabilities').invoke({workspaceId:'ws'},null,owner,{env:{FRNES_URL:'https://user:pass@frnes.example',FRNES_SERVICE_TOKEN:'1234567890123456'},fetcher:fetch}),/FRNES compute gateway is not configured/);
});

test('ATAX compute adapter rejects redirects and FRNES authentication failures',async()=>{
  const redirectFetch=async()=>new Response(null,{status:302,headers:{location:'https://evil.example'}});
  await assert.rejects(findCompute('atax_compute_capabilities').invoke({workspaceId:'ws'},null,owner,{env:baseEnv,fetcher:redirectFetch}),/FRNES compute redirect rejected/);
  const unauthFetch=async()=>Response.json({success:false,error:'ATAX_COMPUTE_AUTH_REQUIRED'},{status:401});
  await assert.rejects(findCompute('atax_compute_capabilities').invoke({workspaceId:'ws'},null,owner,{env:baseEnv,fetcher:unauthFetch}),/FRNES compute request rejected/);
});

test('ATAX compute execute -> status -> destroy lifecycle isolates accounts and blocks forged environmentIds',async()=>{
  resetAccountUsage();
  const requests=[];
  const fetcher=async(url,options)=>{
    requests.push({url,body:JSON.parse(options.body)});
    if(url.endsWith('/execute'))return Response.json({success:true,provider:'render',environmentId:'render/B/srv-1/job-1',status:'queued'});
    if(url.endsWith('/status'))return Response.json({success:true,provider:'render',environmentId:'render/B/srv-1/job-1',status:'completed',logs:'ok'});
    return Response.json({success:true,provider:'render',environmentId:'render/B/srv-1/job-1',status:'cancelled'});
  };
  const execRes=await findCompute('atax_compute_execute').invoke({
    workspaceId:'ws',
    repository:'dinilmusick/Frnes',
    ref:'main',
    command:'pnpm test',
    requirement:{workload:'container',serviceId:'srv-1'},
    accounts:[{providerId:'render',alias:'B'}],
  },null,owner,{env:baseEnv,fetcher});
  assert.equal(execRes.environmentId,'render/B/srv-1/job-1');
  assert.equal(requests[0].body.accounts[0].token,'render-b-secret-value');
  assert.equal(getAccountUsage('render','B').successfulCalls,1);

  // Forged environmentId belonging to render/B cannot be polled or destroyed with render/A or fly/DEV
  await assert.rejects(findCompute('atax_compute_status').invoke({
    workspaceId:'ws',
    environmentId:'render/B/srv-1/job-1',
    account:{providerId:'render',alias:'A'},
  },null,owner,{env:baseEnv,fetcher}),/does not belong to selected provider account/);
  await assert.rejects(findCompute('atax_compute_destroy').invoke({
    workspaceId:'ws',
    environmentId:'render/B/srv-1/job-1',
    account:{providerId:'fly',alias:'DEV'},
  },null,owner,{env:baseEnv,fetcher}),/does not belong to selected provider account/);

  const statusRes=await findCompute('atax_compute_status').invoke({
    workspaceId:'ws',
    environmentId:'render/B/srv-1/job-1',
    account:{providerId:'render',alias:'B'},
  },null,owner,{env:baseEnv,fetcher});
  assert.equal(statusRes.status,'completed');

  const destroyRes=await findCompute('atax_compute_destroy').invoke({
    workspaceId:'ws',
    environmentId:'render/B/srv-1/job-1',
    account:{providerId:'render',alias:'B'},
  },null,owner,{env:baseEnv,fetcher});
  assert.equal(destroyRes.status,'cancelled');
  assert.equal(requests.length,3);
  resetAccountUsage();
});

test('ATAX compute_execute discovers configured accounts when omitted and rotates by usage weight',async()=>{
  resetAccountUsage();
  const seenOrders=[];
  const fetcher=async(_url,options)=>{
    const body=JSON.parse(options.body);
    seenOrders.push(body.accounts.map(a=>`${a.providerId}:${a.alias}`));
    const first=body.accounts[0];
    return Response.json({success:true,provider:first.providerId,environmentId:`${first.providerId}/${first.alias}/app/job-1`,status:'queued'});
  };
  await findCompute('atax_compute_execute').invoke({
    workspaceId:'ws',
    repository:'dinilmusick/Frnes',
    ref:'main',
    command:'pnpm test',
    requirement:{workload:'container'},
    providerIds:['fly'],
  },null,owner,{env:baseEnv,fetcher});
  assert.equal(seenOrders[0].length,2);
  assert.ok(seenOrders[0].includes('fly:DEV'));
  assert.ok(seenOrders[0].includes('fly:PROD'));
  const totalSuccess=getAccountUsage('fly','DEV').successfulCalls+getAccountUsage('fly','PROD').successfulCalls;
  assert.equal(totalSuccess,1);
  resetAccountUsage();
});

test('ATAX compute rejects unknown provider accounts and lists multi-provider accounts without leaking tokens',async()=>{
  await assert.rejects(findCompute('atax_compute_status').invoke({
    workspaceId:'ws',
    environmentId:'unknown/DEV/x/y',
    account:{providerId:'unknown',alias:'DEV'},
  },null,owner,{env:baseEnv,fetcher:fetch}),/Compute account unavailable or not authorized/);

  const listTool=providerTools.find(x=>x.name==='atax_provider_accounts_list');
  const listed=await listTool.invoke({},null,owner,{env:baseEnv,fetcher:fetch});
  const computeEntry=listed.accounts.find(x=>x.provider==='compute');
  assert.deepEqual(computeEntry.providers,[
    {provider:'fly',aliases:['DEV','PROD']},
    {provider:'railway',aliases:['TEAM_A']},
    {provider:'render',aliases:['A','B']},
  ]);
  const serialized=JSON.stringify(listed);
  assert.equal(serialized.includes('secret-value'),false);
});
