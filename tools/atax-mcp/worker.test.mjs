import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createHandler as createRuntimeHandler} from './worker.mjs';

const token='test-operator-token-1234567890';
const tokenSha=createHash('sha256').update(token).digest('hex');
const env={
  SUPABASE_URL:'https://vcaerawuwffziufvpbvw.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY:'dummy-service-role-jwt',
  MCP_SHARED_TOKEN_SHA256:tokenSha,
  MCP_SHARED_SUBJECT:'test-external-agent',
  MCP_SHARED_SCOPES:'atax:read atax:write atax:verify',
  MCP_ALLOWED_ORIGINS:'https://client.example',
};
const requests=[];
const upstream=async (url, options={})=>{
  requests.push({url,options});
  if(url.includes('/rpc/'))return Response.json({rpc:url.split('/').at(-1),params:JSON.parse(options.body||'{}')});
  if(url.includes('/skill_versions?'))return Response.json([{version:'2.0',instructions:'Canonical skill instructions',is_published:true}]);
  if(url.includes('/skills?'))return Response.json([{id:17,slug:'coding-router',name:'Coding Router',status:'active',current_version_id:'version-test'}]);
  throw Error('Unexpected upstream '+url);
};
// In-memory REST fixture for historical MCP protocol tests only.
function testLedger(fetcher){
  const request=async (path,method='GET',body)=>{
    const res=await fetcher('https://project.supabase.co/rest/v1/'+path,{
      method,headers:{apikey:'synthetic-unit-test',accept:'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    return res.json();
  };
  return {
    rpc:(name,params)=>request('rpc/'+name,'POST',params),
    skills:query=>request('skills?select=id,name,slug,description,status,current_version_id&status=eq.active&or=(slug.ilike.*'+encodeURIComponent(String(query))+'*,name.ilike.*'+encodeURIComponent(String(query))+'*)&limit=30'),
    skill:async slug=>{
      const records=await request('skills?select=id,name,slug,status,current_version_id&slug=eq.'+encodeURIComponent(slug)+'&limit=1');
      if(!records.length)throw Error('Skill unavailable');
      const versions=await request('skill_versions?select=version,instructions,is_published&id=eq.'+encodeURIComponent(records[0].current_version_id)+'&limit=1');
      return {...records[0],...versions[0]};
    },
    request
  };
}
function createHandler(fetcher){
  return createRuntimeHandler(fetcher,async env=>({...env,__ledgerDb:testLedger(fetcher)}));
}
const handler=createHandler(upstream);
function post(method,params={},config={}){
  const body=JSON.stringify(config.body||{jsonrpc:'2.0',id:config.id??1,method,params});
  return handler(new Request('https://atax.example/mcp', {method:'POST',headers:{'Content-Type':'application/json',...(config.auth===false?{}:{Authorization:'Bearer '+token}),...(config.headers||{})},body}),config.env||env);
}
async function call(name,args={},config={}){const res=await post('tools/call',{name,arguments:args},config);return {status:res.status,payload:await res.json()};}

test('health, route and configuration fail closed',async()=>{
  const healthRes=await handler(new Request('https://atax.example/health'),{});
  assert.equal(healthRes.status,200);
  const healthData=await healthRes.json();
  assert.equal(healthData.service,'atax-mcp');
  assert.equal(healthData.status,'ok');
  assert.equal(healthData.databaseTransport,'supabase-data-api');
  assert.equal((await handler(new Request('https://atax.example/private'),env)).status,404);
  const production=createRuntimeHandler(upstream);
  const missing=new Request('https://atax.example/mcp',{
    method:'POST',headers:{'content-type':'application/json'},body:'{}'
  });
  assert.equal((await production(missing,{})).status,503);
});
test('reject missing and invalid bearer, origin, wrong content-type and request size',async()=>{
  assert.equal((await post('initialize',{}, {auth:false})).status,401);
  assert.equal((await post('initialize',{}, {headers:{Authorization:'Bearer invalid-token-123456789'}})).status,401);
  assert.equal((await post('initialize',{}, {headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await post('initialize',{}, {headers:{Origin:'https://client.example'}})).status,200);
  assert.equal((await handler(new Request('https://atax.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'},body:'{}'}),env)).status,415);
  assert.equal((await post('ping',{}, {headers:{'Content-Length':'2000000'}})).status,413);
});
test('MCP initialize, protocol negotiation, ping and stateless GET contract',async()=>{
  const res=await post('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'probe',version:'1'}});
  assert.equal(res.status,200);const b=await res.json();
  assert.equal(b.result.protocolVersion,'2025-06-18');
  assert.equal(b.result.serverInfo.name,'atax-mcp');
  assert.ok(b.result.capabilities.tools);
  assert.ok(b.result.capabilities.resources);
  assert.equal((await post('ping')).status,200);
  assert.equal((await handler(new Request('https://atax.example/mcp',{headers:{Authorization:'Bearer '+token}}),env)).status,405);
});
test('tools: list includes access-controlled read and lifecycle tools',async()=>{
  const res=await post('tools/list'); const payload=await res.json();
  const names=payload.result.tools.map(t=>t.name);
  for(const name of ['atax_context','atax_skill_get','atax_task_claim_next','atax_task_heartbeat','atax_task_record_checkpoint_predicate','atax_task_suitability','atax_task_submit','atax_verification_claim','atax_verification_submit'])assert.ok(names.includes(name),name);
  const reduced={...env,MCP_SHARED_SCOPES:'atax:read'};
  const filtered=await(await post('tools/list',{}, {env:reduced})).json();
  const reducedNames=filtered.result.tools.map(t=>t.name);
  assert.ok(reducedNames.includes('atax_task_suitability'),'read-only suitability remains available');
  for(const mutation of [
    'atax_task_claim_next','atax_task_heartbeat','atax_task_record_loop',
    'atax_task_record_checkpoint_predicate','atax_task_submit','atax_task_release',
    'atax_verification_claim','atax_verification_submit'
  ]) assert.ok(!reducedNames.includes(mutation),`write/verify tool leaked to read-only principal: ${mutation}`);
  assert.equal((await call('atax_task_claim_next',{}, {env:reduced})).payload.result.isError,true);
  const advisory=await call('atax_task_suitability',{task_id:'f5c29f36-27ba-4d6e-a6b2-a3c6757668c9'}, {env:reduced});
  assert.notEqual(advisory.payload.result.isError,true);
});
test('canonical read invokes real named Supabase RPC and skills REST, not arbitrary SQL',async()=>{
  const before=requests.length;
  const c=await call('atax_context');assert.equal(c.status,200);
  const p=c.payload.result.structuredContent.result;
  assert.equal(p.rpc,'agent_context_overview');
  const g=await call('atax_goal_get',{goal_key:'some-goal'});
  assert.deepEqual(g.payload.result.structuredContent.result.params,{goal_key_in:'some-goal'});
  const s=await call('atax_skill_get',{slug:'coding-router'});
  assert.equal(s.payload.result.structuredContent.result.instructions,'Canonical skill instructions');
  assert.ok(requests.length>before);
  const unknown=await call('execute_sql',{query:'DROP TABLE tasks'});
  assert.equal(unknown.payload.result.isError,true);
  assert.equal((await call('atax_context',{bogus:5})).payload.result.isError,true);
});
test('atomic claims, heartbeat and result carry verified caller ID and claim token',async()=>{
  const c=await call('atax_task_claim_next',{lease_seconds:300,capabilities:['backend']});
  assert.equal(c.payload.result.structuredContent.result.params.agent_id_in,'test-external-agent');
  assert.deepEqual(c.payload.result.structuredContent.result.params.capabilities_in,['backend']);
  // Assemble synthetic identifiers in tests rather than embedding a token-shaped literal.
  const sampleTaskId=['f5c29f36','27ba','4d6e','a6b2','a3c6757668c9'].join('-');
  const sampleClaimToken=['94a0197b','e59c','458a','99a8','d4027920f62d'].join('-');
  const h=await call('atax_task_heartbeat',{task_id:sampleTaskId,claim_token:sampleClaimToken,current_step:'Testing actual work',heartbeat_context:{next_action:'Continue'}});
  const hp=h.payload.result.structuredContent.result.params;
  assert.equal(hp.agent_id_in,'test-external-agent');assert.equal(hp.current_step_in,'Testing actual work');
  assert.equal(hp.heartbeat_context_in.next_action,'Continue');
  const predicate=await call('atax_task_record_checkpoint_predicate',{
    task_id:sampleTaskId,claim_token:sampleClaimToken,checkpoint_index:0,
    predicate_key:'builtin.evidence_present',predicate_version:1,
    inputs:{evidence:['observed']},result:true,passed:true,
    evidence:[{type:'test',receipt:'passed'}]
  });
  const pp=predicate.payload.result.structuredContent.result.params;
  assert.equal(predicate.payload.result.structuredContent.result.rpc,'record_checkpoint_predicate_result');
  assert.equal(pp.executor_id_in,'test-external-agent');
  assert.equal(pp.fencing_token_in,sampleClaimToken);
  assert.equal(pp.checkpoint_index_in,0);
  assert.equal(pp.predicate_key_in,'builtin.evidence_present');
  assert.equal(pp.passed_in,true);
  assert.deepEqual(pp.inputs_in,{evidence:['observed']});

  const result=await call('atax_task_submit',{task_id:hp.task_id_in,claim_token:hp.claim_token_in,summary:'Ready for evidence verification',evidence:[{url:'test://result'}]});
  assert.equal(result.payload.result.structuredContent.result.params.status_in,'completed');
});
test('MCP socket command uses the pinned fallback profile and exact UTF-8 wire metering',async()=>{
  const taskId='f5c29f36-27ba-4d6e-a6b2-a3c6757668c9';
  const claimToken='94a0197b-e59c-458a-99a8-d4027920f62d';
  const result=await call('atax_socket_task_status',{task_id:taskId,claim_token:claimToken});
  const command=result.payload.result.structuredContent.result.params.command_in;
  assert.equal(command.transport,'mcp');
  assert.equal(command.profileSource,'atax-mcp-pinned-fallback');
  assert.equal(command.principalId,'test-external-agent');
  assert.equal(command.sessionId,'test-external-agent');
  assert.equal(command.taskId,taskId);
  assert.equal(command.claimToken,claimToken);
  assert.equal(command.budgetProfile.modelId,'unknown');
  assert.equal(command.budgetProfile.tokenizerId,'utf8-byte-upper-bound-v1');
  assert.equal(command.budgetProfile.profileSetVersion,'2026-11-22.2');
  assert.equal(command.budgetProfile.overhead,8);
  assert.equal(command.inboundTokens,new TextEncoder().encode(command.requestWire).byteLength+8);
  assert.ok(command.budgetProfile.maxUsableTokens<=3276);
});

test('suitability routing derives caller attribution and never grants execution authority',async()=>{
  const taskId='0e579631-22b2-4d0d-8b6f-6f8e0644ed69';
  const result=await call('atax_task_suitability',{task_id:taskId,limit:7});
  const params=result.payload.result.structuredContent.result.params;
  assert.equal(result.payload.result.structuredContent.result.rpc,'atax_worker_suitability_v1');
  assert.equal(params.task_id_in,taskId);
  assert.equal(params.requested_by_actor_in,'test-external-agent');
  assert.equal(params.limit_in,7);
  assert.equal(Object.hasOwn(params,'agent_id_in'),false);
  assert.equal(Object.hasOwn(params,'claim_token_in'),false);
});

test('claim wrappers derive actor and authorized capabilities server-side',async()=>{
  const global=await call('atax_task_claim_next',{lease_seconds:60});
  const globalParams=global.payload.result.structuredContent.result.params;
  assert.equal(global.payload.result.structuredContent.result.rpc,'atax_mcp_task_claim_next_v1');
  assert.equal(globalParams.actor_id_in,'test-external-agent');
  assert.equal(globalParams.lease_seconds_in,60);
  assert.equal(Object.hasOwn(globalParams,'capabilities_in'),false);

  const goal=await call('atax_goal_claim_task',{goal_key:'test-goal',lease_seconds:90});
  const goalParams=goal.payload.result.structuredContent.result.params;
  assert.equal(goal.payload.result.structuredContent.result.rpc,'atax_mcp_goal_claim_task_v1');
  assert.equal(goalParams.actor_id_in,'test-external-agent');
  assert.equal(goalParams.goal_key_in,'test-goal');
  assert.equal(Object.hasOwn(goalParams,'capabilities_in'),false);

  const spoof=await call('atax_task_claim_next',{capabilities:['atax:admin']});
  assert.equal(spoof.payload.result.isError,true);
});

test('forfeited lease appends a handoff note and permits discovering other free sockets',async()=>{
  const task_id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const claim_token='11111111-2222-4333-8444-555555555555';
  const names=(await(await post('tools/list')).json()).result.tools.map(x=>x.name);
  assert.ok(names.includes('atax_task_handoff'));
  const note=await call('atax_task_handoff',{
    task_id,claim_token,note:'Expired claim; partial build done, remaining tests noted',
    context:{work_done:['compiled'],next_action:'handoff to successor'}
  });
  assert.equal(note.status,200);
  assert.equal(note.payload.result.structuredContent.result.rpc,'task_ledger_record_handoff');
  const args=note.payload.result.structuredContent.result.params;
  assert.equal(args.previous_agent_id_in,'test-external-agent');
  assert.equal(args.previous_claim_token_in,claim_token);
  assert.deepEqual(args.context_in.work_done,['compiled']);
  assert.equal((await call('atax_task_handoff',{task_id,claim_token})).payload.result.isError,true);
  const next=await call('atax_task_claim_next',{capabilities:['backend'],lease_seconds:120});
  assert.equal(next.payload.result.structuredContent.result.rpc,'task_ledger_claim_next');
  assert.equal(next.payload.result.structuredContent.result.params.lease_seconds_in,120);
});

test('a fenced-out caller can leave a non-mutating handoff then discover another task',async()=>{
  const listed=await(await post('tools/list')).json();
  assert.ok(listed.result.tools.some(t=>t.name==='atax_task_handoff'));
  const sampleTaskId=['f5c29f36','27ba','4d6e','a6b2','a3c6757668c9'].join('-');
  const oldFence=['94a0197b','e59c','458a','99a8','d4027920f62d'].join('-');
  const before=requests.length;
  const out=await call('atax_task_handoff',{
    task_id:sampleTaskId,claim_token:oldFence,
    note:'Lost exclusive socket; implementation done but verification remains.',
    context:{partial_result:'PR opened',evidence:['https://example.org/pr'],
      next_action:'New owner should verify changes'}
  });
  assert.equal(out.status,200);
  const result=out.payload.result.structuredContent.result;
  assert.equal(result.rpc,'task_ledger_record_handoff');
  assert.deepEqual(result.params,{
    task_id_in:sampleTaskId,previous_agent_id_in:'test-external-agent',
    previous_claim_token_in:oldFence,
    handoff_note_in:'Lost exclusive socket; implementation done but verification remains.',
    context_in:{partial_result:'PR opened',evidence:['https://example.org/pr'],
      next_action:'New owner should verify changes'}
  });
  assert.equal(requests.length,before+1,'Handoff must not attempt release/submit/renew');
  assert.equal((await call('atax_task_handoff',{task_id:sampleTaskId,note:'No old fence'})).payload.result.isError,true);
  const next=await call('atax_task_claim_next',{capabilities:[]});
  assert.equal(next.payload.result.structuredContent.result.rpc,'task_ledger_claim_next');
  assert.equal(next.payload.result.structuredContent.result.params.agent_id_in,'test-external-agent');
  const readOnly={...env,MCP_SHARED_SCOPES:'atax:read'};
  assert.equal((await call('atax_task_handoff',{task_id:sampleTaskId,claim_token:oldFence,note:'x'},{env:readOnly})).payload.result.isError,true);
});
test('verification uses its explicit scope and the same authenticated principal is permitted',async()=>{
  const readonly={...env,MCP_SHARED_SCOPES:'atax:read atax:write'};
  assert.equal((await call('atax_verification_claim',{}, {env:readonly})).payload.result.isError,true);
  const r=await call('atax_verification_submit',{task_id:'task-id',verification_claim_token:'token',verified:true,report:{evidence:[{type:'predicate','result':'passed'}]}});
  assert.equal(r.payload.result.structuredContent.result.params.verifier_agent_id_in,'test-external-agent');
  assert.equal(r.payload.result.structuredContent.result.params.verified_in,true);
});
test('resources, notifications, malformed JSON-RPC and batch requests',async()=>{
  const list=await(await post('resources/list')).json();assert.equal(list.result.resources.length,4);
  const read=await(await post('resources/read',{uri:'atax://context/overview'})).json();
  assert.equal(JSON.parse(read.result.contents[0].text).rpc,'agent_context_overview');
  const n=await post('notifications/initialized',{}, {body:{jsonrpc:'2.0',method:'notifications/initialized'}});
  assert.equal(n.status,202);
  const invalid=await(await post('ping',{}, {body:{jsonrpc:'2.0',id:1,method:'nope'}})).json();
  assert.equal(invalid.error.code,-32601);
  const batch=await(await post('ping',{}, {body:[{jsonrpc:'2.0',id:1,method:'ping'},{jsonrpc:'2.0',id:2,method:'tools/list'}]})).json();
  assert.equal(batch.length,2);
});
test('JWKS bearer validation verifies RSA signature, issuer, audience, expiry and scope',async()=>{
  const keys=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const pub=await webcrypto.subtle.exportKey('jwk',keys.publicKey);pub.kid='test-kid';pub.alg='RS256';
  const b64=v=>Buffer.from(v).toString('base64url');
  const header=b64(JSON.stringify({alg:'RS256',kid:'test-kid',typ:'at+jwt'}));
  const claims={iss:'https://auth.example',aud:'atax',sub:'test-jwks-user',azp:'test-client-registered',scope:'atax:read',exp:Math.floor(Date.now()/1000)+60};
  async function sign(override={}){const payload=b64(JSON.stringify({...claims,...override}));const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(header+'.'+payload));return header+'.'+payload+'.'+b64(signature);}
  const jwksEnv={...env,MCP_SHARED_TOKEN_SHA256:'',MCP_AUTH_JWKS_URL:'https://auth.example/jwks',MCP_AUTH_ISSUER:'https://auth.example',MCP_AUTH_AUDIENCE:'atax'};
  const remote=async(url,opts)=>url==='https://auth.example/jwks'?Response.json({keys:[pub]}):upstream(url,opts);
  const h=createHandler(remote);
  async function invoke(jwt){return h(new Request('https://atax.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}),jwksEnv);}
  assert.equal((await invoke(await sign())).status,200);
  // A trusted-scope JWT is not automatically the owner of the service-role ATAX ledger.
  const jwt=await sign();
  const scoped=await(await invoke(jwt)).json();
  const scopedNames=scoped.result.tools.map(x=>x.name);
  assert.ok(!scopedNames.includes('atax_provider_accounts_list'));
  assert.ok(!scopedNames.includes('atax_context'));
  assert.ok(!scopedNames.includes('atax_task_claim_next'));
  assert.ok(!scopedNames.includes('atax_github_repository_inspect'));
  const rpc=async(method,params={},config=jwksEnv)=>h(new Request('https://atax.example/mcp',{
    method:'POST',headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
  }),config);
  const resources=await(await rpc('resources/list')).json();
  assert.deepEqual(resources.result.resources,[]);
  const denied=await(await rpc('resources/read',{uri:'atax://context/overview'})).json();
  assert.equal(denied.error.code,-32003);
  const deniedCall=await(await rpc('tools/call',{name:'atax_context',arguments:{}})).json();
  assert.equal(deniedCall.result.isError,true);
  const prompts=await(await rpc('prompts/list')).json();
  assert.deepEqual(prompts.result.prompts,[]);
  const deniedProvider=await(await rpc('tools/call',{name:'atax_provider_accounts_list',arguments:{}})).json();
  assert.equal(deniedProvider.result.isError,true);
  const explicitOwner={...jwksEnv,MCP_ATAX_OWNER_JWT_SUBJECT:'test-jwks-user'};
  const admitted=await(await rpc('tools/list',{},explicitOwner)).json();
  assert.ok(admitted.result.tools.some(t=>t.name==='atax_context'));
  assert.ok(admitted.result.tools.some(t=>t.name==='atax_provider_accounts_list'));
  const admittedRead=await(await rpc('resources/read',{uri:'atax://context/overview'},explicitOwner)).json();
  assert.equal(JSON.parse(admittedRead.result.contents[0].text).rpc,'agent_context_overview');
  const wrongOwner={...jwksEnv,MCP_ATAX_OWNER_JWT_SUBJECT:'somebody-else'};
  const nonOwner=await(await rpc('tools/list',{},wrongOwner)).json();
  assert.ok(!nonOwner.result.tools.some(t=>t.name==='atax_context'));
  assert.equal((await invoke(await sign({aud:'wrong'}))).status,401);
  assert.equal((await invoke(await sign({exp:1}))).status,401);
  assert.equal((await invoke((await sign())+'t')).status,401);
});
test('browser CORS preflight for allowlisted origins and resource template list',async()=>{
  const req=new Request('https://atax.example/mcp',{method:'OPTIONS',headers:{Origin:'https://client.example','Access-Control-Request-Method':'POST'}});
  const res=await handler(req,env);
  assert.equal(res.status,204);
  assert.equal(res.headers.get('access-control-allow-origin'),'https://client.example');
  assert.ok(res.headers.get('access-control-allow-headers').includes('Authorization'));
  const templates=await(await post('resources/templates/list')).json();
  assert.equal(templates.result.resourceTemplates[0].uriTemplate,'atax://skills/{slug}');
});

test('governed creation, dependencies and loop contract use canonical RPCs with token identity', async()=>{
  const base={system_key:'atax',title:'Test goal',description:'Isolated fake execution',acceptance_criteria:['Checked'],goal_loop_definition:{enabled:false},task_definitions:[{name:'Unit test',actions:[{description:'Check'}]}]};
  const bounded=await call('atax_goal_create_bounded',base);
  assert.equal(bounded.payload.result.structuredContent.result.rpc,'atax_goal_create_system_bounded');
  assert.equal(bounded.payload.result.structuredContent.result.params.created_by_agent_id_in,'test-external-agent');
  assert.deepEqual(
    Object.keys(bounded.payload.result.structuredContent.result.params).sort(),
    ['system_key_in','title_in','description_in','context_in','instructions_in','acceptance_criteria_in','tags_in','goal_loop_definition_in','task_definitions_in','created_by_agent_id_in','metadata_in'].sort(),
    'bounded System RPC arguments must exactly match canonical Supabase identity signature'
  );
  const vision=await call('atax_vision_create',{title:'Test vision',description:'Example',target:{type:'system',id:'test'}});
  assert.equal(vision.payload.result.structuredContent.result.rpc,'vision_ledger_create');
  const omni=await call('atax_goal_create_omni',{...base,goal_type:'implementation',target:{type:'system',id:'test'},behavior_inputs:{},expected_outputs:{},metadata:{vision_id:'v',vision_target_id:'vt'}});
  assert.equal(omni.payload.result.structuredContent.result.rpc,'atax_goal_create_system_omni');
  assert.equal(omni.payload.result.structuredContent.result.params.created_by_agent_id_in,'test-external-agent');
  assert.deepEqual(
    Object.keys(omni.payload.result.structuredContent.result.params).sort(),
    ['system_key_in','title_in','description_in','context_in','instructions_in','acceptance_criteria_in','tags_in','goal_type_in','target_in','behavior_inputs_in','expected_outputs_in','goal_loop_definition_in','task_definitions_in','created_by_agent_id_in','metadata_in'].sort(),
    'Omni System RPC arguments must exactly match canonical Supabase identity signature'
  );
  const contract=await call('atax_task_loop_contract',{task_id:'task-test',claim_token:'claim-test',loop_definition:{enabled:true},parameter_contract:{},completion_parameters:[],checkpoints:{}});
  assert.equal(contract.payload.result.structuredContent.result.rpc,'task_ledger_finalize_loop_script');
  const claim=await call('atax_goal_claim_task',{goal_key:'test-goal'});
  assert.equal(claim.payload.result.structuredContent.result.rpc,'atax_goal_claim_safe');
  const dependent=await call('atax_goal_add_dependency',{goal_key:'a',prerequisite_goal_key:'b',dependency_type:'blocking'});
  assert.equal(dependent.payload.result.structuredContent.result.params.created_by_agent_id_in,'test-external-agent');
  const pending=await call('atax_verification_pending');
  assert.equal(pending.payload.result.structuredContent.result.rpc,'task_ledger_pending_verification');
});
test('creation schemas reject invalid task arrays, acceptance arrays and priority',async()=>{
  const empty=await call('atax_goal_create_bounded',{system_key:'atax',title:'Empty',description:'No tasks',acceptance_criteria:['One'],goal_loop_definition:{},task_definitions:[]});
  assert.equal(empty.payload.result.isError,true);
  const bad=await call('atax_goal_priority',{goal_key:'abc',priority:5});
  assert.equal(bad.payload.result.isError,true);
  const invalid=await call('atax_goal_create_bounded',{system_key:'atax',title:'Oops',description:'No acceptance',acceptance_criteria:[],goal_loop_definition:{},task_definitions:[{}]});
  assert.equal(invalid.payload.result.isError,true);
  const limited=await call('atax_goal_create_bounded',{system_key:'atax',title:'A',description:'B',acceptance_criteria:['X'],goal_loop_definition:{},task_definitions:Array.from({length:5},()=>({name:'A'}))});
  assert.equal(limited.payload.result.isError,true);
  const readonly={...env,MCP_SHARED_SCOPES:'atax:read'};
  assert.equal((await call('atax_goal_create_omni',{},{env:readonly})).payload.result.isError,true);
});

const gitEnv={...env,MCP_SHARED_SCOPES:'atax:read atax:github:read atax:github:create atax:fmrl:execute',MCP_GITHUB_OWNER:'dinilmusick',
  GH_KEY_PERSONAL:'git-create-sample-test-only'};
const fakeGitHub=(records=[])=>async(url,options={})=>{
  records.push({url,options});
  if(url==='https://api.github.com/user')return Response.json({login:'dinilmusick'});
  if(url==='https://api.github.com/user/repos' && options.method==='POST'){
    const body=JSON.parse(options.body);
    return Response.json({full_name:'dinilmusick/'+body.name,html_url:'https://github.com/dinilmusick/'+body.name,private:body.private,default_branch:'main'}, {status:201});
  }
  if(url.startsWith('https://api.github.com/repos/dinilmusick/') && !url.includes('/actions/')){
    if(url.includes('FMRL-'))return Response.json({message:'Not Found'},{status:404});
    const repo=url.split('/repos/')[1];
    return Response.json({full_name:repo,html_url:'https://github.com/'+repo,private:true,default_branch:'main'});
  }
  if(url.endsWith('/dispatches') && options.method==='POST')return new Response(null,{status:204});
  return upstream(url,options);
};
const makeGitCall=async(name,args={},config={})=>{
  const req=new Request('https://atax.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:19,method:'tools/call',params:{name,arguments:args}})});
  const res=await createHandler(config.fetcher||fakeGitHub())(req,config.env||gitEnv);
  const payload=await res.json();return payload.result;
};

test('first-class Github tools are documented discoverable, and separately scope gated',async()=>{
  const names=(await (await post('tools/list',{}, {env:gitEnv})).json()).result.tools.map(x=>x.name);
  for(const item of ['atax_github_workflows_guide','atax_github_repository_create','atax_github_repository_inspect','atax_fmrl_create_run_dispose','atax_fmrl_get_status'])assert.ok(names.includes(item),item);
  const readOnly=(await (await post('tools/list',{}, {env})).json()).result.tools.map(x=>x.name);
  assert.ok(readOnly.includes('atax_github_workflows_guide'));
  assert.ok(!readOnly.includes('atax_github_repository_create'));
  const guide=await makeGitCall('atax_github_workflows_guide',{}, {env});
  assert.ok(guide.structuredContent.result.order.some(x=>x.includes('FMRL')));
  const resources=await (await post('resources/read',{uri:'atax://guides/github-workflows'})).json();
  assert.match(resources.result.contents[0].text,/container/i);
  const prompts=await (await post('prompts/list')).json();
  assert.equal(prompts.result.prompts[0].name,'atax-github-workflow');
  const guided=await (await post('prompts/get',{name:'atax-github-workflow'})).json();
  assert.match(guided.result.messages[0].content.text,/FMRL/);
});
test('permanent GitHub repository creation uses correct API and verifies exact owner visibility',async()=>{
  const calls=[];
  const outcome=await makeGitCall('atax_github_repository_create',{name:'TestPermanent',description:'Private development'},{fetcher:fakeGitHub(calls)});
  assert.equal(outcome.structuredContent.result.repository,'dinilmusick/TestPermanent');
  assert.equal(outcome.structuredContent.result.disposable,false);
  assert.equal(outcome.structuredContent.result.verified,true);
  const creation=calls.find(x=>x.url.endsWith('/user/repos'));
  assert.equal(JSON.parse(creation.options.body).private,true);
  assert.equal(JSON.parse(creation.options.body).auto_init,true);
  assert.equal(creation.options.headers.authorization,'Bearer git-create-sample-test-only');
  assert.equal((await makeGitCall('atax_github_repository_create',{name:'FMRL-danger'})).isError,true);
  assert.equal((await makeGitCall('atax_github_repository_create',{name:'ATAX'})).isError,true);
  assert.equal((await makeGitCall('atax_github_repository_create',{name:'.git'})).isError,true);
});
test('permanent repository path never skips github-specific auth or owner validation',async()=>{
  const denied=await makeGitCall('atax_github_repository_create',{name:'Demo'},{env:{...gitEnv,MCP_SHARED_SCOPES:'atax:read atax:write'}});
  assert.equal(denied.isError,true);
  assert.equal((await makeGitCall('atax_github_repository_create',{name:'Demo'},{env:{...gitEnv,GH_KEY_PERSONAL:''}})).isError,true);
  assert.equal((await makeGitCall('atax_fmrl_create_run_dispose',{repository:'dinilmusick/Skipo',ref:'a'.repeat(40)},{env:{...gitEnv,MCP_GITHUB_OWNER:'malicious'}})).isError,true);
});
test('FMRL dispatch is controller-only, owner-scoped, pinned exact SHA, correlates without leaking tokens',async()=>{
  const calls=[]; const ref='f'.repeat(40);
  const result=await makeGitCall('atax_fmrl_create_run_dispose',{repository:'dinilmusick/Skipo',ref,event:'pull_request',workflow:'ci.yml'},{fetcher:fakeGitHub(calls)});
  assert.equal(result.isError,undefined);
  assert.equal(result.structuredContent.result.state,'dispatch_accepted_not_executed');
  assert.match(result.structuredContent.result.request_id,/^[0-9a-f-]{36}$/);
  const dispatch=calls.find(x=>x.url.endsWith('/actions/workflows/private-repo-ci.yml/dispatches'));
  const payload=JSON.parse(dispatch.options.body);
  assert.equal(payload.ref,'main');
  assert.equal(payload.inputs.ref,ref);
  assert.equal(payload.inputs.request_id,result.structuredContent.result.request_id);
  assert.equal(payload.inputs.repository,'dinilmusick/Skipo');
  assert.ok(!JSON.stringify(result).includes('git-create-sample-test-only'));
  assert.equal((await makeGitCall('atax_fmrl_create_run_dispose',{repository:'dinilmusick/ATAX',ref})).isError,true);
  assert.equal((await makeGitCall('atax_fmrl_create_run_dispose',{repository:'other-owner/Unknown',ref})).isError,true);
  assert.equal((await makeGitCall('atax_fmrl_create_run_dispose',{repository:'dinilmusick/Skipo',ref:'bad'})).isError,true);
  assert.equal((await makeGitCall('atax_fmrl_create_run_dispose',{repository:'dinilmusick/Skipo',ref,workflow:'../ci.yml'})).isError,true);
  const anyOwnerRepo=await makeGitCall('atax_fmrl_create_run_dispose',{repository:'dinilmusick/Unknown',ref});
  assert.equal(anyOwnerRepo.isError,undefined);
  assert.equal(anyOwnerRepo.structuredContent.result.state,'dispatch_accepted_not_executed');
  const repairWithoutBranch=await makeGitCall('atax_fmrl_create_run_dispose',{repository:'dinilmusick/Skipo',ref,mode:'repair'});
  assert.equal(repairWithoutBranch.isError,true);
  const repairCalls=[];
  const repair=await makeGitCall('atax_fmrl_create_run_dispose',{repository:'dinilmusick/Skipo',ref,mode:'repair',branch:'fmrl-repair'},{fetcher:fakeGitHub(repairCalls)});
  assert.equal(repair.isError,undefined);
  const repairPayload=JSON.parse(repairCalls.find(x=>x.url.endsWith('/dispatches')).options.body);
  assert.equal(repairPayload.inputs.mode,'repair');
  assert.equal(repairPayload.inputs.branch,'fmrl-repair');
});
test('FMRL status requires terminal controller and successful cleanup + anonymous independent 404',async()=>{
  const id='12e43a92-822d-4a30-82a5-5ecb9dd11acf';
  const done={id:98765,display_title:`ATAX FMRL ${id}`,status:'completed',conclusion:'success',run_attempt:2,html_url:'https://github.com/dinilmusick/ATAX/actions/runs/98765'};
  const seen=[];
  const remote=async(url,options)=>{
    seen.push({url,options});
    if(url.includes('/runs?'))return Response.json({workflow_runs:[done]});
    if(url.endsWith('/jobs?per_page=100'))return Response.json({jobs:[{steps:[{name:'Provision disposable FMRL public repository',conclusion:'success'},{name:'ALWAYS delete FMRL and verify absence',conclusion:'success'}]}]});
    if(url.endsWith('/FMRL-98765-2'))return Response.json({message:'Not Found'},{status:404});
    throw Error('Unexpected FMRL status upstream '+url);
  };
  const result=await makeGitCall('atax_fmrl_get_status',{request_id:id},{fetcher:remote});
  assert.equal(result.structuredContent.result.cleanup_verified,true);
  assert.equal(result.structuredContent.result.conclusion,'success');
  const check=seen.find(x=>x.url.endsWith('/FMRL-98765-2'));
  assert.equal(check.options.headers.authorization,undefined);
});
test('FMRL incomplete and missing cleanup cannot be misreported as successful',async()=>{
  const id='12e43a92-822d-4a30-82a5-5ecb9dd11acf';
  const noRun=async()=>Response.json({workflow_runs:[]});
  const waiting=await makeGitCall('atax_fmrl_get_status',{request_id:id},{fetcher:noRun});
  assert.equal(waiting.structuredContent.result.state,'awaiting_github_run_discovery');
  assert.equal(waiting.structuredContent.result.cleanup_verified,false);
  const broken=async(url)=>{
    if(url.includes('/runs?'))return Response.json({workflow_runs:[{id:5,display_title:`ATAX FMRL ${id}`,status:'completed',conclusion:'failure',run_attempt:1}]});
    if(url.includes('/jobs?'))return Response.json({jobs:[{steps:[{name:'Provision disposable FMRL public repository',conclusion:'success'},{name:'ALWAYS delete FMRL and verify absence',conclusion:'failure'}]}]});
    throw Error('Unexpected endpoint');
  };
  const fail=await makeGitCall('atax_fmrl_get_status',{request_id:id},{fetcher:broken});
  assert.equal(fail.structuredContent.result.cleanup_verified,false);
  assert.equal(fail.structuredContent.result.conclusion,'failure');
  assert.match(fail.structuredContent.result.next,/blocker/i);
});


test('MCP named GitHub accounts use selected token and do not use canonical owner for alternate identities',async()=>{
  const chosen={...gitEnv,GH_KEY_PERSONAL:'personal-token-value',GH_KEY_WORK:'work-token-value'};
  const seen=[];
  const remote=async(url,opts={})=>{
    seen.push({url,opts});
    if(url==='https://api.github.com/user')return Response.json({login:'other-developer'});
    if(url==='https://api.github.com/user/repos')return Response.json({
      full_name:'other-developer/newapp',html_url:'https://github.com/other-developer/newapp',private:true,default_branch:'main'
    },{status:201});
    if(url==='https://api.github.com/repos/other-developer/newapp')return Response.json({
      full_name:'other-developer/newapp',html_url:'https://github.com/other-developer/newapp',private:true,default_branch:'main'
    });
    throw Error('unexpected GitHub '+url);
  };
  const created=await makeGitCall('atax_github_repository_create',{name:'newapp',account:'WORK'},{env:chosen,fetcher:remote});
  assert.equal(created.isError,undefined);
  assert.equal(created.structuredContent.result.repository,'other-developer/newapp');
  assert.equal(created.structuredContent.result.account,'WORK');
  assert.ok(seen.every(x=>x.opts.headers.authorization==='Bearer work-token-value'));
  const denied=await makeGitCall('atax_github_repository_create',{name:'newapp'},{env:chosen,fetcher:remote});
  assert.equal(denied.isError,true);
  assert.equal(seen.length,3);
});

test('MCP exposes provider diagnostics and multi-account Neon & Vercel tools with owner scopes',async()=>{
  const cfg={...gitEnv,
    MCP_SHARED_SCOPES:gitEnv.MCP_SHARED_SCOPES+' atax:cloudflare:read atax:neon:read atax:neon:write atax:vercel:read atax:vercel:write',
    GH_KEY_WORK:'git-work-secret',
    CF_KEY_WORK:'cf-work-secret',
    NEON_KEY_PERSONAL:'neon-personal-secret-123',
    NEON_KEY_WORK:'neon-work-secret-456',
    NEON_ORG_ID_WORK:'org-work-1',
    VERCEL_KEY_PERSONAL:'vercel-personal-secret-123',
    VERCEL_KEY_WORK:'vercel-work-secret-456',
    VERCEL_TEAM_ID_WORK:'team_work_1',
  };
  const fetched=(await(await post('tools/list',{}, {env:cfg})).json()).result.tools.map(t=>t.name);
  assert.ok(fetched.includes('atax_provider_accounts_list'));
  assert.ok(fetched.includes('atax_cloudflare_accounts_list'));
  assert.ok(fetched.includes('atax_neon_projects_list'));
  assert.ok(fetched.includes('atax_neon_database_create'));
  assert.ok(fetched.includes('atax_vercel_projects_list'));
  assert.ok(fetched.includes('atax_vercel_deployment_create'));
  assert.ok(fetched.includes('atax_github_job_logs_get'));
  assert.ok(fetched.includes('atax_browser_render'));
  assert.ok(fetched.includes('atax_browser_test_dispatch'));
  assert.ok(!(await(await post('tools/list',{}, {env:gitEnv})).json()).result.tools.some(t=>t.name==='atax_cloudflare_accounts_list'));
  assert.ok(!(await(await post('tools/list',{}, {env:gitEnv})).json()).result.tools.some(t=>t.name==='atax_neon_projects_list'));
  assert.ok(!(await(await post('tools/list',{}, {env:gitEnv})).json()).result.tools.some(t=>t.name==='atax_vercel_projects_list'));
  const list=await makeGitCall('atax_provider_accounts_list',{}, {env:cfg});
  const configured=list.structuredContent.result.accounts;
  assert.deepEqual(configured.map(x=>x.provider),['github','cloudflare','neon','vercel','compute']);
  assert.deepEqual(configured.find(x=>x.provider==='cloudflare').aliases,['WORK']);
  assert.deepEqual(configured.find(x=>x.provider==='neon').aliases,['PERSONAL','WORK']);
  assert.deepEqual(configured.find(x=>x.provider==='vercel').aliases,['PERSONAL','WORK']);
  assert.equal((await makeGitCall('atax_cloudflare_accounts_list',{account:'WORK'},{env:gitEnv})).isError,true);

  const neonSeen=[];
  const neonFetcher=async(url,opts={})=>{
    neonSeen.push({url,opts});
    if(url.startsWith('https://console.neon.tech/api/v2/projects')){
      return Response.json({projects:[{id:'proj-1',name:'db-one',region_id:'aws-us-east-1',pg_version:16,org_id:'org-work-1'}]});
    }
    return upstream(url,opts);
  };
  const neonRes=await makeGitCall('atax_neon_projects_list',{account:'WORK'},{env:cfg,fetcher:neonFetcher});
  assert.equal(neonRes.isError,undefined);
  assert.equal(neonRes.structuredContent.result.account,'WORK');
  assert.equal(neonRes.structuredContent.result.org_id,'org-work-1');
  assert.equal(neonRes.structuredContent.result.projects[0].id,'proj-1');
  assert.equal(neonSeen[0].opts.headers.authorization,'Bearer neon-work-secret-456');
  assert.ok(!JSON.stringify(neonRes).includes('neon-work-secret-456'));
  const neonAmbiguous=await makeGitCall('atax_neon_projects_list',{},{env:cfg,fetcher:neonFetcher});
  assert.equal(neonAmbiguous.isError,true);

  const vercelSeen=[];
  const vercelFetcher=async(url,opts={})=>{
    vercelSeen.push({url,opts});
    if(url.startsWith('https://api.vercel.com/v10/projects')){
      return Response.json({projects:[{id:'prj_1',name:'web-app',framework:'nextjs'}]});
    }
    return upstream(url,opts);
  };
  const vercelRes=await makeGitCall('atax_vercel_projects_list',{account:'WORK'},{env:cfg,fetcher:vercelFetcher});
  assert.equal(vercelRes.isError,undefined);
  assert.equal(vercelRes.structuredContent.result.account,'WORK');
  assert.equal(vercelRes.structuredContent.result.team_id,'team_work_1');
  assert.equal(vercelRes.structuredContent.result.projects[0].name,'web-app');
  assert.equal(vercelSeen[0].opts.headers.authorization,'Bearer vercel-work-secret-456');
  assert.ok(vercelSeen[0].url.includes('teamId=team_work_1'));
  assert.ok(!JSON.stringify(vercelRes).includes('vercel-work-secret-456'));
  const vercelAmbiguous=await makeGitCall('atax_vercel_projects_list',{},{env:cfg,fetcher:vercelFetcher});
  assert.equal(vercelAmbiguous.isError,true);
});

test('GitHub job step logs and browser rendering/testing tools work and strip ANSI/secrets',async()=>{
  const cfg={...gitEnv,
    MCP_SHARED_SCOPES:gitEnv.MCP_SHARED_SCOPES+' atax:cloudflare:read',
    CF_KEY_WORK:'cf-browser-secret-1234',
    CLOUDFLARE_ACCOUNT_ID_WORK:'acct_cf_123',
  };
  const seen=[];
  const mockFetcher=async(url,opts={})=>{
    seen.push({url,opts});
    if(url==='https://api.github.com/repos/dinilmusick/ATAX/actions/jobs/555/logs'){
      return new Response(null,{status:302,headers:{location:'https://pipelines.actions.githubusercontent.com/logs/555'}});
    }
    if(url==='https://pipelines.actions.githubusercontent.com/logs/555'){
      return new Response('\x1b[31m2026-11-27T15:34:50Z FAIL test_a\x1b[0m\n2026-11-27T15:34:51Z Error: assertion failed\n');
    }
    if(url==='https://api.cloudflare.com/client/v4/accounts/acct_cf_123/browser-rendering/content'){
      return Response.json({success:true,result:'<html><body><h1>ATAX Ready</h1></body></html>'});
    }
    if(url==='https://api.github.com/repos/dinilmusick/ATAX/actions/workflows/browser-probe.yml/dispatches'){
      return new Response(null,{status:204});
    }
    return upstream(url,opts);
  };

  const logs=await makeGitCall('atax_github_job_logs_get',{repository:'dinilmusick/ATAX',job_id:555,tail_lines:10},{env:cfg,fetcher:mockFetcher});
  assert.equal(logs.isError,undefined);
  assert.equal(logs.structuredContent.result.line_count,2);
  assert.ok(logs.structuredContent.result.lines[0].includes('FAIL test_a'));
  assert.ok(!logs.structuredContent.result.lines[0].includes('\x1b[31m'));
  const redirectReq=seen.find(x=>x.url.includes('pipelines.actions'));
  assert.equal(redirectReq.opts.headers.authorization,undefined);

  const rendered=await makeGitCall('atax_browser_render',{account:'WORK',url:'https://atax.example/app',mode:'content'},{env:cfg,fetcher:mockFetcher});
  assert.equal(rendered.isError,undefined);
  assert.equal(rendered.structuredContent.result.result,'<html><body><h1>ATAX Ready</h1></body></html>');
  const badUrl=await makeGitCall('atax_browser_render',{account:'WORK',url:'http://127.0.0.1:3000'},{env:cfg,fetcher:mockFetcher});
  assert.equal(badUrl.isError,true);

  const dispatched=await makeGitCall('atax_browser_test_dispatch',{target_url:'https://atax.example/app',assert_text:'ATAX Ready'},{env:cfg,fetcher:mockFetcher});
  assert.equal(dispatched.isError,undefined);
  assert.equal(dispatched.structuredContent.result.workflow,'browser-probe.yml');
  assert.equal(dispatched.structuredContent.result.status,'dispatched');
});
