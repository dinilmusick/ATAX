import {test} from 'node:test';import assert from 'node:assert/strict';import {computeTools} from './compute-tools.mjs';
test('ATAX exposes FRNES compute capability and lifecycle tools',()=>{assert.deepEqual(computeTools.map(x=>x.name),['atax_compute_capabilities','atax_compute_execute','atax_compute_status','atax_compute_destroy']);assert.equal(computeTools.every(x=>x.inputSchema.additionalProperties===false),true);});
test('ATAX compute adapter rejects missing FRNES gateway configuration',async()=>{await assert.rejects(computeTools[0].invoke({workspaceId:'ws'},null,{id:'owner'},{env:{},fetcher:fetch}),/FRNES compute gateway is not configured/);});
test('ATAX compute adapter never accepts non-HTTPS FRNES endpoints',async()=>{await assert.rejects(computeTools[0].invoke({workspaceId:'ws'},null,{id:'owner'},{env:{FRNES_URL:'http://bad',FRNES_SERVICE_TOKEN:'1234567890123456'},fetcher:fetch}),/FRNES compute gateway is not configured/);});

test('ATAX compute status resolves the selected provider account privately',async()=>{
 const requests=[];
 const fetcher=async(url,options)=>{requests.push({url,options});return Response.json({success:true,status:'ok'});};
 const env={FRNES_URL:'https://frnes.example',FRNES_SERVICE_TOKEN:'12345678901234567890',FRNES_KEY_fly__DEV:'fly-secret-value',MCP_SHARED_SUBJECT:'owner',MCP_SHARED_TOKEN_SHA256:'test-hash'};
 const result=await computeTools.find(x=>x.name==='atax_compute_status').invoke({workspaceId:'ws',environmentId:'fly/DEV/app/machine',account:{providerId:'fly',alias:'DEV'}},null,{id:'owner',authMethod:'shared'},{env,fetcher});
 assert.equal(result.status,'ok'); assert.equal(requests.length,1);
 const body=JSON.parse(requests[0].options.body); assert.equal(body.accounts[0].token,'fly-secret-value');
});
