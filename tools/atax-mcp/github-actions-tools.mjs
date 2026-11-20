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
export const githubActionTools=[
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
