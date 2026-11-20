/** First-class GitHub/FMRL control-plane tools. No target code or credentials enter MCP results. */
const OWNER = 'dinilmusick';
const CONTROLLER = `${OWNER}/ATAX`;
const ACTIONS_WORKFLOW = 'private-repo-ci.yml';
const ACTIONS_URL = `https://api.github.com/repos/${CONTROLLER}/actions/workflows/${ACTIONS_WORKFLOW}`;
const API = 'https://api.github.com';
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const FULL_NAME = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const REF = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const one = (description, properties, required=[]) => ({type:'object',description,properties,required,additionalProperties:false});
const s = (description,maxLength=256)=>({type:'string',minLength:1,maxLength,description});
const tool = (name,description,scope,inputSchema,invoke)=>({name,description,scope,inputSchema,invoke});

export const githubGuide = Object.freeze({
  title:'ATAX GitHub and disposable FMRL workflows',
  canonical:'GitHub-native repo/tools remains fully supported; this MCP surface is an alternate interface to the same ATAX control plane.',
  order:[
    'Always hydrate ATAX Supabase context and current skills and claim an eligible ledger task before work.',
    'Use your own agent container and clone the TARGET repo there when possible; never use ATAX as a checkout workspace.',
    'Create a permanent project with atax_github_repository_create. It never creates FMRL repositories or grants CI execution.',
    'For private-target remote CI when local execution is unavailable/insufficient, call atax_fmrl_create_run_dispose with exact 40-character target commit SHA. This dispatches ATAX control-plane workflow; it alone provisions FMRL-*, runs checks and always attempts cleanup.',
    'Poll atax_fmrl_get_status with the returned request_id. Dispatch acceptance is NOT an execution result. Verify controller and disposable CI result plus independent bridge deletion/404. Failed cleanup is a blocker, never success.',
    'Record the precise result and evidence in the canonical ledger; obtain a separate verifier. Do not self-verify.',
  ],
  rules:[
    'FMRL public repos contain ONLY a trusted static CI bridge; a private target is cloned only inside the FMRL ephemeral runner.',
    'Do not put private source, secrets, target SHA, private target paths or raw logs in public FMRL commits, artifacts or MCP responses.',
    'Never run target code or private checkouts in ATAX Actions, nor fall back to Agent-Workspace-1.',
    'Do not reuse one MCP operator token for worker and independent verifier; tool permissions are scope-gated.',
    'Permanent repositories and disposable FMRL have separate creation permissions; FMRL has mandatory teardown on failure as well as success.',
    'Never mistake a GitHub 403/429 rate-limit error for deletion proof; only independent 404 (plus precreation evidence) verifies cleanup.',
  ],
  auth:{
    read:'atax:github:read', permanentCreation:'atax:github:create',
    disposableExecution:'atax:fmrl:execute',
    serverSecrets:['GITHUB_REPOSITORY_TOKEN','GITHUB_FMRL_DISPATCH_TOKEN'],
    serverBindings:['MCP_GITHUB_OWNER','MCP_FMRL_ALLOWED_TARGETS'],
  },
  lifecycle:'The FMRL workflow owns provisioning, dispatch, log redaction, and unconditional delete + independent verify; the MCP Worker NEVER hosts source or schedules agents.',
});

const requireEnv = (env,key) => {
  const value = String(env[key]||'').trim();
  if (!value) throw new Error(`${key} not configured`);
  return value;
};
function assertOwner(env) {
  const owner = requireEnv(env,'MCP_GITHUB_OWNER');
  if (owner !== OWNER) throw new Error('MCP_GITHUB_OWNER is not the canonical ATAX owner');
  return owner;
}
function ensureName(name, permanent=false) {
  if (typeof name !== 'string' || !NAME.test(name) || name === '.' || name === '..' || name.startsWith('.'))
    throw new Error('Invalid GitHub repository name');
  if (permanent && (/^FMRL(?:-|$)/i.test(name) || /^ATAX$/i.test(name) || /^Agent-Workspace-1$/i.test(name)))
    throw new Error('Reserved repository; use the dedicated FMRL controller for disposable work');
  return name;
}
function parseRepo(repo, env) {
  const match = String(repo||'').match(FULL_NAME);
  if (!match || match[1] !== assertOwner(env)) throw new Error('Repository must be under the configured canonical owner');
  ensureName(match[2]);
  return `${match[1]}/${match[2]}`;
}
function targetAllowed(repo, env) {
  const values = String(env.MCP_FMRL_ALLOWED_TARGETS||'').split(',').map(v=>v.trim()).filter(Boolean);
  if (!values.length) throw new Error('MCP_FMRL_ALLOWED_TARGETS allowlist is required');
  if (!values.includes(repo)) throw new Error('Target repository not approved for FMRL remote CI');
}
async function githubRequest(fetcher, url, token, {method='GET',body, anonymous=false}={}) {
  if (!url.startsWith(`${API}/repos/`) && url!==`${API}/user/repos`)
    throw new Error('Unsupported GitHub API endpoint');
  const headers={'accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'atax-mcp-control-plane'};
  if (!anonymous) headers.authorization=`Bearer ${token}`;
  if (body!==undefined) headers['content-type']='application/json';
  const res=await fetcher(url,{method,headers,redirect:'error',...(body===undefined?{}:{body:JSON.stringify(body)})});
  if (!res.ok) return {status:res.status,ok:false};
  if (res.status===204) return {status:204,ok:true,data:null};
  let data;
  try {data=await res.json();}catch{throw new Error('GitHub returned invalid JSON');}
  return {status:res.status,ok:true,data};
}
function requireOk(res, context){if(!res.ok)throw new Error(`${context} failed (HTTP ${res.status})`);return res.data;}
async function repositoryInfo(repo,ctx,token) {
  const data=requireOk(await githubRequest(ctx.fetcher,`${API}/repos/${repo}`,token),'GitHub repository lookup');
  if (data.full_name!==repo)throw new Error('Repository identity mismatch');
  return {repository:data.full_name,url:data.html_url,visibility:data.private?'private':'public',default_branch:data.default_branch};
}
async function createRepository(a,_db,_p,ctx){
  const env=ctx.env; const owner=assertOwner(env);
  const name=ensureName(a.name,true);
  const token=requireEnv(env,'GITHUB_REPOSITORY_TOKEN');
  const description=a.description||'';
  const visibility=a.visibility||'private';
  const body={name,description,private:visibility==='private',auto_init:a.initialize??true};
  const result=requireOk(await githubRequest(ctx.fetcher,`${API}/user/repos`,token,{method:'POST',body}),'GitHub repository creation');
  if(result.full_name!==`${owner}/${name}`)throw new Error('Created repository owner/name mismatch');
  const verified=await repositoryInfo(result.full_name,ctx,token);
  if(verified.visibility!==visibility)throw new Error('Created repository visibility mismatch');
  return {operation:'create_permanent_repository',...verified,verified:true,disposable:false};
}
async function inspectRepository(a,_db,_p,ctx){
  const repo=parseRepo(a.repository,ctx.env);
  const token=requireEnv(ctx.env,'GITHUB_REPOSITORY_TOKEN');
  return {operation:'inspect_repository',...await repositoryInfo(repo,ctx,token)};
}
function validateFmrlArgs(a,env){
  const repo=parseRepo(a.repository,env);
  if(repo===CONTROLLER)throw new Error('ATAX itself is never a CI target');
  targetAllowed(repo,env);
  if(!REF.test(a.ref||''))throw new Error('FMRL requires exact lowercase 40-character Git commit SHA');
  if(a.workflow!==undefined && !/^[A-Za-z0-9_.-]{1,100}\.ya?ml$/.test(a.workflow))throw new Error('Invalid target workflow file');
  return repo;
}
async function dispatchFmrl(a,_db,_p,ctx){
  const owner=assertOwner(ctx.env);
  const repository=validateFmrlArgs(a,ctx.env);
  const token=requireEnv(ctx.env,'GITHUB_FMRL_DISPATCH_TOKEN');
  const requestId=crypto.randomUUID();
  const inputs={repository,ref:a.ref,event:a.event||'push',workflow:a.workflow||'',request_id:requestId};
  const res=await githubRequest(ctx.fetcher,`${ACTIONS_URL}/dispatches`,token,{method:'POST',body:{ref:'main',inputs}});
  requireOk(res,'FMRL controller dispatch');
  return {request_id:requestId,state:'dispatch_accepted_not_executed',controller:`${owner}/ATAX`,
    controller_runs_url:`https://github.com/${CONTROLLER}/actions/workflows/${ACTIONS_WORKFLOW}`,
    next_tool:'atax_fmrl_get_status',
    important:'Poll until the controller job reaches terminal state, inspect CI conclusion and demand independent FMRL deletion/404. Failed cleanup blocks task completion. A dispatch ACK is not CI evidence.'};
}
async function getFmrlStatus(a,_db,_p,ctx) {
  assertOwner(ctx.env);
  if(!REQUEST_ID.test(a.request_id))throw new Error('Invalid FMRL correlation request_id');
  const token=requireEnv(ctx.env,'GITHUB_FMRL_DISPATCH_TOKEN');
  let run;
  if(a.run_id!==undefined){
    const response=await githubRequest(ctx.fetcher,`${API}/repos/${CONTROLLER}/actions/runs/${a.run_id}`,token);
    run=requireOk(response,'FMRL controller run lookup');
    if(run.display_title!==`ATAX FMRL ${a.request_id}`)throw new Error('Run ID does not match FMRL request_id');
  } else {
    const response=await githubRequest(ctx.fetcher,`${ACTIONS_URL}/runs?event=workflow_dispatch&per_page=100`,token);
    const data=requireOk(response,'FMRL controller run list');
    run=(data.workflow_runs||[]).find(x=>x.display_title===`ATAX FMRL ${a.request_id}`);
  }
  if(!run)return {request_id:a.request_id,state:'awaiting_github_run_discovery',cleanup_verified:false,
    next:'Retry after GitHub Actions dispatch propagation, or provide controller run_id. Do not assume success.'};
  const state=run.status||'unknown'; const terminal=state==='completed';
  const result={request_id:a.request_id,run_id:run.id,attempt:run.run_attempt,
    state,conclusion:run.conclusion||null,run_url:run.html_url||`https://github.com/${CONTROLLER}/actions/runs/${run.id}`,
    cleanup_verified:false};
  if(!terminal){result.next='Poll this tool; controller is not terminal.';return result;}
  const response=await githubRequest(ctx.fetcher,`${API}/repos/${CONTROLLER}/actions/runs/${run.id}/jobs?per_page=100`,token);
  const data=requireOk(response,'FMRL controller job inspection');
  const jobs=data.jobs||[]; const steps=jobs.flatMap(job=>job.steps||[]);
  const created=steps.some(step=>step.name==='Provision disposable FMRL public repository'&&step.conclusion==='success');
  const cleanup=steps.some(step=>step.name==='ALWAYS delete FMRL and verify absence'&&step.conclusion==='success');
  result.bridge_provisioned=created; result.cleanup_step_passed=cleanup;
  const attempt=run.run_attempt;
  if(created && cleanup && Number.isInteger(attempt)&&attempt>=1 && Number.isInteger(run.id)){
    const bridge=`${OWNER}/FMRL-${run.id}-${attempt}`;
    const check=await githubRequest(ctx.fetcher,`${API}/repos/${bridge}`,'',{anonymous:true});
    result.cleanup_verified=check.status===404;
    result.cleanup_proof=result.cleanup_verified?'independent_anonymous_404_after_provision_and_cleanup':'independent_absence_unconfirmed';
  }
  result.next=result.cleanup_verified ?
    'Persist exact CI result and deletion evidence; an independent verifier must review and accept it. CI success and cleanup are separate conditions.':
    'Cleanup is NOT independently verified. Treat as blocker and investigate controller cleanup; never use ATAX as fallback.';
  return result;
}
export const githubTools=[
  tool('atax_github_workflows_guide',
    'READ FIRST for GitHub work: choose permanent repository vs disposable FMRL; container-first workflow, security rules, mandatory cleanup and evidence. No credentials are exposed.',
    'atax:read',one('GitHub operations guide',{}),()=>githubGuide),
  tool('atax_github_repository_inspect',
    'Inspect an owner-scoped permanent GitHub repository and verify visibility/default branch without exposing credentials.',
    'atax:github:read',one('Repository lookup',{repository:s('Canonical owner/name repository',205)},['repository']),inspectRepository),
  tool('atax_github_repository_create',
    'CREATE A PERMANENT GitHub repository using the existing ATAX GitHub repository-lifecycle contract. Defaults PRIVATE, README initialised, verifies created owner/visibility. Never use for FMRL; separate scope atax:github:create.',
    'atax:github:create',one('Permanent GitHub repository',{name:s('New repository name (NOT FMRL-* or ATAX)',100),description:{type:'string',maxLength:300,description:'Public description; must contain no credentials or private content'},visibility:{type:'string',enum:['private','public'],description:'Defaults to private'},initialize:{type:'boolean',description:'Initialize repository with README (default true)'}},['name']),createRepository),
  tool('atax_fmrl_create_run_dispose',
    'DISPOSABLE PRIVATE-TARGET CI FALLBACK, NOT permanent repo creation. Container first; only if local execution unavailable/insufficient. Dispatch canonical ATAX private-repo-ci.yml controller which provisions a public FMRL-* bridge, checks out exact private SHA inside isolated runner, runs checks, ALWAYS deletes FMRL even after failure and independently verifies 404. Returns correlation request_id, NOT job success. Never execute target code in ATAX. Requires explicit allowlisted target and atax:fmrl:execute scope.',
    'atax:fmrl:execute',one('Dispatch FMRL remote CI',{repository:s('Allowlisted private repository owner/name (NOT ATAX)',205),ref:s('Exact 40-character lowercase target commit SHA',40),event:{type:'string',enum:['push','pull_request','workflow_dispatch'],description:'Target event; default push'},workflow:{type:'string',maxLength:105,description:'Optional workflow filename ending .yml or .yaml'}},['repository','ref']),dispatchFmrl),
  tool('atax_fmrl_get_status',
    'POLL one FMRL controller dispatch by correlation request_id until terminal. Reports exact controller result, confirms provisioning+cleanup steps, independently reads the public bridge for HTTP 404, and BLOCKS acceptance without verified deletion. Never infer CI success from dispatch acceptance.',
    'atax:fmrl:execute',one('FMRL status',{request_id:s('Correlation ID returned by atax_fmrl_create_run_dispose',36),run_id:{type:'integer',minimum:1,maximum:9007199254740991,description:'Optional known exact controller GitHub Actions run ID (for >100 recent runs)'}},['request_id']),getFmrlStatus),
];
