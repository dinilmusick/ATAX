import {resolveProviderAccount} from './provider-accounts.mjs';
/** First-class GitHub/FMRL control-plane tools. No target code or credentials enter MCP results. */
// Phase 3: OWNER constant is kept as a build-time safety net for the FMRL controller
// repository path, but assertOwner() now validates against the env var rather than
// enforcing a hardcoded string identity — enabling owners with different GitHub logins
// to operate their own ATAX deployments without code changes.
const OWNER = 'dinilmusick';
const CONTROLLER = `${OWNER}/ATAX`;
const ACTIONS_WORKFLOW = 'private-repo-ci.yml';
const ACTIONS_URL = `https://api.github.com/repos/${CONTROLLER}/actions/workflows/${ACTIONS_WORKFLOW}`;
const API = 'https://api.github.com';
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const FULL_NAME = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const REF = /^[0-9a-f]{40}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,119}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FMRL_RECEIPT = /^(FMRL (?:coverage|direct suite|failure categories|failing gate|TypeScript codes|TypeScript locations|Skipo rule IDs|Skipo migration categories|dependency migration categories|lockfile parse cause|Frnes diagnostic state|Frnes verifier JSON|Frnes exception class|last observed nested script)|Nested failure categories|Safe error identifiers):/;
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
    serverSecrets:['GH_KEY_<ALIAS> (GH_TOKEN_<ALIAS> accepted for migration)'],
    serverBindings:['MCP_GITHUB_OWNER (canonical owner for FMRL)'],
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
  if (!/^[a-zA-Z0-9-]{1,39}$/.test(owner)) throw new Error('MCP_GITHUB_OWNER is not a valid GitHub username');
  return owner;
}
function ensureName(name, permanent=false) {
  if (typeof name !== 'string' || !NAME.test(name) || name === '.' || name === '..' || name.startsWith('.'))
    throw new Error('Invalid GitHub repository name');
  if (permanent && (/^FMRL(?:-|$)/i.test(name) || /^ATAX$/i.test(name) || /^Agent-Workspace-1$/i.test(name)))
    throw new Error('Reserved repository; use the dedicated FMRL controller for disposable work');
  return name;
}
function ensureBranchName(raw) {
  const name = String(raw || '').trim().replace(/^refs\/heads\//, '');
  if (!BRANCH_NAME.test(name) || name.includes('..') || name.includes('//') || name.endsWith('/') || name.endsWith('.lock')) {
    throw new Error('Invalid GitHub branch name');
  }
  return name;
}
function parseRepo(repo, env) {
  const configuredOwner = assertOwner(env);
  const match = String(repo||'').match(FULL_NAME);
  if (!match || match[1] !== configuredOwner) throw new Error('Repository must be under the configured canonical owner');
  ensureName(match[2]);
  return `${match[1]}/${match[2]}`;
}
function controllerRepo(env) {
  return `${assertOwner(env)}/ATAX`;
}
async function githubRequest(fetcher, url, token, {method='GET',body, anonymous=false}={}) {
  if (!url.startsWith(`${API}/repos/`) && url!==`${API}/user/repos` && url!==`${API}/user`)
    throw new Error('Unsupported GitHub API endpoint');
  const headers={'accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'atax-mcp-control-plane'};
  if (!anonymous) headers.authorization=`Bearer ${token}`;
  if (body!==undefined) headers['content-type']='application/json';
  const res=await fetcher(url,{method,headers,redirect:'manual',...(body===undefined?{}:{body:JSON.stringify(body)})});
  if (!res.ok) return {status:res.status,ok:false};
  if (res.status===204) return {status:204,ok:true,data:null};
  let data;
  try {data=await res.json();}catch{throw new Error('GitHub returned invalid JSON');}
  return {status:res.status,ok:true,data};
}
function requireOk(res, context){if(!res.ok)throw new Error(`${context} failed (HTTP ${res.status})`);return res.data;}
async function jobFailureReceipts(fetcher,repo,job,token) {
  const url=`${API}/repos/${repo}/actions/jobs/${job.id}/logs`;
  try{
    let res=await fetcher(url,{method:'GET',redirect:'manual',headers:{
      accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',
      'user-agent':'atax-mcp-control-plane',authorization:`Bearer ${token}`}});
    if(res.status>=300&&res.status<400){
      const loc=res.headers?.get?.('location')||'';
      if(!loc||!/^https:\/\//.test(loc))return [];
      res=await fetcher(loc,{method:'GET',redirect:'follow',headers:{'user-agent':'atax-mcp-control-plane'}});
    }
    if(!res.ok)return [];
    const text=await res.text();
    const receipts=[];
    for(const raw of text.split(/\r?\n/)){
      const line=raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/^\S+Z\s+/,'').trim();
      if(!FMRL_RECEIPT.test(line)||receipts.includes(line))continue;
      receipts.push(line.slice(0,500));
      if(receipts.length>=16)break;
    }
    return receipts;
  }catch{return [];}
}
async function repositoryInfo(repo,ctx,token) {
  const data=requireOk(await githubRequest(ctx.fetcher,`${API}/repos/${repo}`,token),'GitHub repository lookup');
  if (String(data.full_name||'').toLowerCase()!==repo.toLowerCase())
    throw new Error(`Repository identity mismatch: requested ${repo}, canonical ${data.full_name||'<missing>'}`);
  return {repository:data.full_name,url:data.html_url,visibility:data.private?'private':'public',default_branch:data.default_branch};
}
async function createRepository(a,_db,p,ctx){
  const env=ctx.env;
  const selected=resolveProviderAccount(env,p,'github',a.account);
  const owner=requireOk(await githubRequest(ctx.fetcher,`${API}/user`,selected.token),'GitHub identity lookup').login;
  if(!owner||!/^[a-zA-Z0-9-]{1,39}$/.test(owner))throw new Error('Unable to verify token GitHub account');
  const name=ensureName(a.name,true);
  const token=selected.token;
  const description=a.description||'';
  const visibility=a.visibility||'private';
  const body={name,description,private:visibility==='private',auto_init:a.initialize??true};
  const result=requireOk(await githubRequest(ctx.fetcher,`${API}/user/repos`,token,{method:'POST',body}),'GitHub repository creation');
  if(result.full_name!==`${owner}/${name}`)throw new Error('Created repository owner/name mismatch');
  const verified=await repositoryInfo(result.full_name,ctx,token);
  if(verified.visibility!==visibility)throw new Error('Created repository visibility mismatch');
  return {operation:'create_permanent_repository',account:selected.alias,...verified,verified:true,disposable:false};
}
async function inspectRepository(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  return {operation:'inspect_repository',account:selected.alias,...await repositoryInfo(repo,ctx,selected.token)};
}
function validateFmrlArgs(a,env){
  const controller=controllerRepo(env);
  const repo=parseRepo(a.repository,env);
  if(repo===controller)throw new Error('ATAX itself is never a CI target');
  if(!REF.test(a.ref||''))throw new Error('FMRL requires exact lowercase 40-character Git commit SHA');
  if(a.workflow!==undefined && !/^[A-Za-z0-9_.-]{1,100}\.ya?ml$/.test(a.workflow))throw new Error('Invalid target workflow file');
  return repo;
}
async function dispatchFmrl(a,_db,principal,ctx){
  const owner=assertOwner(ctx.env);
  const controller=controllerRepo(ctx.env);
  const actionsUrl=`${API}/repos/${controller}/actions/workflows/${ACTIONS_WORKFLOW}`;
  const repository=validateFmrlArgs(a,ctx.env);
  const selected=resolveProviderAccount(ctx.env,principal,'github',a.account);
  const token=selected.token;
  const requestId=crypto.randomUUID();
  const inputs={repository,ref:a.ref,event:a.event||'push',workflow:a.workflow||'',request_id:requestId};
  if(a.mode!==undefined){
    const mode=a.mode;
    const branch=String(a.branch||'').trim();
    if(!['direct','repair','artifact'].includes(mode))throw new Error('FMRL mode must be direct, repair, or artifact');
    if(mode!=='direct'&&!branch)throw new Error(`FMRL ${mode} mode requires a target branch`);
    if(branch&&!BRANCH_NAME.test(branch))throw new Error('Invalid FMRL target branch');
    inputs.mode=mode;
    inputs.branch=branch;
  }
  const res=await githubRequest(ctx.fetcher,`${actionsUrl}/dispatches`,token,{method:'POST',body:{ref:'main',inputs}});
  requireOk(res,'FMRL controller dispatch');
  return {request_id:requestId,account:selected.alias,dispatched_account:selected.alias,state:'dispatch_accepted_not_executed',controller,
    controller_runs_url:`https://github.com/${controller}/actions/workflows/${ACTIONS_WORKFLOW}`,
    next_tool:'atax_fmrl_get_status',
    important:'Poll with the same account alias until the controller job reaches terminal state, inspect CI conclusion and demand independent FMRL deletion/404. Failed cleanup blocks task completion. A dispatch ACK is not CI evidence.'};
}
async function getFmrlStatus(a,_db,principal,ctx) {
  const owner=assertOwner(ctx.env);
  const controller=controllerRepo(ctx.env);
  const actionsUrl=`${API}/repos/${controller}/actions/workflows/${ACTIONS_WORKFLOW}`;
  if(!REQUEST_ID.test(a.request_id))throw new Error('Invalid FMRL correlation request_id');
  const selected=resolveProviderAccount(ctx.env,principal,'github',a.account);
  if(a.dispatched_account!==undefined){
    const expected=String(a.dispatched_account||'').trim().toUpperCase();
    if(expected!==selected.alias)throw new Error(`FMRL status account mismatch: selected ${selected.alias}, dispatched ${expected}`);
  }
  const token=selected.token;
  let run;
  if(a.run_id!==undefined){
    const response=await githubRequest(ctx.fetcher,`${API}/repos/${controller}/actions/runs/${a.run_id}`,token);
    run=requireOk(response,'FMRL controller run lookup');
    if(run.display_title!==`ATAX FMRL ${a.request_id}`)throw new Error('Run ID does not match FMRL request_id');
  } else {
    const response=await githubRequest(ctx.fetcher,`${actionsUrl}/runs?event=workflow_dispatch&per_page=100`,token);
    const data=requireOk(response,'FMRL controller run list');
    run=(data.workflow_runs||[]).find(x=>x.display_title===`ATAX FMRL ${a.request_id}`);
  }
  if(!run)return {request_id:a.request_id,account:selected.alias,state:'awaiting_github_run_discovery',cleanup_verified:false,
    next:'Retry after GitHub Actions dispatch propagation, or provide controller run_id. Do not assume success.'};
  const state=run.status||'unknown'; const terminal=state==='completed';
  const result={request_id:a.request_id,account:selected.alias,run_id:run.id,attempt:run.run_attempt,
    state,conclusion:run.conclusion||null,run_url:run.html_url||`https://github.com/${controller}/actions/runs/${run.id}`,
    cleanup_verified:false};
  if(!terminal){result.next='Poll this tool; controller is not terminal.';return result;}
  const response=await githubRequest(ctx.fetcher,`${API}/repos/${controller}/actions/runs/${run.id}/jobs?per_page=100`,token);
  const data=requireOk(response,'FMRL controller job inspection');
  const jobs=data.jobs||[]; const steps=jobs.flatMap(job=>job.steps||[]);
  const created=steps.some(step=>step.name==='Provision disposable FMRL public repository'&&step.conclusion==='success');
  const cleanup=steps.some(step=>step.name==='ALWAYS delete FMRL and verify absence'&&step.conclusion==='success');
  result.bridge_provisioned=created; result.cleanup_step_passed=cleanup;
  const attempt=run.run_attempt;
  if(created && cleanup && Number.isInteger(attempt)&&attempt>=1 && Number.isInteger(run.id)){
    const bridge=`${owner}/FMRL-${run.id}-${attempt}`;
    const check=await githubRequest(ctx.fetcher,`${API}/repos/${bridge}`,'',{anonymous:true});
    result.cleanup_verified=check.status===404;
    result.cleanup_proof=result.cleanup_verified?'independent_anonymous_404_after_provision_and_cleanup':'independent_absence_unconfirmed';
  }
  result.next=result.cleanup_verified ?
    'Persist exact CI result and deletion evidence; an independent verifier must review and accept it. CI success and cleanup are separate conditions.':
    'Cleanup is NOT independently verified. Treat as blocker and investigate controller cleanup; never use ATAX as fallback.';
  return result;
}
async function dispatchWorkflow(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const workflow=String(a.workflow||'');
  if(!/^[A-Za-z0-9_.-]{1,100}\.ya?ml$/.test(workflow)&&!/^\d+$/.test(workflow))
    throw new Error('Invalid workflow filename or ID');
  const ref=a.ref||'main';
  const body={ref,inputs:a.inputs||{}};
  const url=`${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const res=await githubRequest(ctx.fetcher,url,selected.token,{method:'POST',body});
  requireOk(res,'GitHub Actions workflow dispatch');
  return {operation:'workflow_dispatch',account:selected.alias,repository:repo,workflow,ref,status:'dispatched',note:'Workflow dispatched successfully to GitHub Actions.'};
}
async function listWorkflowRuns(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  if(a.run_id!==undefined){
    const url=`${API}/repos/${repo}/actions/runs/${a.run_id}`;
    const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token),'Workflow run lookup');
    const jobsUrl=`${API}/repos/${repo}/actions/runs/${a.run_id}/jobs?per_page=50`;
    let jobs=[];
    try{
      const jobsData=requireOk(await githubRequest(ctx.fetcher,jobsUrl,selected.token),'Workflow jobs lookup');
      for(const j of (jobsData.jobs||[])){
        const entry={id:j.id,name:j.name,status:j.status,conclusion:j.conclusion,steps:(j.steps||[]).map(s=>({name:s.name,status:s.status,conclusion:s.conclusion}))};
        if(j.conclusion==='failure')entry.failure_receipts=await jobFailureReceipts(ctx.fetcher,repo,j,selected.token);
        jobs.push(entry);
      }
    }catch{}
    return {operation:'workflow_run_detail',account:selected.alias,repository:repo,run_id:data.id,name:data.name,status:data.status,conclusion:data.conclusion,html_url:data.html_url,jobs};
  }
  let url=`${API}/repos/${repo}/actions/runs?per_page=15`;
  if(a.workflow)url=`${API}/repos/${repo}/actions/workflows/${encodeURIComponent(a.workflow)}/runs?per_page=15`;
  if(a.status)url+=`&status=${encodeURIComponent(a.status)}`;
  const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token),'Workflow runs list');
  const runs=(data.workflow_runs||[]).map(r=>({id:r.id,name:r.name,event:r.event,status:r.status,conclusion:r.conclusion,head_sha:r.head_sha,head_branch:r.head_branch,html_url:r.html_url,created_at:r.created_at}));
  return {operation:'workflow_runs_list',account:selected.alias,repository:repo,runs};
}
async function getCheckRuns(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const ref=encodeURIComponent(String(a.ref||''));
  if(!ref)throw new Error('Git commit ref or branch name is required');
  const url=`${API}/repos/${repo}/commits/${ref}/check-runs?per_page=30`;
  const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token),'Check runs lookup');
  const check_runs=(data.check_runs||[]).map(cr=>({id:cr.id,name:cr.name,status:cr.status,conclusion:cr.conclusion,started_at:cr.started_at,completed_at:cr.completed_at,html_url:cr.html_url,output_title:cr.output?.title||null,output_summary:cr.output?.summary?String(cr.output.summary).slice(0,1000):null}));
  return {operation:'check_runs',account:selected.alias,repository:repo,ref:a.ref,total_count:data.total_count??check_runs.length,check_runs};
}
async function getFile(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const path=String(a.path||'').replace(/^\/+/,'');
  if(!path)throw new Error('File path required');
  let url=`${API}/repos/${repo}/contents/${encodeURI(path)}`;
  if(a.ref)url+=`?ref=${encodeURIComponent(a.ref)}`;
  const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token),'GitHub file get');
  if(Array.isArray(data)){
    return {operation:'directory_listing',account:selected.alias,repository:repo,path,entries:data.map(item=>({name:item.name,path:item.path,type:item.type,size:item.size}))};
  }
  if(data.type!=='file')throw new Error('Target path is not a regular file');
  let content='';
  if(data.content&&data.encoding==='base64'){
    content=Buffer.from(data.content,'base64').toString('utf8');
  }
  return {operation:'file_get',account:selected.alias,repository:repo,path:data.path,sha:data.sha,size:data.size,content};
}
async function putFile(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const path=String(a.path||'').replace(/^\/+/,'');
  if(!path)throw new Error('File path required');
  const message=String(a.message||'').trim();
  if(!message)throw new Error('Commit message is required');
  const content=String(a.content??'');
  if (path.startsWith('.github/workflows/')) return putFileGitData(a,_db,p,ctx);
  const base64Content=Buffer.from(content,'utf8').toString('base64');
  const body={message,content:base64Content,...(a.branch?{branch:a.branch}:{}),...(a.sha?{sha:a.sha}:{})};
  const url=`${API}/repos/${repo}/contents/${encodeURI(path)}`;
  const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token,{method:'PUT',body}),'GitHub file put');
  return {operation:'file_put',account:selected.alias,repository:repo,path,commit_sha:data.commit?.sha,commit_url:data.commit?.html_url,content_sha:data.content?.sha};
}

async function putFileGitData(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const path=String(a.path||'').replace(/^\\+/,'');
  if(!path)throw new Error('File path required');
  const message=String(a.message||'').trim();
  if(!message)throw new Error('Commit message is required');
  const branch=ensureBranchName(a.branch||'main');
  const expected=a.expected_head?String(a.expected_head).trim():'';
  if(expected && !REF.test(expected))throw new Error('expected_head must be a 40-character lowercase commit SHA');
  const headData=requireOk(await githubRequest(ctx.fetcher,`${API}/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,selected.token),'GitHub branch lookup');
  const currentHead=String(headData.object?.sha||'');
  if(!REF.test(currentHead))throw new Error('Unable to resolve current branch head');
  if(expected && expected!==currentHead)throw new Error('Branch head changed; refusing non-fast-forward write');
  const commitData=requireOk(await githubRequest(ctx.fetcher,`${API}/repos/${repo}/git/commits/${currentHead}`,selected.token),'GitHub commit lookup');
  const blobData=requireOk(await githubRequest(ctx.fetcher,`${API}/repos/${repo}/git/blobs`,selected.token,{method:'POST',body:{
    content:Buffer.from(String(a.content??''),'utf8').toString('base64'),
    encoding:'base64'
  }}),'GitHub blob creation');
  const treeData=requireOk(await githubRequest(ctx.fetcher,`${API}/repos/${repo}/git/trees`,selected.token,{method:'POST',body:{
    base_tree:commitData.tree.sha,
    tree:[{path,mode:'100644',type:'blob',sha:blobData.sha}]
  }}),'GitHub tree creation');
  const newCommit=requireOk(await githubRequest(ctx.fetcher,`${API}/repos/${repo}/git/commits`,selected.token,{method:'POST',body:{
    message,
    tree:treeData.sha,
    parents:[currentHead]
  }}),'GitHub commit creation');
  const updated=requireOk(await githubRequest(ctx.fetcher,`${API}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,selected.token,{method:'PATCH',body:{sha:newCommit.sha,force:false}}),'GitHub branch update');
  return {operation:'file_put_gitdata',account:selected.alias,repository:repo,path,branch,previous_head:currentHead,commit_sha:newCommit.sha,commit_url:newCommit.html_url||null,ref:updated.ref};
}

async function deleteFile(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const path=String(a.path||'').replace(/^\/+/,'');
  if(!path)throw new Error('File path required');
  const message=String(a.message||'').trim();
  if(!message)throw new Error('Commit message is required');
  if(!REF.test(String(a.sha||'')))throw new Error('Valid 40-character blob SHA is required');
  const body={message,sha:a.sha,...(a.branch?{branch:a.branch}:{})};
  const url=`${API}/repos/${repo}/contents/${encodeURI(path)}`;
  const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token,{method:'DELETE',body}),'GitHub file delete');
  return {operation:'file_delete',account:selected.alias,repository:repo,path,commit_sha:data.commit?.sha,commit_url:data.commit?.html_url};
}
async function createBranch(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const branch=ensureBranchName(a.branch);
  let sha=a.sha?String(a.sha).trim():'';
  const base=a.base?ensureBranchName(a.base):'main';
  if(sha){
    if(!REF.test(sha))throw new Error('Commit SHA must be a 40-character lowercase hex SHA');
  } else {
    const refUrl=`${API}/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`;
    const refData=requireOk(await githubRequest(ctx.fetcher,refUrl,selected.token),'GitHub base branch lookup');
    sha=String(refData.object?.sha||'');
    if(!REF.test(sha))throw new Error('Unable to resolve base branch commit SHA');
  }
  const createUrl=`${API}/repos/${repo}/git/refs`;
  const created=requireOk(await githubRequest(ctx.fetcher,createUrl,selected.token,{
    method:'POST',body:{ref:`refs/heads/${branch}`,sha},
  }),'GitHub branch creation');
  return {operation:'branch_create',account:selected.alias,repository:repo,branch,base:a.sha?null:base,sha,ref:created.ref};
}
async function deleteBranch(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const branch=ensureBranchName(a.branch);
  if(branch==='main'||branch==='master')throw new Error('Refusing to delete protected default branch');
  const info=await repositoryInfo(repo,ctx,selected.token);
  if(branch===info.default_branch)throw new Error('Refusing to delete repository default branch');
  const url=`${API}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  requireOk(await githubRequest(ctx.fetcher,url,selected.token,{method:'DELETE'}),'GitHub branch deletion');
  return {operation:'branch_delete',account:selected.alias,repository:repo,branch,deleted:true};
}
async function createPullRequest(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const title=String(a.title||'').trim();
  if(!title)throw new Error('Pull request title required');
  const head=String(a.head||'').trim();
  if(!head)throw new Error('Head branch required');
  const base=String(a.base||'main').trim();
  const body={title,head,base,body:a.body||''};
  const url=`${API}/repos/${repo}/pulls`;
  const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token,{method:'POST',body}),'GitHub pull request creation');
  return {operation:'pull_request_create',account:selected.alias,repository:repo,number:data.number,title:data.title,url:data.html_url,state:data.state};
}
async function listPullRequests(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  const state=a.state||'open';
  const url=`${API}/repos/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=30`;
  const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token),'GitHub pull request list');
  const pull_requests=(Array.isArray(data)?data:[]).map(pr=>({
    number:pr.number,title:pr.title,state:pr.state,draft:Boolean(pr.draft),
    head:pr.head?.ref,head_sha:pr.head?.sha,base:pr.base?.ref,url:pr.html_url,
  }));
  return {operation:'pull_request_list',account:selected.alias,repository:repo,state,pull_requests};
}
async function mergePullRequest(a,_db,p,ctx){
  const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
  const repo=String(a.repository||'');
  if(!FULL_NAME.test(repo))throw new Error('Invalid GitHub repository owner/name');
  if(!Number.isInteger(a.pull_number)||a.pull_number<1)throw new Error('Valid pull_number is required');
  const merge_method=a.merge_method||'squash';
  const body={
    merge_method,
    ...(a.commit_title?{commit_title:String(a.commit_title).trim()}:{}),
    ...(a.sha?{sha:String(a.sha).trim()}:{}),
  };
  const url=`${API}/repos/${repo}/pulls/${a.pull_number}/merge`;
  const data=requireOk(await githubRequest(ctx.fetcher,url,selected.token,{method:'PUT',body}),'GitHub pull request merge');
  return {operation:'pull_request_merge',account:selected.alias,repository:repo,pull_number:a.pull_number,merged:Boolean(data.merged),sha:data.sha,message:data.message};
}
export const githubTools=[
  tool('atax_github_workflows_guide',
    'READ FIRST for GitHub work: choose permanent repository vs disposable FMRL; container-first workflow, security rules, mandatory cleanup and evidence. No credentials are exposed.',
    'atax:read',one('GitHub operations guide',{}),()=>githubGuide),
  tool('atax_github_repository_inspect',
    'Inspect an owner-scoped permanent GitHub repository and verify visibility/default branch without exposing credentials.',
    'atax:github:read',one('Repository lookup',{repository:s('GitHub owner/name repository',205),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential; omit when exactly one is available'}},['repository']),inspectRepository),
  tool('atax_github_repository_create',
    'CREATE A PERMANENT GitHub repository using the existing ATAX GitHub repository-lifecycle contract. Defaults PRIVATE, README initialised, verifies created owner/visibility. Never use for FMRL; separate scope atax:github:create.',
    'atax:github:create',one('Permanent GitHub repository',{name:s('New repository name (NOT FMRL-* or ATAX)',100),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential; omit when exactly one is available'},description:{type:'string',maxLength:300,description:'Public description; must contain no credentials or private content'},visibility:{type:'string',enum:['private','public'],description:'Defaults to private'},initialize:{type:'boolean',description:'Initialize repository with README (default true)'}},['name']),createRepository),
  tool('atax_fmrl_create_run_dispose',
    'DISPOSABLE PRIVATE-TARGET CI FALLBACK, NOT permanent repo creation. Container first; only if local execution unavailable/insufficient. Dispatch canonical ATAX private-repo-ci.yml controller which provisions a public FMRL-* bridge, checks out exact private SHA inside isolated runner, runs checks, ALWAYS deletes FMRL even after failure and independently verifies 404. Returns correlation request_id, NOT job success. Never execute target code in ATAX. Requires atax:fmrl:execute scope.',
    'atax:fmrl:execute',one('Dispatch FMRL remote CI',{repository:s('Private repository owner/name under the canonical owner (NOT ATAX)',205),ref:s('Exact 40-character lowercase target commit SHA',40),account:{type:'string',maxLength:48,description:'Named GitHub account authorized for the ATAX controller'},event:{type:'string',enum:['push','pull_request','workflow_dispatch'],description:'Target event; default push'},workflow:{type:'string',maxLength:105,description:'Optional workflow filename ending .yml or .yaml'},mode:{type:'string',enum:['direct','repair','artifact'],description:'Optional FMRL execution mode; default direct'},branch:{type:'string',maxLength:180,description:'Target PR head branch (required for repair and artifact modes)'}},['repository','ref']),dispatchFmrl),
  tool('atax_fmrl_get_status',
    'POLL one FMRL controller dispatch by correlation request_id until terminal. Reports exact controller result, confirms provisioning+cleanup steps, independently reads the public bridge for HTTP 404, and BLOCKS acceptance without verified deletion. Never infer CI success from dispatch acceptance.',
    'atax:fmrl:execute',one('FMRL status',{request_id:s('Correlation ID returned by atax_fmrl_create_run_dispose',36),account:{type:'string',maxLength:48,description:'Same GitHub account used for dispatch'},dispatched_account:{type:'string',maxLength:48,description:'Optional dispatched_account returned by atax_fmrl_create_run_dispose to enforce account consistency'},run_id:{type:'integer',minimum:1,maximum:9007199254740991,description:'Optional known exact controller GitHub Actions run ID (for >100 recent runs)'}},['request_id']),getFmrlStatus),
  tool('atax_github_workflow_dispatch',
    'Dispatch a GitHub Actions workflow (e.g. lint.yml, build.yml, test.yml) on any accessible repository using the authenticated GitHub token.',
    'atax:github:create',one('Workflow dispatch',{repository:s('GitHub owner/name repository',205),workflow:s('Workflow filename (e.g. lint.yml, build.yml) or ID',100),ref:s('Git branch or commit SHA (default main)',120),inputs:{type:'object',description:'Optional workflow inputs object'},account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','workflow']),dispatchWorkflow),
  tool('atax_github_workflow_runs',
    'List or inspect GitHub Actions workflow runs for a repository, reporting execution status, conclusion (success, failure), jobs, steps, safe FMRL failure receipts (failing gate, failure categories) for failed jobs, and URL.',
    'atax:github:read',one('Workflow runs lookup',{repository:s('GitHub owner/name repository',205),workflow:s('Optional workflow filename filter (e.g. ci.yml, lint.yml)',100),run_id:{type:'integer',minimum:1,maximum:9007199254740991,description:'Optional exact run ID to inspect in detail'},status:s('Optional status filter (e.g. completed, in_progress, queued)',50),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository']),listWorkflowRuns),
  tool('atax_github_check_runs',
    'Inspect GitHub check runs (automated linting, type-checking, test outcomes, build status) and failure annotations for an exact commit SHA or ref.',
    'atax:github:read',one('Check runs lookup',{repository:s('GitHub owner/name repository',205),ref:s('Git commit SHA or branch name',120),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','ref']),getCheckRuns),
  tool('atax_github_file_get',
    'Fetch the text contents of a file from a GitHub repository at a specific branch or commit ref without cloning target code locally.',
    'atax:github:read',one('Get file from GitHub',{repository:s('GitHub owner/name repository',205),path:s('File path in repository (e.g. src/index.ts)',1000),ref:s('Optional commit ref or branch name',120),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','path']),getFile),
  tool('atax_github_file_put',
    'Create or update a file directly on a GitHub branch via the Contents API with a commit message. Enables remote coding via GitHub without local dirty state.',
    'atax:github:create',one('Put file on GitHub',{repository:s('GitHub owner/name repository',205),path:s('File path in repository to create or update',1000),content:{type:'string',description:'File UTF-8 text content'},message:s('Git commit message',1000),branch:s('Optional target branch name (defaults to default branch)',120),sha:s('Blob SHA of the file being replaced (required when updating an existing file)',40),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','path','content','message']),putFile),
  tool('atax_github_file_put_gitdata',
    'Create or update a GitHub file through the Git Data API, including workflow files when the repository token permits repository writes. Uses an exact branch head and refuses non-fast-forward updates.',
    'atax:github:create',one('Put file via Git Data API',{repository:s('GitHub owner/name repository',205),path:s('File path in repository to create or update',1000),content:{type:'string',description:'File UTF-8 text content'},message:s('Git commit message',1000),branch:s('Target branch name (default main)',120),expected_head:s('Optional exact 40-character current commit SHA',40),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','path','content','message']),putFileGitData),
  tool('atax_github_file_delete',
    'Delete a file on a GitHub branch via the Contents API with a commit message.',
    'atax:github:create',one('Delete file on GitHub',{repository:s('GitHub owner/name repository',205),path:s('File path in repository to delete',1000),message:s('Git commit message',1000),sha:s('Blob SHA of the file being deleted',40),branch:s('Optional target branch name (defaults to default branch)',120),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','path','message','sha']),deleteFile),
  tool('atax_github_branch_create',
    'Create a new GitHub branch from an existing base branch (default main) or exact 40-character commit SHA.',
    'atax:github:create',one('Create branch on GitHub',{repository:s('GitHub owner/name repository',205),branch:s('New branch name to create',120),base:s('Base branch name to branch from (default main)',120),sha:s('Optional exact 40-character commit SHA to branch from',40),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','branch']),createBranch),
  tool('atax_github_branch_delete',
    'Delete a non-default GitHub feature branch (refuses main/master/default branch).',
    'atax:github:create',one('Delete branch on GitHub',{repository:s('GitHub owner/name repository',205),branch:s('Feature branch name to delete',120),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','branch']),deleteBranch),
  tool('atax_github_pull_request_create',
    'Open a Pull Request on GitHub for a feature branch to merge into base, recording title, description, and task reference.',
    'atax:github:create',one('Create pull request on GitHub',{repository:s('GitHub owner/name repository',205),title:s('Pull request title',300),head:s('The branch where your changes are implemented',120),base:s('The branch you want changes pulled into (default main)',120),body:s('Pull request body/description',4000),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','title','head']),createPullRequest),
  tool('atax_github_pull_request_list',
    'List Pull Requests on a GitHub repository filtered by state (open, closed, or all).',
    'atax:github:read',one('List pull requests on GitHub',{repository:s('GitHub owner/name repository',205),state:{type:'string',enum:['open','closed','all'],description:'PR state filter (default open)'},account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository']),listPullRequests),
  tool('atax_github_pull_request_merge',
    'Merge an open Pull Request on GitHub using squash, merge, or rebase.',
    'atax:github:create',one('Merge pull request on GitHub',{repository:s('GitHub owner/name repository',205),pull_number:{type:'integer',minimum:1,maximum:9007199254740991,description:'Pull request number'},merge_method:{type:'string',enum:['squash','merge','rebase'],description:'Merge method (default squash)'},commit_title:s('Optional merge commit title',300),sha:s('Optional expected head SHA for safe merge',40),account:{type:'string',maxLength:48,description:'Named GH_KEY_<ALIAS> credential'}},['repository','pull_number']),mergePullRequest),
];
