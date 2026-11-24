import {loadMcpRuntimeConfig} from './ledger-config.mjs';
import {githubTools, githubGuide} from './github-tools.mjs';
import {providerTools,isOwnerPrincipal} from './provider-accounts.mjs';
import {createConfiguredSocketWorker} from './socket-worker.mjs';
/** ATAX MCP adapter: stateless JSON-RPC 2.0 / Streamable HTTP, no resident agents. */
const PROTOCOL = '2025-06-18';
const SUPPORTED = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const MAX_BODY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const one = (description, properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const S = {
  text: (description, maxLength = 256) => ({ type: 'string', description, minLength: 1, maxLength }),
  json: (description) => ({ description }),
  int: (description, min = 1, max = 3600) => ({ type: 'integer', minimum: min, maximum: max, description }),
  bool: description => ({ type: 'boolean', description }),
};
const tool = (name, description, scope, inputSchema, invoke) => ({name, description, scope, inputSchema, invoke});
const TOOLS = [
  tool('atax_context', 'Live canonical ATAX universe, systems, goals, tasks, maintenance and priorities', 'atax:read', one('context', {}), (_,db) => db.rpc('agent_context_overview', {})),
  tool('atax_system_context', 'Live canonical context snapshot for one system key', 'atax:read', one('system', {system_key:S.text('Canonical system key')}, ['system_key']), (a,db) => db.rpc('atax_context_snapshot', {system_key_in:a.system_key})),
  tool('atax_goal_overview', 'Open goals and their task states, optionally tag-filtered', 'atax:read', one('overview', {tags:{type:'array',items:S.text('Tag',80),maxItems:20}}), (a,db) => db.rpc('goal_ledger_overview', {tags_in:a.tags??null})),
  tool('atax_goal_get', 'Read a canonical goal by readable key', 'atax:read', one('get goal', {goal_key:S.text('Goal key')}, ['goal_key']), (a,db) => db.rpc('goal_ledger_get_by_key',{goal_key_in:a.goal_key})),
  tool('atax_goal_resume', 'Return persisted goal state, dependencies, task checkpoints and progress by key', 'atax:read', one('resume goal', {goal_key:S.text('Canonical goal key')}, ['goal_key']), (a,db)=>db.rpc('goal_ledger_resume_by_key',{goal_key_in:a.goal_key})),
  tool('atax_goal_blockers', 'Return active checkpoint blockers for a goal', 'atax:read', one('goal blockers',{goal_key:S.text('Goal key')},['goal_key']), (a,db)=>db.rpc('goal_ledger_blocker_overview',{goal_key_in:a.goal_key})),
  tool('atax_system_improvement', 'Inspect ATAX system self-improvement context without creating a resident agent', 'atax:read', one('improvement',{system_id:S.text('System UUID',36)},['system_id']), (a,db)=>db.rpc('system_improvement_context',{system_id_in:a.system_id})),
  tool('atax_goal_create_bounded', 'Create a governed bounded goal and 1-4 finite tasks using the canonical PostgreSQL transaction', 'atax:write', one('create bounded goal',{system_key:S.text('Canonical System key',120),title:S.text('Goal title',200),description:S.text('Description',4000),context:{type:'object'},instructions:S.text('Execution instructions',4000),acceptance_criteria:{type:'array',items:S.text('Acceptance criterion',800),minItems:1,maxItems:4},tags:{type:'array',items:S.text('Tag',80),maxItems:20},goal_loop_definition:{type:'object'},task_definitions:{type:'array',items:{type:'object'},minItems:1,maxItems:4},metadata:{type:'object'}},['system_key','title','description','acceptance_criteria','goal_loop_definition','task_definitions']), (a,db,p)=>db.rpc('atax_goal_create_system_bounded',{system_key_in:a.system_key,title_in:a.title,description_in:a.description,context_in:a.context??{},instructions_in:a.instructions??'',acceptance_criteria_in:a.acceptance_criteria,tags_in:a.tags??[],goal_loop_definition_in:a.goal_loop_definition,task_definitions_in:a.task_definitions,created_by_agent_id_in:p.id,metadata_in:{...(a.metadata??{}),request_mode:'work',work_modality:'feature'}})),
  tool('atax_vision_create', 'Create a canonical Vision before authoring target-locked Omni goals', 'atax:write', one('vision',{title:S.text('Vision title',200),description:S.text('Description',4000),target:{type:'object'},metadata:{type:'object'}},['title','description','target']), (a,db,p)=>db.rpc('vision_ledger_create',{title_in:a.title,description_in:a.description,target_in:a.target,created_by_agent_id_in:p.id,owner_user_id_in:null,metadata_in:a.metadata??{}})),
  tool('atax_vision_add_target', 'Add a Vision target for a canonical Omni goal', 'atax:write', one('vision target',{vision_id:S.text('Vision UUID',36),label:S.text('Target label',200),target:{type:'object'},parent_target_id:S.text('Optional parent target UUID',36),position:{type:'object'},metadata:{type:'object'}},['vision_id','label','target']), (a,db)=>db.rpc('vision_ledger_add_target',{vision_id_in:a.vision_id,parent_target_id_in:a.parent_target_id??null,label_in:a.label,target_in:a.target,position_in:a.position??{},metadata_in:a.metadata??{}})),
  tool('atax_vision_attach_board', 'Record existing tldraw Vision board identifiers; does not create a board', 'atax:write', one('board',{vision_id:S.text('Vision UUID',36),workspace_id:S.text('tldraw workspace ID',256),board_id:S.text('tldraw board ID',256),board_url:S.text('tldraw board URL',2048),overview_page_id:S.text('Overview page ID',256)},['vision_id','workspace_id','board_id','board_url','overview_page_id']), (a,db)=>db.rpc('vision_ledger_attach_tldraw',{vision_id_in:a.vision_id,workspace_id_in:a.workspace_id,board_id_in:a.board_id,board_url_in:a.board_url,overview_page_id_in:a.overview_page_id})),
  tool('atax_goal_create_omni', 'Create a Vision-linked target-locked Omni goal with finite tasks and acceptance loop', 'atax:write', one('omni goal',{system_key:S.text('Canonical System key',120),title:S.text('Goal title',200),description:S.text('Description',4000),context:{type:'object'},instructions:S.text('Instructions',4000),acceptance_criteria:{type:'array',items:S.text('Acceptance',800),minItems:1,maxItems:4},tags:{type:'array',items:S.text('Tag',80),maxItems:20},goal_type:S.text('Canonical goal type',80),target:{type:'object'},behavior_inputs:{type:'object'},expected_outputs:{type:'object'},goal_loop_definition:{type:'object'},task_definitions:{type:'array',items:{type:'object'},minItems:1,maxItems:4},metadata:{type:'object'}},['system_key','title','description','acceptance_criteria','goal_type','target','behavior_inputs','expected_outputs','goal_loop_definition','task_definitions','metadata']), (a,db,p)=>db.rpc('atax_goal_create_system_omni',{system_key_in:a.system_key,title_in:a.title,description_in:a.description,context_in:a.context??{},instructions_in:a.instructions??'',acceptance_criteria_in:a.acceptance_criteria,tags_in:a.tags??[],goal_type_in:a.goal_type,target_in:a.target,behavior_inputs_in:a.behavior_inputs,expected_outputs_in:a.expected_outputs,goal_loop_definition_in:a.goal_loop_definition,task_definitions_in:a.task_definitions,created_by_agent_id_in:p.id,metadata_in:a.metadata})),
  tool('atax_goal_priority', 'Set user priority for an existing goal through canonical audit RPC', 'atax:write', one('priority',{goal_key:S.text('Goal key'),priority:{type:'number',minimum:0,maximum:1,description:'Priority 0..1'}},['goal_key','priority']), (a,db,p)=>db.rpc('goal_ledger_set_priority',{goal_key_in:a.goal_key,priority_in:a.priority,agent_id_in:p.id})),
  tool('atax_goal_add_dependency', 'Add a blocking or advisory dependency between goals', 'atax:write', one('dependency',{goal_key:S.text('Dependent goal key'),prerequisite_goal_key:S.text('Prerequisite key'),dependency_type:{type:'string',enum:['blocking','advisory']}},['goal_key','prerequisite_goal_key','dependency_type']), (a,db,p)=>db.rpc('goal_ledger_add_dependency',{goal_key_in:a.goal_key,depends_on_goal_key_in:a.prerequisite_goal_key,dependency_type_in:a.dependency_type,created_by_agent_id_in:p.id})),
  tool('atax_task_add_dependency', 'Record finite task dependency through guarded database RPC', 'atax:write', one('task dependency',{task_id:S.text('Task UUID',36),prerequisite_task_id:S.text('Prerequisite task UUID',36),dependency_type:{type:'string',enum:['blocking','advisory']}},['task_id','prerequisite_task_id','dependency_type']), (a,db,p)=>db.rpc('task_ledger_add_dependency',{task_id_in:a.task_id,depends_on_task_id_in:a.prerequisite_task_id,dependency_type_in:a.dependency_type,created_by_agent_id_in:p.id})),
  tool('atax_task_loop_contract', 'Separate loop-author worker commits tested success predicates and releases the task to another executor', 'atax:write', one('loop contract',{task_id:S.text('Task UUID',36),claim_token:S.text('Claim UUID',36),loop_definition:{type:'object'},parameter_contract:{type:'object'},completion_parameters:{type:'array',maxItems:4},checkpoints:{type:'object'}},['task_id','claim_token','loop_definition','parameter_contract','completion_parameters','checkpoints']), (a,db,p)=>db.rpc('task_ledger_finalize_loop_script',{task_id_in:a.task_id,agent_id_in:p.id,claim_token_in:a.claim_token,loop_definition_in:a.loop_definition,parameter_contract_in:a.parameter_contract,completion_parameters_in:a.completion_parameters,checkpoint_contract_in:a.checkpoints})),
  tool('atax_verification_pending', 'List tasks awaiting independent verification', 'atax:verify', one('pending',{}), (_,db)=>db.rpc('task_ledger_pending_verification',{})),
  tool('atax_skills_search', 'Search live canonical skill registry by term', 'atax:read', one('find skills',{query:S.text('Skill name or slug',120)}, ['query']), (a,db) => db.skills(a.query)),
  tool('atax_skill_get', 'Fetch the current published canonical instructions of a skill', 'atax:read', one('read skill',{slug:S.text('Skill slug',120)}, ['slug']), (a,db) => db.skill(a.slug)),
  tool('atax_task_claim_next', 'Atomically claim the next eligible task using caller identity', 'atax:write', one('claim task',{capabilities:{type:'array',items:S.text('Agent capability',80),maxItems:30},lease_seconds:S.int('Lease length',60,900)}), (a,db,p) => db.rpc('task_ledger_claim_next',{agent_id_in:p.id,agent_name_in:p.id,agent_type_in:'mcp-external',capabilities_in:a.capabilities??[],lease_seconds_in:a.lease_seconds??300})),
  tool('atax_goal_claim_task', 'Atomically claim an eligible task within a specific goal', 'atax:write', one('claim from goal',{goal_key:S.text('Goal key'),capabilities:{type:'array',items:S.text('Capability',80),maxItems:30},lease_seconds:S.int('Lease length',60,900)},['goal_key']), (a,db,p)=>db.rpc('atax_goal_claim_safe',{goal_key_in:a.goal_key,agent_id_in:p.id,agent_name_in:p.id,agent_type_in:'mcp-external',capabilities_in:a.capabilities??[],session_id_in:p.id,lease_seconds_in:a.lease_seconds??300})),
  tool('atax_task_check_claim', 'Check claim ownership and fencing token', 'atax:write', one('check claim',{task_id:S.text('Task UUID',36),claim_token:S.text('Claim UUID',36)},['task_id','claim_token']), (a,db,p)=>db.rpc('task_ledger_check_claim',{task_id_in:a.task_id,agent_id_in:p.id,claim_token_in:a.claim_token})),
  tool('atax_task_handoff', 'After losing/expiring a socket lease, append a bounded, non-mutating completion/handoff note, then discover and claim other available work. This never restores the old lease.', 'atax:write', one('forfeited socket note',{task_id:S.text('Previously claimed task UUID',36),claim_token:S.text('Old fencing token UUID',36),note:S.text('What was attempted, observed results and unfinished work',3000),context:{type:'object',description:'Evidence, partial results and safe next steps; do not include secrets'}},['task_id','claim_token','note']), (a,db,p)=>db.rpc('task_ledger_record_handoff',{task_id_in:a.task_id,previous_agent_id_in:p.id,previous_claim_token_in:a.claim_token,handoff_note_in:a.note,context_in:a.context??{}})),
  tool('atax_task_heartbeat', 'Renew a fenced task lease and record progress', 'atax:write', one('heartbeat',{task_id:S.text('Task UUID',36),claim_token:S.text('Claim UUID',36),current_step:S.text('Current step',1200),lease_seconds:S.int('Lease length',60,900),heartbeat_context:{type:'object',description:'Structured progress, blockers, discoveries, next action'}},['task_id','claim_token','current_step']), (a,db,p)=>db.rpc('task_ledger_heartbeat_claim',{task_id_in:a.task_id,agent_id_in:p.id,claim_token_in:a.claim_token,current_step_in:a.current_step,lease_seconds_in:a.lease_seconds??300,heartbeat_context_in:a.heartbeat_context??{}})),
  tool('atax_task_record_loop', 'Persist one fenced Omni Loop iteration, observations and evidence', 'atax:write', one('loop',{task_id:S.text('Task UUID',36),claim_token:S.text('Claim UUID',36),iteration_no:S.int('Iteration number',1,1000000),input_payload:S.json('Applied input'),output_payload:S.json('Observed output'),observation:S.json('Observation'),criterion_results:S.json('Criterion outcomes'),loop_state:S.json('Loop state'),tools_used:S.json('Tool evidence'),evidence:S.json('Evidence'),verdict:S.text('Verdict',120),next_action:S.text('Next action',1200)},['task_id','claim_token','iteration_no','verdict','next_action']), (a,db,p)=>db.rpc('task_ledger_record_loop_iteration',{task_id_in:a.task_id,agent_id_in:p.id,claim_token_in:a.claim_token,iteration_no_in:a.iteration_no,input_payload_in:a.input_payload??{},output_payload_in:a.output_payload??{},observation_in:a.observation??{},criterion_results_in:a.criterion_results??{},loop_state_in:a.loop_state??{},tools_used_in:a.tools_used??{},evidence_in:a.evidence??{},verdict_in:a.verdict,next_action_in:a.next_action})),
  tool('atax_task_submit', 'Submit result and evidence for independent verification; never self-verify', 'atax:write', one('submit',{task_id:S.text('Task UUID',36),claim_token:S.text('Claim UUID',36),result:S.json('Result object'),summary:S.text('Result summary',2000),tools_used:S.json('Used tools'),evidence:S.json('Verification evidence'),status:S.text('Result status',80)},['task_id','claim_token','summary']), (a,db,p)=>db.rpc('task_ledger_submit_result',{task_id_in:a.task_id,agent_id_in:p.id,claim_token_in:a.claim_token,result_in:a.result??{},result_summary_in:a.summary,tools_used_in:a.tools_used??[],evidence_in:a.evidence??[],status_in:a.status??'completed'})),
  tool('atax_task_release', 'Release caller-owned fenced task to a valid nonterminal state', 'atax:write', one('release',{task_id:S.text('Task UUID',36),claim_token:S.text('Claim UUID',36),release_status:{type:'string',enum:['queued','blocked','abandoned']},reason:S.text('Release reason',1200)},['task_id','claim_token','release_status','reason']), (a,db,p)=>db.rpc('task_ledger_release_claim',{task_id_in:a.task_id,agent_id_in:p.id,claim_token_in:a.claim_token,release_status_in:a.release_status,reason_in:a.reason})),
  tool('atax_verification_claim', 'Claim the next task pending independent verification', 'atax:verify', one('verification claim',{lease_seconds:S.int('Lease length',60,900)}), (a,db,p)=>db.rpc('task_ledger_claim_verification',{verifier_agent_id_in:p.id,lease_seconds_in:a.lease_seconds??300})),
  tool('atax_verification_submit', 'Independently verify a submitted result under a verification claim', 'atax:verify', one('verification',{task_id:S.text('Task UUID',36),verification_claim_token:S.text('Verification claim UUID',36),verified:S.bool('Whether evidence passes'),report:{type:'object',description:'Structured independent verification evidence'}},['task_id','verification_claim_token','verified','report']), (a,db,p)=>db.rpc('task_ledger_verify_result_claimed',{task_id_in:a.task_id,verifier_agent_id_in:p.id,verification_claim_token_in:a.verification_claim_token,verified_in:a.verified,verification_report_in:a.report})),
  tool('atax_goal_finalize', 'Finalize an independently verified goal through the guarded database RPC', 'atax:verify', one('finalize',{goal_key:S.text('Goal key'),verification_report:{type:'object',description:'Independent acceptance evidence'}},['goal_key','verification_report']), (a,db,p)=>db.rpc('goal_ledger_finalize_by_key',{goal_key_in:a.goal_key,finalized_by_agent_id_in:p.id,verification_report_in:a.verification_report})),
  tool('atax_verification_claim_for_task', 'Claim a specific task pending independent verification by task UUID', 'atax:verify', one('claim verification for task',{task_id:S.text('Task UUID',36),lease_seconds:S.int('Lease length',60,900)},['task_id']), (a,db,p)=>db.rpc('task_ledger_claim_verification_for_task',{task_id_in:a.task_id,verifier_agent_id_in:p.id,lease_seconds_in:a.lease_seconds??300})),
  tool('atax_socket_context_pull', 'Retrieve one bounded canonical context page for the claimed task', 'atax:write', one('context pull',{task_id:S.text('Canonical task UUID',36),claim_token:S.text('Current fenced claim UUID',36),cursor:S.text('Cursor',256),limit:S.int('Limit',1,16)},['task_id','claim_token']), (a,db,p)=>db.rpc('atax_socket_execute_v1',{command_in:{operation:'context_pull',capability:'socket:context:read',principalId:p.id,sessionId:p.id,taskId:a.task_id,claimToken:a.claim_token,payload:{cursor:a.cursor,limit:a.limit??16},requestWire:JSON.stringify(a),inboundTokens:Math.max(1,Math.ceil(JSON.stringify(a).length/4)),replyId:'1',maxReplyBytes:8192,budgetProfile:{modelId:'unified-mcp'}}})),
  tool('atax_socket_output_submit', 'Persist bounded task output only; cannot edit a repository or any external resource', 'atax:write', one('output submit',{task_id:S.text('Canonical task UUID',36),claim_token:S.text('Current fenced claim UUID',36),output:{type:'object'},partial:S.bool('Partial output')},['task_id','claim_token','output']), (a,db,p)=>db.rpc('atax_socket_execute_v1',{command_in:{operation:'output_submit',capability:'socket:output:submit',principalId:p.id,sessionId:p.id,taskId:a.task_id,claimToken:a.claim_token,payload:{output:a.output,partial:a.partial??false},requestWire:JSON.stringify(a),inboundTokens:Math.max(1,Math.ceil(JSON.stringify(a).length/4)),replyId:'1',maxReplyBytes:8192,budgetProfile:{modelId:'unified-mcp'}}})),
  tool('atax_socket_atomisation_request', 'Request stop and fenced atomisation with a bounded partial-progress note', 'atax:write', one('atomisation request',{task_id:S.text('Canonical task UUID',36),claim_token:S.text('Current fenced claim UUID',36),reason:S.text('Reason',512),partial_progress:S.text('Partial progress',3000)},['task_id','claim_token','reason']), (a,db,p)=>db.rpc('atax_socket_execute_v1',{command_in:{operation:'atomisation_request',capability:'socket:atomise:request',principalId:p.id,sessionId:p.id,taskId:a.task_id,claimToken:a.claim_token,payload:{reason:a.reason,partial_progress:a.partial_progress??''},requestWire:JSON.stringify(a),inboundTokens:Math.max(1,Math.ceil(JSON.stringify(a).length/4)),replyId:'1',maxReplyBytes:8192,budgetProfile:{modelId:'unified-mcp'}}})),
  tool('atax_socket_workflow_request', 'Submit a preauthorised workflow intent to the canonical transaction outbox', 'atax:write', one('workflow request',{task_id:S.text('Canonical task UUID',36),claim_token:S.text('Current fenced claim UUID',36),workflow_key:S.text('Workflow key',64),inputs:{type:'object'}},['task_id','claim_token','workflow_key','inputs']), (a,db,p)=>db.rpc('atax_socket_execute_v1',{command_in:{operation:'workflow_request',capability:'socket:workflow:request',principalId:p.id,sessionId:p.id,taskId:a.task_id,claimToken:a.claim_token,payload:{workflow_key:a.workflow_key,inputs:a.inputs},requestWire:JSON.stringify(a),inboundTokens:Math.max(1,Math.ceil(JSON.stringify(a).length/4)),replyId:'1',maxReplyBytes:8192,budgetProfile:{modelId:'unified-mcp'}}})),
  tool('atax_socket_task_status', 'Retrieve minimal task state and remaining quota', 'atax:write', one('task status',{task_id:S.text('Canonical task UUID',36),claim_token:S.text('Current fenced claim UUID',36)},['task_id','claim_token']), (a,db,p)=>db.rpc('atax_socket_execute_v1',{command_in:{operation:'task_status',capability:'socket:task:status',principalId:p.id,sessionId:p.id,taskId:a.task_id,claimToken:a.claim_token,payload:{},requestWire:JSON.stringify(a),inboundTokens:Math.max(1,Math.ceil(JSON.stringify(a).length/4)),replyId:'1',maxReplyBytes:8192,budgetProfile:{modelId:'unified-mcp'}}})),
];
TOOLS.push(...githubTools,...providerTools);
const byName = new Map(TOOLS.map(t=>[t.name,t]));
const resourceDefs = [
  {uri:'atax://context/overview',name:'Canonical ATAX context',mimeType:'application/json',description:'Live Supabase context and current work'},
  {uri:'atax://goals/overview',name:'Goal and task ledger',mimeType:'application/json',description:'Live canonical goal/task graph'},
  {uri:'atax://skills/catalog',name:'Active skills catalogue',mimeType:'application/json',description:'Canonical Supabase skills registry'},
  {uri:'atax://guides/github-workflows',name:'ATAX GitHub repository and disposable FMRL workflows',mimeType:'application/json',description:'Choose permanent repositories or auto-disposed FMRL control-plane dispatch; security and verification rules'},
];
const safeHeaders = {'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'"};
function json(value,status=200,extra={}) { return new Response(JSON.stringify(value),{status,headers:{...safeHeaders,'content-type':'application/json; charset=utf-8',...extra}}); }
const err=(id,code,message,data)=>({jsonrpc:'2.0',id,error:{code,message,...(data?{data}: {})}});
const ok=(id,result)=>({jsonrpc:'2.0',id,result});
const timingEq=(a,b)=>{if(a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a[i]^b[i];return v===0};
const bytesFromB64Url=value=>{if(!/^[\w-]+$/.test(value))throw new Error('Invalid base64url');const raw=value.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(raw.padEnd(Math.ceil(raw.length/4)*4,'=')),c=>c.charCodeAt(0));};
const jwtBody=value=>JSON.parse(new TextDecoder().decode(bytesFromB64Url(value)));
function audienceIncludes(aud, expected){return typeof aud==='string'?aud===expected:Array.isArray(aud)&&aud.includes(expected);}
async function authenticate(request,env, fetcher){
  const header=request.headers.get('authorization')||'';
  if(!/^Bearer [\x21-\x7E]{12,8192}$/.test(header))return null;
  const token=header.slice(7);
  if(env.MCP_SHARED_TOKEN_SHA256){
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(token)));
    const target=String(env.MCP_SHARED_TOKEN_SHA256).toLowerCase();
    if(/^[a-f0-9]{64}$/.test(target)&&timingEq(digest,Uint8Array.from(target.match(/../g),x=>parseInt(x,16)))){
      const id=String(env.MCP_SHARED_SUBJECT||'atax-mcp-operator');
      if(!/^[\w.@:-]{3,120}$/.test(id))throw new Error('Invalid configured subject');
      return {id,authMethod:'shared',scopes:new Set(String(env.MCP_SHARED_SCOPES||'atax:read').split(/\s+/))};
    }
  }
  if(!env.MCP_AUTH_JWKS_URL||!env.MCP_AUTH_ISSUER||!env.MCP_AUTH_AUDIENCE)return null;
  const parts=token.split('.'); if(parts.length!==3)return null;
  let head,claims;
  try {head=jwtBody(parts[0]);claims=jwtBody(parts[1]);}catch{return null;}
  // OAuth access tokens are RFC 9068 at+jwt; reject unrelated session JWTs
  // even if they are signed by the same authorization server.
  if(!isObj(head)||!isObj(claims)||head.typ!=='at+jwt'||!['RS256','EdDSA','ES256'].includes(head.alg)||typeof head.kid!=='string'||
     typeof claims.azp!=='string'||!/^[A-Za-z0-9_.:-]{3,160}$/.test(claims.azp))return null;
  const now=Math.floor(Date.now()/1000);
  if(claims.iss!==env.MCP_AUTH_ISSUER||!audienceIncludes(claims.aud,env.MCP_AUTH_AUDIENCE)||!Number.isFinite(claims.exp)||claims.exp<=now||
     (claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now))||
     typeof claims.sub!=='string'|| !/^[\w.@:-]{3,120}$/.test(claims.sub))return null;
  const jwksUrl=new URL(env.MCP_AUTH_JWKS_URL);
  if(jwksUrl.protocol!=='https:'||!jwksUrl.hostname||jwksUrl.username||jwksUrl.password)return null;
  const issuer=new URL(env.MCP_AUTH_ISSUER);if(issuer.protocol!=='https:')return null;
  const response=await fetcher(jwksUrl.toString(),{redirect:'error',headers:{accept:'application/json'}});
  if(!response.ok)return null;
  const jwks=await response.json();
  const jwk=Array.isArray(jwks.keys)?jwks.keys.find(k=>k.kid===head.kid&&(!k.alg||k.alg===head.alg)&&(!k.use||k.use==='sig')&&(
    (head.alg==='RS256'&&k.kty==='RSA')||
    (head.alg==='EdDSA'&&k.kty==='OKP'&&k.crv==='Ed25519')||
    (head.alg==='ES256'&&k.kty==='EC'&&k.crv==='P-256')
  )):null;
  if(!jwk)return null;
  try{
    const algorithm=head.alg==='RS256'?{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}:
      head.alg==='EdDSA'?{name:'Ed25519'}:{name:'ECDSA',namedCurve:'P-256'};
    const verifyParams=head.alg==='ES256'?{name:'ECDSA',hash:'SHA-256'}:algorithm;
    const key=await crypto.subtle.importKey('jwk',jwk,algorithm,false,['verify']);
    const valid=await crypto.subtle.verify(verifyParams,key,bytesFromB64Url(parts[2]),encoder.encode(parts[0]+'.'+parts[1]));
    if(!valid)return null;
  }catch{return null;}
  const scopes=new Set(String(claims.scope||'').split(/\s+/).filter(Boolean));
  // OAuth server scopes (openid/profile/offline_access) are not ATAX capabilities.
  // Only a pinned OAuth owner subject may receive capabilities defined by server policy.
  // Never map all authenticated issuer accounts to the owner or verifier role.
  if(claims.sub===String(env.MCP_ATAX_OWNER_JWT_SUBJECT||'') &&
     typeof env.MCP_ATAX_OWNER_JWT_SUBJECT==='string' &&
     env.MCP_ATAX_OWNER_JWT_SUBJECT.length>=3 &&
     env.MCP_AUTH_OWNER_SCOPES) {
    for(const scope of String(env.MCP_AUTH_OWNER_SCOPES).split(/\s+/)) {
      if(/^atax:(read|write|verify|github:read|github:create|cloudflare:read|fmrl:execute)$/.test(scope))scopes.add(scope);
    }
  }
  // ATAX cares about authorized work, not which app supplies the external agent.
  // Per-task claim tokens enforce ownership without naming Claude or Gemini.
  return {id:claims.sub,authMethod:'jwt',scopes};
}
function allowedOrigin(req, env){
  const origin=req.headers.get('origin'); if(!origin)return true;
  const allowed=String(env.MCP_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
  return allowed.includes(origin);
}
function allowedScope(principal,scope){return principal.scopes.has(scope)||principal.scopes.has('atax:admin');}
const canonicalOwner=(principal,env)=>isOwnerPrincipal(env,principal);
function toolAllowed(principal,env,tool){
  // This personal server never delegates provider secrets or privileged ledger RPCs.
  return canonicalOwner(principal,env) && allowedScope(principal,tool.scope);
}
function supabase(env){
  if(!env?.__ledgerDb)throw Error('Canonical PostgreSQL ledger unavailable');
  return env.__ledgerDb;
}
async function runCall(name,args,principal,env,fetcher){
  const match=byName.get(name);
  if(!match)return {isError:true,content:[{type:'text',text:'Unknown tool'}]};
  if(!toolAllowed(principal,env,match))return {isError:true,content:[{type:'text',text:'Principal or scope not authorized for this tool'}]};
  if(!isObj(args))return {isError:true,content:[{type:'text',text:'Tool arguments must be an object'}]};
  const schema=match.inputSchema;
  for(const field of schema.required||[]){if(args[field]===undefined)return {isError:true,content:[{type:'text',text:'Missing required argument: '+field}]};}
  for(const [key,val] of Object.entries(args)){
    const spec=schema.properties[key]; if(!spec)return {isError:true,content:[{type:'text',text:'Unexpected argument: '+key}]};
    if(spec.type==='string'&&(typeof val!=='string'||val.length<(spec.minLength??0)||val.length>(spec.maxLength??Infinity)))return {isError:true,content:[{type:'text',text:'Invalid string: '+key}]};
    if(spec.type==='integer'&&(!Number.isInteger(val)||val<(spec.minimum??-Infinity)||val>(spec.maximum??Infinity)))return {isError:true,content:[{type:'text',text:'Invalid integer: '+key}]};
    if(spec.type==='number'&&(typeof val!=='number'||!Number.isFinite(val)||val<(spec.minimum??-Infinity)||val>(spec.maximum??Infinity)))return {isError:true,content:[{type:'text',text:'Invalid number: '+key}]};
    if(spec.type==='boolean'&&typeof val!=='boolean')return {isError:true,content:[{type:'text',text:'Invalid boolean: '+key}]};
    if(spec.type==='array'&&(!Array.isArray(val)||val.length>(spec.maxItems??Infinity)||val.length<(spec.minItems??0)||val.some(x=>(spec.items?.type==='string'&&(typeof x!=='string'||x.length<(spec.items.minLength??0)||x.length>(spec.items.maxLength??Infinity)))||(spec.items?.type==='object'&&!isObj(x)))))return {isError:true,content:[{type:'text',text:'Invalid array: '+key}]};
    if(spec.type==='object'&&!isObj(val))return {isError:true,content:[{type:'text',text:'Invalid object: '+key}]};
    if(spec.enum&&!spec.enum.includes(val))return {isError:true,content:[{type:'text',text:'Unsupported value: '+key}]};
  }
  try{const result=await match.invoke(args,supabase(env,fetcher),principal,{env,fetcher});return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:{result}};}
  catch{return {isError:true,content:[{type:'text',text:'Canonical operation denied or unavailable'}]};}
}
async function routeRpc(msg,principal,env,fetcher){
  if(!isObj(msg)||msg.jsonrpc!=='2.0'||(msg.id!==undefined && !(typeof msg.id==='number'||typeof msg.id==='string'||msg.id===null)))return err(null,-32600,'Invalid request');
  const id=msg.id??null;
  if(typeof msg.method!=='string')return err(id,-32600,'Invalid method');
  if(msg.method.startsWith('notifications/'))return undefined;
  if(msg.id===undefined)return undefined;
  const params=msg.params??{};
  if(!isObj(params))return err(id,-32602,'Params must be an object');
  if(msg.method==='initialize'){
    if(params.protocolVersion&&!SUPPORTED.has(params.protocolVersion))return err(id,-32602,'Unsupported MCP protocol version');
    return ok(id,{protocolVersion:params.protocolVersion||PROTOCOL,capabilities:{tools:{listChanged:false},resources:{listChanged:false},prompts:{listChanged:false}},serverInfo:{name:'atax-mcp',version:'1.0.0'},instructions:'ATAX is persistent state for external transient agents. Hydrate canonical context and skills before work; ATAX never spawns or schedules agents. Heartbeat and check claim every 30-60 seconds; leases expire after at most 120 seconds. On lost claim, stop writing the old socket, call atax_task_handoff with the old token and a partial-work note, then call atax_task_claim_next or atax_goal_claim_task to find another free socket. Do NOT exit solely because the prior lease was lost. For GitHub operations, read atax_github_workflows_guide first; create permanent projects via atax_github_repository_create, and use atax_fmrl_create_run_dispose only for disposable fallback CI with mandatory atax_fmrl_get_status cleanup verification.'});
  }
  if(msg.method==='ping')return ok(id,{});
  if(msg.method==='tools/list')return ok(id,{tools:TOOLS.filter(t=>toolAllowed(principal,env,t)).map(({name,description,inputSchema})=>({name,description,inputSchema}))});
  if(msg.method==='tools/call'){
    if(typeof params.name!=='string')return err(id,-32602,'Missing tool name');
    return ok(id,await runCall(params.name,params.arguments??{},principal,env,fetcher));
  }
  if(msg.method==='resources/list')return ok(id,{resources:canonicalOwner(principal,env)?resourceDefs:[]});
  if(msg.method==='resources/templates/list')return ok(id,{resourceTemplates:canonicalOwner(principal,env)?[{uriTemplate:'atax://skills/{slug}',name:'Canonical skill instructions',description:'Current published Supabase skill version',mimeType:'application/json'}]:[]});
  if(msg.method==='resources/read'){
    if(typeof params.uri!=='string')return err(id,-32602,'Resource URI required');
    if(!canonicalOwner(principal,env)||!allowedScope(principal,'atax:read'))return err(id,-32003,'Canonical ATAX owner and read scope required');
    try {
      const db=supabase(env,fetcher);
      let result;
      if(params.uri==='atax://context/overview')result=await db.rpc('agent_context_overview',{});
      else if(params.uri==='atax://goals/overview')result=await db.rpc('goal_ledger_overview',{tags_in:null});
      else if(params.uri==='atax://guides/github-workflows')result=githubGuide;
      else if(params.uri==='atax://skills/catalog')result=await db.request('skills?select=id,slug,name,description,status,current_version_id&status=eq.active&limit=200');
      else if(/^atax:\/\/skills\/[a-z0-9-]+$/.test(params.uri))result=await db.skill(params.uri.slice('atax://skills/'.length));
      else return err(id,-32002,'Unknown resource URI');
      return ok(id,{contents:[{uri:params.uri,mimeType:'application/json',text:JSON.stringify(result)}]});
    }catch{return err(id,-32001,'Canonical resource denied or unavailable');}
  }
  if(msg.method==='prompts/list')return ok(id,{prompts:canonicalOwner(principal,env)?[{name:'atax-github-workflow',description:'Guide for permanent GitHub repository creation and disposable FMRL private CI',arguments:[]}]:[]});
  if(msg.method==='prompts/get'){
    if(!canonicalOwner(principal,env))return err(id,-32003,'Canonical ATAX owner required');
    if(params.name!=='atax-github-workflow')return err(id,-32602,'Unknown prompt');
    return ok(id,{description:githubGuide.title,messages:[{role:'user',content:{type:'text',text:JSON.stringify(githubGuide)}}]});
  }
  return err(id,-32601,'Method not found');
}
export function createHandler(fetcher=fetch,configLoader=loadMcpRuntimeConfig){
  async function dispatch(req,env={}){
    const url=new URL(req.url);
    if(url.pathname==='/health'&&req.method==='GET')return json({service:'atax-mcp',status:'ok',protocol:PROTOCOL});
    if((url.pathname==='/.well-known/oauth-protected-resource'||url.pathname==='/.well-known/oauth-protected-resource/mcp')&&req.method==='GET'){
      const resource=new URL('/mcp',req.url).toString();
      const server=String(env.MCP_AUTH_AUTHORIZATION_SERVER||env.MCP_AUTH_ISSUER||'').trim();
      // The independently configured authorization server owns OAuth metadata and dynamic client registration.
      // ATAX is a protected resource, never a second token issuer.
      return json({resource,authorization_servers:server?[server]:[],bearer_methods_supported:['header'],
        scopes_supported:['openid','profile','email','offline_access']});
    }
    if(url.pathname==='/socket'){
      if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{...safeHeaders,allow:'POST, OPTIONS'}});
      if(!allowedOrigin(req,env))return json({error:'Origin forbidden'},403);
      const socketWorker=createConfiguredSocketWorker(env,fetcher);
      return socketWorker.fetch(req);
    }
    if(url.pathname!=='/mcp')return json({error:'Not found'},404);
    if(!allowedOrigin(req,env))return json({error:'Origin forbidden'},403);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{...safeHeaders,allow:'POST, GET, OPTIONS'}});
    if(!['POST','GET','DELETE'].includes(req.method))return json({error:'Method not allowed'},405,{allow:'POST, GET'});
    if(!env.__ledgerDb||!(env.MCP_SHARED_TOKEN_SHA256||env.MCP_AUTH_JWKS_URL))return json({error:'ATAX MCP not configured'},503);
    let principal;try{principal=await authenticate(req,env,fetcher);}catch{return json({error:'Authentication unavailable'},503);}
    if(!principal)return json({error:'Unauthorized'},401,{'www-authenticate':'Bearer resource_metadata="'+new URL('/.well-known/oauth-protected-resource/mcp',req.url).toString()+'"'});
    if(req.method==='GET')return json({error:'Stateless MCP endpoint does not support standalone SSE'},405,{allow:'POST'});
    if(req.method==='DELETE')return json({error:'No sessions to terminate'},405,{allow:'POST'});
    if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return json({error:'Content-Type must be application/json'},415);
    const length=Number(req.headers.get('content-length')||0);if(length>MAX_BODY_BYTES)return json({error:'Request too large'},413);
    let body;try{const source=await req.text();if(encoder.encode(source).length>MAX_BODY_BYTES)return json({error:'Request too large'},413);body=JSON.parse(source);}catch{return json(err(null,-32700,'Parse error'),400);}
    if(Array.isArray(body)&&body.length===0)return json(err(null,-32600,'Empty JSON-RPC batch'),400);
    const batch=Array.isArray(body)?body:[body];if(batch.length>30)return json(err(null,-32600,'Too many batch requests'),400);
    const results=[];for(const msg of batch){const reply=await routeRpc(msg,principal,env,fetcher);if(reply!==undefined)results.push(reply);}
    if(!results.length)return new Response(null,{status:202,headers:safeHeaders});
    return json(Array.isArray(body)?results:results[0]);
  }
  return async (req,bootstrapEnv={})=>{
    const path=new URL(req.url).pathname;
    let env={};
    if(path==='/mcp'||path==='/socket'||path==='/.well-known/oauth-protected-resource'||
       path==='/.well-known/oauth-protected-resource/mcp'){
      try{env=await configLoader(bootstrapEnv,req);}
      catch(err){console.error('[worker:configLoader]', err);return json({error:'ATAX MCP not configured'},503);}
    }
    const response=await dispatch(req,env);
    const origin=req.headers.get('origin');
    if(!origin||!allowedOrigin(req,env))return response;
    const headers=new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin',origin);
    headers.set('Access-Control-Allow-Methods','POST, GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
    headers.set('Access-Control-Max-Age','600');
    headers.set('Vary','Origin');
    return new Response(response.body,{status:response.status,headers});
  };
}
export { routeRpc, authenticate, TOOLS, byName };
export default {fetch:createHandler()};
