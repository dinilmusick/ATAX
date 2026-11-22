import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createSocketGateway,SOCKET_TOOLS} from './socket-gateway.mjs';
import {verifySocketJwt,createSocketWorker} from './socket-worker.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const TASK='11111111-1111-4111-8111-111111111111';
const OTHER='33333333-3333-4333-8333-333333333333';
const FENCE='22222222-2222-4222-8222-222222222222';
const BASE={task_id:TASK,claim_token:FENCE};
const encoder=new TextEncoder();
let nextId=1;
function makeFake(options={}){
  const state={
    owner:'agent-C',session:'socket-C',taskId:TASK,claimToken:FENCE,
    active:true,expired:false,stop:false,atomisation:false,leaseReleased:false,
    input:0,output:0,pulls:0,outputs:[],intents:[],
    permissions:new Set([
      'socket:context:read','socket:output:submit','socket:atomise:request',
      'socket:workflow:request','socket:task:status'
    ]),
    ...options,
    session:'socket-C' // canonical claim session stays fixed; option alters only signed caller
  };
  const meter={count:text=>encoder.encode(text).length};
  let queue=Promise.resolve();
  const database={executeAtomically(command){
    const run=async ()=>{
      const deny=code=>({status:'denied',code});
      if(command.principalId!==state.owner||command.sessionId!==state.session)return deny('UNAUTHORIZED');
      if(command.taskId!==state.taskId)return deny('CROSS_TASK_DENIED');
      if(command.claimToken!==state.claimToken)return deny('STALE_FENCE');
      if(state.expired)return deny('LEASE_EXPIRED');
      if(!state.active||state.stop)return deny('ATOMISATION_REQUIRED');
      if(!state.permissions.has(command.capability))return deny('CAPABILITY_REVOKED');
      state.input+=command.inboundTokens;
      const exhausted=()=>{
        state.stop=true;state.active=false;state.atomisation=true;state.leaseReleased=true;
        return deny('BUDGET_EXHAUSTED');
      };
      if(state.input>(options.inputMax??100000))return exhausted();
      if(command.rejectReason)return deny(command.rejectReason);
      let data;
      switch(command.operation){
        case 'context_pull':
          state.pulls++;
          data={items:[{kind:'evidence',body:state.contextText??'bounded evidence'}],
            next_cursor:null,request_number:state.pulls};
          break;
        case 'output_submit':
          data={accepted:true,partial:command.payload.partial??false};
          break;
        case 'atomisation_request':
          data={requested:true,task_id:state.taskId};
          break;
        case 'workflow_request':
          data={intent_created:true,workflow_key:command.payload.workflow_key};
          break;
        case 'task_status':
          data={status:'running',task_id:TASK};
          break;
        default:throw Error('Unknown operation');
      }
      const frame=JSON.stringify({jsonrpc:'2.0',id:command.replyId,
        result:{content:[{type:'text',text:JSON.stringify(data)}]}});
      const charge=meter.count(frame);
      if(state.output+charge>(options.outputMax??100000))return exhausted();
      state.output+=charge;
      if(command.operation==='output_submit')state.outputs.push(command.payload.output);
      if(command.operation==='workflow_request')state.intents.push(command.payload);
      if(command.operation==='atomisation_request'){
        state.stop=true;state.active=false;state.atomisation=true;state.leaseReleased=true;
      }
      return {status:'ok',data,receipt:{inputTokens:command.inboundTokens,outputTokens:charge}};
    };
    const job=queue.then(run);queue=job.catch(()=>{});
    return job;
  }};
  const gateway=createSocketGateway({
    verifyPrincipal:request=>{
      if(request.headers.get('authorization')!=='Bearer socket-valid')return null;
      return {id:options.principal??'agent-C',sessionId:options.session??'socket-C',
        taskId:options.signedTask??TASK};
    },
    database,meter,
    githubDispatch:{resolveWorkflow:key=>key==='safe_ci'?
      {key,inputNames:['revision','target_id']}:null}
  });
  return {gateway,state,database,meter};
}
async function call(gateway,name,args=BASE,{auth='Bearer socket-valid',origin}={}){
  const msg={jsonrpc:'2.0',id:nextId++,method:'tools/call',
    params:{name,arguments:args}};
  const headers={'content-type':'application/json',authorization:auth};
  if(origin)headers.origin=origin;
  const response=await gateway.fetch(new Request('https://restricted.example/mcp',{
    method:'POST',headers,body:JSON.stringify(msg)
  }));
  return {status:response.status,payload:await response.json()};
}
async function rpc(gateway,method){
  const response=await gateway.fetch(new Request('https://restricted.example/mcp',{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer socket-valid'},
    body:JSON.stringify({jsonrpc:'2.0',id:nextId++,method,params:{}})
  }));
  return response.json();
}
function reason(response){return response.payload?.error?.data?.code;}
function good(response){assert.equal(response.status,200);assert.ok(response.payload.result);return JSON.parse(response.payload.result.content[0].text);}
const PULL='atax_socket_context_pull';
const PUSH='atax_socket_output_submit';
const STATUS='atax_socket_task_status';
const WORKFLOW='atax_socket_workflow_request';
const ATOMISE='atax_socket_atomisation_request';

test('tool discovery is a five-operation allowlist without maintainer or external tools',async()=>{
  const {gateway}=makeFake();
  assert.equal(SOCKET_TOOLS.length,5);
  const list=await rpc(gateway,'tools/list');
  assert.deepEqual(list.result.tools.map(x=>x.name),[PULL,PUSH,ATOMISE,WORKFLOW,STATUS]);
  const resources=await rpc(gateway,'resources/list');
  assert.deepEqual(resources.result.resources,[]);
  const prompts=await rpc(gateway,'prompts/list');
  assert.deepEqual(prompts.result.prompts,[]);
  for(const name of ['atax_github_repository_create','atax_task_claim_next',
    'atax_fmrl_create_run_dispose','supabase_execute_sql','filesystem_write',
    'network_fetch','atax_context']){
    const answer=await call(gateway,name);
    assert.equal(reason(answer),'TOOL_FORBIDDEN');
  }
  assert.equal((await rpc(gateway,'unknown/method')).error.data.code,'TOOL_FORBIDDEN');
});
test('no anonymous access, no origin and no extra provider-facing request fields',async()=>{
  const {gateway,state}=makeFake();
  assert.equal((await call(gateway,STATUS,BASE,{auth:'Bearer invalid'})).status,401);
  assert.equal((await call(gateway,STATUS,BASE,{origin:'https://malicious.invalid'})).status,403);
  assert.equal(reason(await call(gateway,PULL,{...BASE,repository:'owner/repo'})),'INVALID_ARGUMENTS');
  assert.equal(reason(await call(gateway,PUSH,{...BASE,output:{ok:true},api_url:'https://example.org'})),'INVALID_ARGUMENTS');
  assert.equal(reason(await call(gateway,PULL,{...BASE,limit:1000000})),'INVALID_ARGUMENTS');
  assert.equal(state.input,0);
});
test('signed task identity, canonical owner and session all independently constrain requests',async()=>{
  const signed=makeFake({signedTask:OTHER});
  assert.equal(reason(await call(signed.gateway,STATUS,BASE)),'CROSS_TASK_DENIED');
  const otherTask=makeFake();
  assert.equal(reason(await call(otherTask.gateway,STATUS,{...BASE,task_id:OTHER})),'CROSS_TASK_DENIED');
  const otherPrincipal=makeFake({principal:'agent-other'});
  assert.equal(reason(await call(otherPrincipal.gateway,STATUS)),'UNAUTHORIZED');
  const otherSession=makeFake({session:'socket-other'});
  assert.equal(reason(await call(otherSession.gateway,STATUS)),'UNAUTHORIZED');
});
test('stale fencing and expired claims fail closed',async()=>{
  const {gateway}=makeFake();
  assert.equal(reason(await call(gateway,PULL,{...BASE,claim_token:OTHER})),'STALE_FENCE');
  const expired=makeFake({expired:true});
  assert.equal(reason(await call(expired.gateway,PUSH,{...BASE,output:{foo:'x'}})),'LEASE_EXPIRED');
});
test('revoked capabilities denied for every operation including status',async()=>{
  const {gateway,state}=makeFake();
  state.permissions.delete('socket:context:read');
  assert.equal(reason(await call(gateway,PULL)),'CAPABILITY_REVOKED');
  state.permissions.delete('socket:task:status');
  assert.equal(reason(await call(gateway,STATUS)),'CAPABILITY_REVOKED');
});
test('repeated context pulls consume cumulative input and output, then stop and atomise',async()=>{
  const {gateway,state}=makeFake({inputMax:1000,outputMax:100000});
  let success=0,blocked=false;
  for(let n=0;n<12;n++){
    const response=await call(gateway,PULL,{...BASE,cursor:'repeated'});
    if(reason(response)==='BUDGET_EXHAUSTED'){blocked=true;break;}
    good(response);success++;
  }
  assert.ok(success>=1);
  assert.equal(state.pulls,success);
  assert.equal(state.stop,true);
  assert.equal(state.atomisation,true);
  assert.equal(state.leaseReleased,true);
  assert.equal(blocked,true);
  assert.equal(reason(await call(gateway,STATUS)),'ATOMISATION_REQUIRED');
});
test('cumulative outbound quota cannot be bypassed with parallel requests',async()=>{
  const {gateway,state}=makeFake({outputMax:320});
  const results=await Promise.all([
    call(gateway,STATUS),
    call(gateway,STATUS),
    call(gateway,STATUS),
    call(gateway,STATUS)
  ]);
  assert.ok(results.some(r=>reason(r)==='BUDGET_EXHAUSTED'));
  assert.equal(state.stop,true);
  assert.equal(state.leaseReleased,true);
  assert.ok(state.output<=320);
});
test('oversized submissions are rejected after a metered input transaction',async()=>{
  const {gateway,state}=makeFake();
  const large='a'.repeat(12300);
  const response=await call(gateway,PUSH,{...BASE,output:{text:large}});
  assert.equal(reason(response),'OUTPUT_TOO_LARGE');
  assert.equal(state.outputs.length,0);
  assert.ok(state.input>12300);
});
test('workflow operations allow only configured keys and input names, with no direct dispatch',async()=>{
  const {gateway,state}=makeFake();
  assert.equal(reason(await call(gateway,WORKFLOW,{...BASE,workflow_key:'run_shell',inputs:{command:'rm -rf /'}})),
    'CAPABILITY_REVOKED');
  assert.equal(reason(await call(gateway,WORKFLOW,{...BASE,workflow_key:'safe_ci',inputs:{url:'https://evil.invalid'}})),
    'CAPABILITY_REVOKED');
  good(await call(gateway,WORKFLOW,{...BASE,workflow_key:'safe_ci',inputs:{revision:'deadbeef'}}));
  assert.equal(state.intents.length,1);
  assert.deepEqual(state.intents[0].inputs,{revision:'deadbeef'});
});
test('valid output is persisted, atomisation request stops socket',async()=>{
  const {gateway,state}=makeFake();
  good(await call(gateway,PUSH,{...BASE,output:{evidence:'file:123'},partial:true}));
  assert.deepEqual(state.outputs,[{evidence:'file:123'}]);
  good(await call(gateway,ATOMISE,{...BASE,reason:'Scope too large',partial_progress:'Saved evidence'}));
  assert.equal(state.stop,true);
  assert.equal(state.atomisation,true);
  assert.equal(state.leaseReleased,true);
});
test('missing receipt or unexpected database errors fail closed; oversized response never leaks',async()=>{
  const sample=makeFake();
  sample.database.executeAtomically=async()=>({status:'ok',data:{secret:'leak'},receipt:{}});
  assert.equal(reason(await call(sample.gateway,PULL)),'FAIL_CLOSED');
  const throws=makeFake();
  throws.database.executeAtomically=async()=>{throw Error('internal SECRET_KEY');};
  const response=await call(throws.gateway,PULL);
  assert.equal(reason(response),'FAIL_CLOSED');
  assert.ok(!JSON.stringify(response).includes('SECRET_KEY'));
  const huge=makeFake({contextText:'z'.repeat(9000)});
  const leak=await call(huge.gateway,PULL);
  assert.equal(reason(leak),'OUTPUT_TOO_LARGE');
  assert.ok(!JSON.stringify(leak).includes('zzzzzz'));
  const unconfigured=createSocketGateway({});
  const unavailable=await unconfigured.fetch(new Request('https://restricted.example/mcp',{
    method:'POST',headers:{'content-type':'application/json'},
    body:'{}'
  }));
  assert.equal(unavailable.status,503);
});
test('real JWT verification binds identity, socket session and task to signed token',async()=>{
  const keys=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',
    modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const publicKey=await webcrypto.subtle.exportKey('jwk',keys.publicKey);
  const env={SOCKET_AUTH_ISSUER:'https://issuer.example',SOCKET_AUTH_JWKS_URL:'https://issuer.example/jwks',
    SOCKET_AUTH_AUDIENCE:'atax-socket',SOCKET_AUTH_CLIENT_ID:'restricted-host'};
  const b64=text=>Buffer.from(text).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const payload={iss:env.SOCKET_AUTH_ISSUER,aud:env.SOCKET_AUTH_AUDIENCE,
    azp:env.SOCKET_AUTH_CLIENT_ID,sub:'agent-C',atax_session_id:'socket-C',
    atax_task_id:TASK,iat:now,exp:now+300};
  const head=b64(JSON.stringify({typ:'at+jwt',alg:'RS256',kid:'test-key'}));
  const body=b64(JSON.stringify(payload));
  const data=head+'.'+body;
  const signature=Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,
    encoder.encode(data))).toString('base64url');
  const fetcher=async()=>new Response(JSON.stringify({keys:[{...publicKey,kid:'test-key',use:'sig',alg:'RS256'}]}),
    {status:200,headers:{'content-type':'application/json'}});
  const request=token=>new Request('https://socket.example/mcp',{
    method:'POST',headers:{authorization:'Bearer '+token}});
  assert.deepEqual(await verifySocketJwt(request(data+'.'+signature),env,fetcher),
    {id:'agent-C',sessionId:'socket-C',taskId:TASK});
  assert.equal(await verifySocketJwt(request(data+'.AAAA'),env,fetcher),null);
  assert.equal(await verifySocketJwt(request(head+'.'+b64(JSON.stringify({...payload,atax_task_id:OTHER}))+'.'+signature),env,fetcher),null);
  assert.equal(await verifySocketJwt(request(data+'.'+signature),{...env,SOCKET_AUTH_AUDIENCE:'admin'},fetcher),null);
});
test('production adapter denies absent Supabase transaction and never falls back to maintainer tools',async()=>{
  const worker=createSocketWorker({
    SOCKET_WORKFLOW_CATALOG_JSON:'{"safe_ci":["revision"]}',SUPABASE_URL:'https://example.supabase.co',
    SUPABASE_SECRET_KEY:'test-only-placeholder'
  },async()=>new Response('{}',{status:404}));
  const response=await worker.fetch(new Request('https://socket.example/mcp',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})
  }));
  assert.equal(response.status,503);
});
