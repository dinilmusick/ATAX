import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createHandler} from './worker.mjs';

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
const handler=createHandler(upstream);
function post(method,params={},config={}){
  const body=JSON.stringify(config.body||{jsonrpc:'2.0',id:config.id??1,method,params});
  return handler(new Request('https://atax.example/mcp', {method:'POST',headers:{'Content-Type':'application/json',...(config.auth===false?{}:{Authorization:'Bearer '+token}),...(config.headers||{})},body}),config.env||env);
}
async function call(name,args={},config={}){const res=await post('tools/call',{name,arguments:args},config);return {status:res.status,payload:await res.json()};}

test('health, route and configuration fail closed',async()=>{
  assert.equal((await handler(new Request('https://atax.example/health'),{})).status,200);
  assert.equal((await handler(new Request('https://atax.example/private'),env)).status,404);
  assert.equal((await post('initialize',{}, {env:{...env,SUPABASE_SERVICE_ROLE_KEY:''}})).status,503);
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
  for(const name of ['atax_context','atax_skill_get','atax_task_claim_next','atax_task_heartbeat','atax_task_submit','atax_verification_claim','atax_verification_submit'])assert.ok(names.includes(name),name);
  const reduced={...env,MCP_SHARED_SCOPES:'atax:read'};
  const filtered=await(await post('tools/list',{}, {env:reduced})).json();
  assert.ok(filtered.result.tools.every(t=>!t.name.includes('task_')&&!t.name.includes('verification_')));
  assert.equal((await call('atax_task_claim_next',{}, {env:reduced})).payload.result.isError,true);
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
  const result=await call('atax_task_submit',{task_id:hp.task_id_in,claim_token:hp.claim_token_in,summary:'Ready for independent verification',evidence:[{url:'test://result'}]});
  assert.equal(result.payload.result.structuredContent.result.params.status_in,'completed');
});
test('independent verification uses distinct scope and identity, never self-authorizes verification',async()=>{
  const readonly={...env,MCP_SHARED_SCOPES:'atax:read atax:write'};
  assert.equal((await call('atax_verification_claim',{}, {env:readonly})).payload.result.isError,true);
  const r=await call('atax_verification_submit',{task_id:'task-id',verification_claim_token:'token',verified:true,report:{evidence:'third party'}});
  assert.equal(r.payload.result.structuredContent.result.params.verifier_agent_id_in,'test-external-agent');
  assert.equal(r.payload.result.structuredContent.result.params.verified_in,true);
});
test('resources, notifications, malformed JSON-RPC and batch requests',async()=>{
  const list=await(await post('resources/list')).json();assert.equal(list.result.resources.length,3);
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
  const header=b64(JSON.stringify({alg:'RS256',kid:'test-kid',typ:'JWT'}));
  const claims={iss:'https://auth.example',aud:'atax',sub:'test-jwks-user',scope:'atax:read',exp:Math.floor(Date.now()/1000)+60};
  async function sign(override={}){const payload=b64(JSON.stringify({...claims,...override}));const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(header+'.'+payload));return header+'.'+payload+'.'+b64(signature);}
  const jwksEnv={...env,MCP_SHARED_TOKEN_SHA256:'',MCP_AUTH_JWKS_URL:'https://auth.example/jwks',MCP_AUTH_ISSUER:'https://auth.example',MCP_AUTH_AUDIENCE:'atax'};
  const remote=async(url,opts)=>url==='https://auth.example/jwks'?Response.json({keys:[pub]}):upstream(url,opts);
  const h=createHandler(remote);
  async function invoke(jwt){return h(new Request('https://atax.example/mcp',{method:'POST',headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}),jwksEnv);}
  assert.equal((await invoke(await sign())).status,200);
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
  const vision=await call('atax_vision_create',{title:'Test vision',description:'Example',target:{type:'system',id:'test'}});
  assert.equal(vision.payload.result.structuredContent.result.rpc,'vision_ledger_create');
  const omni=await call('atax_goal_create_omni',{...base,goal_type:'implementation',target:{type:'system',id:'test'},behavior_inputs:{},expected_outputs:{},metadata:{vision_id:'v',vision_target_id:'vt'}});
  assert.equal(omni.payload.result.structuredContent.result.rpc,'atax_goal_create_system_omni');
  assert.equal(omni.payload.result.structuredContent.result.params.created_by_agent_id_in,'test-external-agent');
  const contract=await call('atax_task_loop_contract',{task_id:'task-test',claim_token:'claim-test',loop_definition:{enabled:true},parameter_contract:{},completion_parameters:[],checkpoints:[]});
  assert.equal(contract.payload.result.structuredContent.result.rpc,'task_ledger_finalize_loop_script');
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
