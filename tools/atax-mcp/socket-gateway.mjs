// Restricted task-socket MCP endpoint. No maintainer tools or generic providers are imported.
const encoder = new TextEncoder();
const MAX_REQUEST = 32768;
const MAX_RESPONSE = 8192;
const MAX_SUBMISSION = 12288;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const WORKFLOW_TYPES = Object.freeze({
  sha: value => typeof value==='string' && /^[a-f0-9]{40}$/i.test(value),
  uuid: value => typeof value==='string' && UUID.test(value),
  slug: value => typeof value==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value),
  integer: value => Number.isSafeInteger(value) && value>=0 && value<=1000000,
  boolean: value => typeof value==='boolean'
});
const bytes = value => encoder.encode(value).length;

const BASE = {
  task_id: {type:'string', description:'Canonical task UUID'},
  claim_token: {type:'string', description:'Current fenced claim UUID'}
};
const DEFINITIONS = [
  {name:'atax_socket_context_pull', operation:'context_pull', capability:'socket:context:read',
   description:'Retrieve one bounded canonical context page for the claimed task; every repeated pull is charged',
   fields:{cursor:{type:'string'},limit:{type:'integer',minimum:1,maximum:16}}},
  {name:'atax_socket_output_submit', operation:'output_submit', capability:'socket:output:submit',
   description:'Persist bounded task output only; cannot edit a repository or any external resource',
   fields:{output:{type:'object'},partial:{type:'boolean'}}},
  {name:'atax_socket_atomisation_request', operation:'atomisation_request', capability:'socket:atomise:request',
   description:'Request stop and fenced atomisation with a bounded partial-progress note',
   fields:{reason:{type:'string'},partial_progress:{type:'string'}}},
  {name:'atax_socket_workflow_request', operation:'workflow_request', capability:'socket:workflow:request',
   description:'Submit a preauthorised workflow intent to the canonical transaction outbox, never arbitrary dispatch',
   fields:{workflow_key:{type:'string'},inputs:{type:'object'}}},
  {name:'atax_socket_task_status', operation:'task_status', capability:'socket:task:status',
   description:'Retrieve minimal task state and remaining quota using the same fenced and metered transaction',
   fields:{}}
];
export const SOCKET_TOOLS = Object.freeze(DEFINITIONS.map(def => ({
  name:def.name, description:def.description,
  inputSchema:{type:'object',additionalProperties:false,required:['task_id','claim_token'],
    properties:{...BASE,...def.fields}}
})));
const byName = new Map(DEFINITIONS.map(def => [def.name,def]));
const codes = Object.freeze({
  UNAUTHORIZED:-32001, CROSS_TASK_DENIED:-32002, STALE_FENCE:-32003,
  LEASE_EXPIRED:-32004, CAPABILITY_REVOKED:-32005,
  BUDGET_EXHAUSTED:-32006, OUTPUT_TOO_LARGE:-32007,
  ATOMISATION_REQUIRED:-32008, TOOL_FORBIDDEN:-32601,
  INVALID_ARGUMENTS:-32602, FAIL_CLOSED:-32099
});
const errorReply = (id,code) => ({jsonrpc:'2.0',id,error:{
  code:codes[code] ?? codes.FAIL_CLOSED,
  message:code.replaceAll('_',' ').toLowerCase(),
  data:{code,...(code==='BUDGET_EXHAUSTED'?{atomisation_required:true}:{})}
}});
const okReply = (id,result) => ({jsonrpc:'2.0',id,result});
const json = (data,status=200) => new Response(JSON.stringify(data),{
  status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'"}});
const validId = value => typeof value==='string' && UUID.test(value);
function validateArguments(args,def){
  if(!isObject(args)||!validId(args.task_id)||!validId(args.claim_token))return false;
  const accepted = new Set(['task_id','claim_token',...Object.keys(def.fields)]);
  for(const [key,value] of Object.entries(args)){
    if(!accepted.has(key))return false;
    const field=def.fields[key];if(!field)continue;
    if(field.type==='string' && (typeof value!=='string'||value.length>3072))return false;
    if(field.type==='boolean' && typeof value!=='boolean')return false;
    if(field.type==='integer' && (!Number.isInteger(value)||value<(field.minimum??0)||value>(field.maximum??16)))return false;
    if(field.type==='object' && !isObject(value))return false;
  }
  if(def.operation==='output_submit'&&!isObject(args.output))return false;
  if(def.operation==='atomisation_request'&&
      (typeof args.reason!=='string'||args.reason.length<1||args.reason.length>512||
       (args.partial_progress!==undefined&&(typeof args.partial_progress!=='string'||args.partial_progress.length>3000))))return false;
  if(def.operation==='workflow_request'&&
      (typeof args.workflow_key!=='string'||!/^[a-z][a-z0-9_-]{1,63}$/.test(args.workflow_key)||
       !isObject(args.inputs)))return false;
  return true;
}
function validateDeps(deps){
  return deps && typeof deps.verifyPrincipal==='function' &&
    typeof deps.database?.executeAtomically==='function' &&
    typeof deps.meter?.count==='function' &&
    typeof deps.githubDispatch?.resolveWorkflow==='function';
}
function tokenCount(meter,text){
  const n=meter.count(text);
  if(!Number.isSafeInteger(n)||n<1)return null;
  return n;
}
/**
 * DatabaseAdapter.executeAtomically(command) MUST perform in ONE durable transaction:
 * authenticate principal/session/task/fence, verify live lease and current capabilities,
 * consume every request, atomically reserve entire response, and on overflow stop,
 * persist partial progress, request atomisation, release the old execution fence.
 * It must return a receipt with tokens charged for both directions. No response may
 * be returned when a reservation fails. This gateway never mutates targets.
 *
 * MeterAdapter.count(text) is a trusted deterministic server-side tokenizer.
 * GitHubDispatchAdapter.resolveWorkflow(key) returns a trusted allowlisted descriptor
 * {key,inputs:{[name:string]:type}} only; actual dispatch is by an external outbox consumer.
 */
export function createSocketGateway(deps){
  const configured=validateDeps(deps);
  return {async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/health'&&request.method==='GET')return json({service:'atax-task-socket',configured});
    if(path!=='/mcp')return json({error:'Not found'},404);
    if(request.method!=='POST')return json({error:'Method not allowed'},405);
    // A socket host is non-browser, and must not expose ambient browser credentials.
    if(request.headers.has('origin'))return json({error:'Origin forbidden'},403);
    if(!configured)return json({error:'Restricted gateway unavailable'},503);
    if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      return json({error:'Unsupported media type'},415);
    if(Number(request.headers.get('content-length')||0)>MAX_REQUEST)
      return json({error:'Request too large'},413);
    let principal;
    try{principal=await deps.verifyPrincipal(request);}catch{return json({error:'Authentication unavailable'},503);}
    if(!principal||typeof principal.id!=='string'||!principal.id||
      typeof principal.sessionId!=='string'||!principal.sessionId||
      !validId(principal.taskId)||!validId(principal.claimToken))return json({error:'Unauthorized'},401);
    let raw,msg;
    try{raw=await request.text();if(bytes(raw)>MAX_REQUEST)return json({error:'Request too large'},413);
      msg=JSON.parse(raw);}catch{return json(errorReply(null,'INVALID_ARGUMENTS'),400);}
    const isNotification=isObject(msg)&&msg.jsonrpc==='2.0'&&msg.method==='notifications/initialized'&&msg.id===undefined;
    if(!isNotification&&(!isObject(msg)||msg.jsonrpc!=='2.0'||
      (typeof msg.id!=='number'&&typeof msg.id!=='string')||
      typeof msg.method!=='string'))return json(errorReply(null,'INVALID_ARGUMENTS'),400);
    const id=isNotification?null:msg.id;
    // Every authenticated protocol message, not just tool calls, requires a live
    // canonical claim and durable cumulative input/output metering. The DB MUST
    // check the task, principal, session, fence, lease and socket:protocol grant.
    // The exact trusted MCP response frame is included for atomic output reservation.
    async function meteredProtocol(frame){
      const wire=frame===null?'':JSON.stringify(frame);
      if(bytes(wire)>MAX_RESPONSE)return json(errorReply(id,'OUTPUT_TOO_LARGE'));
      const inboundTokens=tokenCount(deps.meter,raw);
      const outboundTokens=wire?tokenCount(deps.meter,wire):0;
      if(inboundTokens===null||outboundTokens===null)return json(errorReply(id,'FAIL_CLOSED'));
      let result;
      try{
        result=await deps.database.executeAtomically({
          operation:'protocol',capability:'socket:protocol',
          principalId:principal.id,sessionId:principal.sessionId,
          taskId:principal.taskId,claimToken:principal.claimToken,
          payload:{method:msg.method},inboundTokens,replyId:id,
          maxReplyBytes:MAX_RESPONSE,replyFrame:wire
        });
      }catch{return json(errorReply(id,'FAIL_CLOSED'));}
      if(!isObject(result))return json(errorReply(id,'FAIL_CLOSED'));
      if(result.status==='denied')
        return json(errorReply(id,Object.hasOwn(codes,result.code)?result.code:'FAIL_CLOSED'));
      if(result.status!=='ok'||!isObject(result.receipt)||
        !Number.isSafeInteger(result.receipt.inputTokens)||result.receipt.inputTokens<inboundTokens||
        !Number.isSafeInteger(result.receipt.outputTokens)||result.receipt.outputTokens<outboundTokens)
        return json(errorReply(id,'FAIL_CLOSED'));
      return frame===null?
        new Response(null,{status:202,headers:{'cache-control':'no-store'}}):json(frame);
    }
    if(isNotification)return meteredProtocol(null);
    if(msg.method==='initialize')return meteredProtocol(okReply(id,{
      protocolVersion:'2025-06-18',capabilities:{tools:{}},
      serverInfo:{name:'atax-task-socket',version:'1.0.0'}}));
    if(msg.method==='ping')return meteredProtocol(okReply(id,{}));
    if(msg.method==='tools/list')return meteredProtocol(okReply(id,{tools:SOCKET_TOOLS}));
    if(msg.method==='resources/list')return meteredProtocol(okReply(id,{resources:[]}));
    if(msg.method==='prompts/list')return meteredProtocol(okReply(id,{prompts:[]}));
    if(msg.method!=='tools/call')return meteredProtocol(errorReply(id,'TOOL_FORBIDDEN'));
    const name=msg.params?.name;
    const def=byName.get(name);
    if(!def)return meteredProtocol(errorReply(id,'TOOL_FORBIDDEN'));
    const args=msg.params?.arguments;
    if(!validateArguments(args,def))return meteredProtocol(errorReply(id,'INVALID_ARGUMENTS'));
    if(args.task_id!==principal.taskId)return meteredProtocol(errorReply(id,'CROSS_TASK_DENIED'));
    if(args.claim_token!==principal.claimToken)return meteredProtocol(errorReply(id,'STALE_FENCE'));
    let payload={};
    for(const key of Object.keys(def.fields))if(Object.hasOwn(args,key))payload[key]=args[key];
    if(def.operation==='workflow_request'){
      // No dynamic URLs, repositories, branch refs, command strings, or credentials.
      let workflow;
      try{workflow=deps.githubDispatch.resolveWorkflow(payload.workflow_key);}catch{return json(errorReply(id,'CAPABILITY_REVOKED'));}
      if(!workflow||workflow.key!==payload.workflow_key||!isObject(workflow.inputs)||
        Object.entries(payload.inputs).some(([key,value])=>
          !Object.hasOwn(workflow.inputs,key)||
          !Object.hasOwn(WORKFLOW_TYPES,workflow.inputs[key])||
          !WORKFLOW_TYPES[workflow.inputs[key]](value))||
        bytes(JSON.stringify(payload.inputs))>2048)return json(errorReply(id,'CAPABILITY_REVOKED'));
    }
    const inboundTokens=tokenCount(deps.meter,raw);
    if(inboundTokens===null)return json(errorReply(id,'FAIL_CLOSED'));
    const outputOversize=def.operation==='output_submit'&&bytes(JSON.stringify(payload.output))>MAX_SUBMISSION;
    let result;
    try{
      result=await deps.database.executeAtomically({
        operation:def.operation,capability:def.capability,principalId:principal.id,
        sessionId:principal.sessionId,taskId:args.task_id,claimToken:args.claim_token,
        payload,inboundTokens,replyId:id,maxReplyBytes:MAX_RESPONSE,
        rejectReason:outputOversize?'OUTPUT_TOO_LARGE':null
      });
    }catch{return json(errorReply(id,'FAIL_CLOSED'));}
    if(!isObject(result))return json(errorReply(id,'FAIL_CLOSED'));
    if(result.status==='denied'){
      return json(errorReply(id,Object.hasOwn(codes,result.code)?result.code:'FAIL_CLOSED'));
    }
    if(result.status!=='ok'||!isObject(result.receipt)||
      !Number.isSafeInteger(result.receipt.inputTokens)||result.receipt.inputTokens<inboundTokens||
      !Number.isSafeInteger(result.receipt.outputTokens)||result.receipt.outputTokens<0)
      return json(errorReply(id,'FAIL_CLOSED'));
    const frame=okReply(id,{content:[{type:'text',text:JSON.stringify(result.data)}]});
    const wire=JSON.stringify(frame);
    const outboundTokens=tokenCount(deps.meter,wire);
    if(bytes(wire)>MAX_RESPONSE)return json(errorReply(id,'OUTPUT_TOO_LARGE'));
    if(outboundTokens===null||result.receipt.outputTokens<outboundTokens)
      return json(errorReply(id,'FAIL_CLOSED'));
    return json(frame);
  }};
}
