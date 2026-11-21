import {resolveProviderAccount} from './provider-accounts.mjs';
/** GitHub Actions facade for a tenant's own token. Not a private-target code runner. */
const repoPattern=/^[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}$/;
const workflowPattern=/^[A-Za-z0-9_.-]{1,100}\.ya?ml$/;
const refPattern=/^[A-Za-z0-9._/-]{1,100}$/;
const s=(description,maxLength=200)=>({type:'string',minLength:1,maxLength,description});
const tool=(name,description,scope,inputSchema,invoke)=>({name,description,scope,inputSchema,invoke});
const one=(description,properties,required=[])=>({description,type:'object',properties,required,additionalProperties:false});
const common={repository:s('Target repository owner/name',205),account:{type:'string',maxLength:48,description:'Developer GitHub account alias'}};
function repoOf(value){
  if(!repoPattern.test(String(value||'')) || value.includes('..'))throw Error('Invalid repository');
  return value;
}
const accountFor=(args,p,ctx)=>resolveProviderAccount(ctx.env,p,'github',args.account,{legacyKey:'GITHUB_REPOSITORY_TOKEN'});
async function git(fetcher,path,token,method='GET',body){
 const response=await fetcher('https://api.github.com'+path,{method,redirect:'error',headers:{
  accept:'application/vnd.github+json',authorization:'Bearer '+token,
  'user-agent':'atax-mcp','x-github-api-version':'2022-11-28',
  ...(body?{'content-type':'application/json'}:{})
 },...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw Error('GitHub Actions request rejected (HTTP '+response.status+')');
 if(response.status===204)return null;
 try{return await response.json()}catch{throw Error('GitHub Actions returned invalid JSON')}
}
const segment=x=>encodeURIComponent(x);
async function workflowsList(a,_db,p,ctx){
 const repo=repoOf(a.repository),account=accountFor(a,p,ctx);
 const result=await git(ctx.fetcher,'/repos/'+repo+'/actions/workflows?per_page=50',account.token);
 return {repository:repo,account:account.alias,workflows:(result.workflows||[]).slice(0,50).map(x=>({
  id:x.id,name:x.name,path:x.path,state:x.state,html_url:x.html_url}))};
}
async function inspectRun(a,_db,p,ctx){
 const repo=repoOf(a.repository),account=accountFor(a,p,ctx);
 if(!Number.isSafeInteger(a.run_id)||a.run_id<1)throw Error('Invalid GitHub Actions run ID');
 const base='/repos/'+repo+'/actions/runs/'+a.run_id;
 const run=await git(ctx.fetcher,base,account.token);
 const jobInfo=await git(ctx.fetcher,base+'/jobs?per_page=50',account.token);
 return {repository:repo,account:account.alias,run_id:run.id,head_sha:run.head_sha,
  status:run.status,conclusion:run.conclusion,html_url:run.html_url,attempt:run.run_attempt,
  jobs:(jobInfo.jobs||[]).slice(0,50).map(j=>({id:j.id,name:j.name,status:j.status,conclusion:j.conclusion,
   steps:(j.steps||[]).slice(0,50).map(step=>({name:step.name,status:step.status,conclusion:step.conclusion,number:step.number}))})),
  note:'Dispatch acknowledgement does not prove CI completion; compare exact head SHA and terminal job results.'};
}
async function dispatch(a,_db,p,ctx){
 const repo=repoOf(a.repository),account=accountFor(a,p,ctx);
 if(a.confirm!==true)throw Error('Explicit confirmation required before CI dispatch');
 if(!workflowPattern.test(a.workflow))throw Error('Workflow must be a .yml or .yaml filename');
 if(!refPattern.test(a.ref)||a.ref.includes('..')||a.ref.includes('//'))throw Error('Invalid workflow ref');
 const inputs=a.inputs||{};
 if(!inputs||typeof inputs!=='object'||Array.isArray(inputs)||Object.keys(inputs).length>10)throw Error('Invalid typed workflow inputs');
 const clean={};
 for(const [k,v] of Object.entries(inputs)){
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(k)||/(token|secret|password|api.?key|credential)/i.test(k))throw Error('Unsupported CI input key');
  if(!['string','number','boolean'].includes(typeof v)||String(v).length>300)throw Error('Invalid CI input value');
  clean[k]=v;
 }
 const data=await git(ctx.fetcher,'/repos/'+repo,account.token);
 if(typeof data.full_name!=='string'||data.full_name.toLowerCase()!==repo.toLowerCase()||
    typeof data.private!=='boolean')throw Error('GitHub repository identity is not verified');
 if(data.archived===true||data.disabled===true)throw Error('GitHub repository is not available for CI');
 if(data.permissions && data.permissions.push===false && data.permissions.admin!==true)throw Error('Selected GitHub account lacks repository write permission');
 const workflow=await git(ctx.fetcher,'/repos/'+repo+'/actions/workflows/'+segment(a.workflow),account.token);
 if(workflow.state!=='active')throw Error('Selected GitHub Actions workflow is not active');
 await git(ctx.fetcher,'/repos/'+repo+'/actions/workflows/'+segment(a.workflow)+'/dispatches',
  account.token,'POST',{ref:a.ref,inputs:clean});
 return {repository:data.full_name,visibility:data.private?'private':'public',
  account:account.alias,workflow:a.workflow,ref:a.ref,
  state:'dispatch_accepted_not_executed',verification_tool:'atax_github_actions_run_status',
  execution_boundary:'GitHub Actions in the developer-owned repository, never shared ATAX Actions',
  note:'Discover matching run, verify head SHA, all jobs and any deployment result separately.'};
}

const redactDiagnostic=(text,env)=>{
 let value=String(text??'').slice(0,1200);
 for(const [key,secret] of Object.entries(env)){
  if(!/(?:^GH_TOKEN_|^CLOUDFLARE_TOKEN_|^VERCEL_TOKEN_|^SUPABASE_SECRET_KEY$)/.test(key)||
     typeof secret!=='string'||secret.length<15)continue;
  value=value.split(secret).join('[REDACTED]');
 }
 return value.replace(/Bearer\s+[^\s"'<>,]+/gi,'Bearer [REDACTED]')
   .replace(/(?:gh[pousr]_|sb_secret_)[A-Za-z0-9_=-]{12,}/g,'[REDACTED]')
   .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;'"]+/gi,'$1=[REDACTED]').slice(0,800);
};
async function checkAnnotations(a,_db,p,ctx){
 const repo=repoOf(a.repository),account=accountFor(a,p,ctx);
 if(!Number.isSafeInteger(a.check_run_id)||a.check_run_id<1)throw Error('Invalid GitHub check run ID');
 const result=await git(ctx.fetcher,'/repos/'+repo+'/check-runs/'+a.check_run_id+'/annotations?per_page=50',account.token);
 if(!Array.isArray(result))throw Error('GitHub annotations response invalid');
 return {repository:repo,account:account.alias,check_run_id:a.check_run_id,
   annotations:result.slice(0,50).map(x=>({
     path:String(x.path||'').slice(0,260),start_line:x.start_line,end_line:x.end_line,
     level:x.annotation_level,title:redactDiagnostic(x.title,ctx.env),
     message:redactDiagnostic(x.message,ctx.env)
   })),
   truncated:result.length>=50,
   note:'Annotations provide bounded compiler/test failure diagnostics; inspect full trusted logs locally if needed.'};
}

/** Explicit workflow file creation. No arbitrary updates or host-owned repository fallback.
 * The user's GitHub token must have Contents+Workflows write permissions.
 * The workflow runs in the requested repository, never inside ATAX.
 */
async function createWorkflow(a,_db,p,ctx){
 const repo=repoOf(a.repository),account=accountFor(a,p,ctx);
 if(a.confirm!==true)throw Error('Explicit confirmation required before GitHub workflow creation');
 if(!workflowPattern.test(a.workflow))throw Error('Workflow must be a .yml or .yaml filename');
 if(!refPattern.test(a.branch||'')||(a.branch||'').includes('..')||(a.branch||'').includes('//'))
   throw Error('Invalid target branch');
 const yaml=String(a.yaml||'');
 const payload=new TextEncoder().encode(yaml);
 if(payload.length<20||payload.length>24000||!/^\s*(?:name|on|run-name|permissions|jobs):/m.test(yaml))
   throw Error('Workflow must be bounded YAML');
 if(/(?:gh[pousr]_|sb_secret_)[A-Za-z0-9_=-]{12,}|-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/i.test(yaml))
   throw Error('Do not place literal credentials into workflow YAML');
 const info=await git(ctx.fetcher,'/repos/'+repo,account.token);
 if(info.full_name!==repo||typeof info.private!=='boolean'||info.archived||info.disabled)
   throw Error('GitHub repository identity unavailable for workflow creation');
 if(info.permissions&&info.permissions.push===false&&info.permissions.admin!==true)
   throw Error('GitHub account lacks repository write permission');
 const path='.github/workflows/'+a.workflow;
 const raw=btoa(Array.from(payload,x=>String.fromCharCode(x)).join(''));
 const created=await git(ctx.fetcher,'/repos/'+repo+'/contents/'+path,account.token,'PUT',
   {message:'ci: add reviewed '+a.workflow,content:raw,branch:a.branch});
 if(!created||!/^[a-f0-9]{40}$/.test(String(created.commit?.sha||'')))
   throw Error('GitHub did not confirm a workflow creation commit');
 return {repository:repo,path,commit_sha:created.commit.sha,account:account.alias,
  state:'created_pending_exact_head_verification',url:'https://github.com/'+repo+'/blob/'+encodeURIComponent(a.branch)+'/'+path,
  note:'Review exact workflow commit and run tests before trusting any execution. Secrets belong in GitHub Actions secrets, never YAML literals.'};
}
export const githubActionTools=[
 tool('atax_github_actions_workflow_create',
  'Create a reviewed GitHub Actions YAML file in the caller-authorized repository (no overwrite) after explicit confirmation. Does not run it.',
  'atax:github:workflow:write',one('Create workflow YAML',{...common,workflow:s('Workflow filename',105),
   branch:s('Existing target branch',100),yaml:s('Workflow YAML contents',24000),confirm:{type:'boolean'}},
   ['repository','workflow','branch','yaml','confirm']),createWorkflow),

 tool('atax_github_actions_check_annotations',
  'Read bounded and redacted failure annotations for a developer-owned GitHub check run (e.g. compiler and test errors).',
  'atax:github:read',one('GitHub check diagnostics',{...common,check_run_id:{type:'integer',minimum:1,description:'GitHub check run ID'}},['repository','check_run_id']),checkAnnotations),
 tool('atax_github_actions_workflows_list',
  'List available GitHub Actions workflows using the invited developer GitHub account.',
  'atax:github:read',one('Workflow discovery',common,['repository']),workflowsList),
 tool('atax_github_actions_run_status',
  'Inspect one real GitHub Actions run, exact head SHA, jobs and steps. Never treats dispatch acknowledgement as successful execution.',
  'atax:github:read',one('Exact run inspection',{...common,run_id:{type:'integer',minimum:1,description:'Known workflow run ID'}},['repository','run_id']),inspectRun),
 tool('atax_github_actions_dispatch',
  'Explicitly dispatch a workflow in an authorized GitHub repository (PUBLIC or PRIVATE) using the invited developer account. Execution occurs in that repository GitHub Actions, never ATAX.',
  'atax:github:ci',one('Confirmed workflow dispatch',{...common,workflow:s('Workflow YAML filename',105),ref:s('Git branch/tag ref',100),
   inputs:{type:'object',description:'Up to 10 primitive typed inputs; no credentials'},
   confirm:{type:'boolean',description:'Must be true after explicit user approval'}},['repository','workflow','ref','confirm']),dispatch),
];
