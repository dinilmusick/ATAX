import test from 'node:test';
import assert from 'node:assert/strict';
import {routeRpc, TOOLS} from './worker.mjs';

function harness(){
  const calls=[];
  const db={
    async rpc(name,args){
      calls.push({name,args});
      if(name==='agent_context_overview') return {systems:[],goals:[],tasks:[]};
      if(name==='atax_mcp_preemptive_guidance_get_v1') return {version:1,nextSteps:[]};
      if(name==='atax_mcp_preemptive_guidance_update_v1') return {updated:true};
      return {ok:true};
    },
    async request(){return []},
    async skills(){return []},
    async skill(){return {}},
  };
  const principal={id:'owner',authMethod:'jwt',scopes:new Set(['atax:read','atax:write','atax:verify','atax:github:read','atax:github:create','atax:fmrl:execute'])};
  const env={__ledgerDb:db,MCP_ATAX_OWNER_JWT_SUBJECT:'owner',MCP_AUTH_OWNER_SCOPES:'atax:read atax:write atax:verify atax:github:read atax:github:create atax:fmrl:execute'};
  return {db,calls,principal,env};
}

test('initialize advertises strategy-first orientation and on-demand guidance', async()=>{
  const h=harness();
  const response=await routeRpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}},h.principal,h.env,fetch);
  assert.match(response.result.instructions,/System → Vision → Target → Goal → Task/);
  assert.match(response.result.instructions,/atax_preemptive_guidance_get/);
  assert.match(response.result.instructions,/FMRL/);
});

test('intro documentation is available as an explicit tool without being injected into normal actions', async()=>{
  const h=harness();
  assert.ok(TOOLS.some(t=>t.name==='atax_intro_documentation'));
  const response=await routeRpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'atax_intro_documentation',arguments:{}}},h.principal,h.env,fetch);
  const text=response.result.content[0].text;
  assert.match(text,/ATAX is the durable strategic substrate/);
  assert.equal(h.calls.filter(x=>x.name==='atax_mcp_preemptive_guidance_update_v1').length,0);
});

test('ordinary tool calls update guidance state but return only a compact retrieval hint', async()=>{
  const h=harness();
  const response=await routeRpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'atax_context',arguments:{}}},h.principal,h.env,fetch);
  assert.equal(response.result.structuredContent.guidance.retrieval_tool,'atax_preemptive_guidance_get');
  assert.equal(h.calls.filter(x=>x.name==='atax_mcp_preemptive_guidance_update_v1').length,1);
  assert.equal(response.result.content[0].text,'{"systems":[],"goals":[],"tasks":[]}');
});

test('preemptive guidance is explicitly retrievable', async()=>{
  const h=harness();
  const response=await routeRpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'atax_preemptive_guidance_get',arguments:{}}},h.principal,h.env,fetch);
  assert.deepEqual(response.result.structuredContent.result,{version:1,nextSteps:[]});
});

test('intro and guidance resources are discoverable', async()=>{
  const h=harness();
  const list=await routeRpc({jsonrpc:'2.0',id:5,method:'resources/list',params:{}},h.principal,h.env,fetch);
  assert.ok(list.result.resources.some(r=>r.uri==='atax://documentation/intro'));
  assert.ok(list.result.resources.some(r=>r.uri==='atax://guidance/preemptive'));
});
