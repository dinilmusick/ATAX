/** Tenant-owned, disposable PUBLIC CI. Never run target code inside ATAX.
 * Private targets require a separately authorized private-target FMRL runner.
 * No provider tokens or private source are written into public repositories.
 */
import {resolveProviderAccount} from './provider-accounts.mjs';
const named=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const sha40=/^[0-9a-f]{40}$/;
const bridgeName=/^FMRL-[0-9a-f]{8}-[0-9a-f]{12}$/;
const tool=(name,description,scope,inputSchema,invoke)=>({name,description,scope,inputSchema,invoke});
const s=(description,maxLength=205)=>({type:'string',minLength:1,maxLength,description});
const schema=(props,required)=>({type:'object',properties:props,required,additionalProperties:false});
const common={account:{type:'string',maxLength:48,description:'Tenant GitHub token alias (defaults to sole account)'}};
const enc=s=>btoa(String.fromCharCode(...new TextEncoder().encode(s)));
async function github(fetcher,token,path,method='GET',body,anonymous=false){
 const response=await fetcher('https://api.github.com'+path,{method,redirect:'error',headers:{
  accept:'application/vnd.github+json','user-agent':'atax-mcp',
  ...(!anonymous?{authorization:'Bearer '+token}:{}),
  ...(body?{'content-type':'application/json'}:{})
 },...(body?{body:JSON.stringify(body)}:{})});
 if(response.status===204)return {status:204,data:null};
 if(!response.ok)return {status:response.status,data:null};
 let data;try{data=await response.json()}catch{throw Error('GitHub returned invalid JSON');}
 return {status:response.status,data};
}
function requireOk(result,message){if(result.status>=400||!result.data)throw Error(message+' (HTTP '+result.status+')');return result.data;}
function assertRepo(repo){if(typeof repo!=='string'||!named.test(repo)||repo.includes('..'))throw Error('Invalid GitHub repository');return repo;}
function accountFor(a,p,ctx){return resolveProviderAccount(ctx.env,p,'github',a.account);}
function actionYaml(repo,commit,requestId){
 const lines=[
  'name: ATAX disposable public verification',
  'run-name: ATAX FMRL '+requestId,
  'on:',
  '  workflow_dispatch:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  verify:',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 30',
  '    steps:',
  '      - name: Checkout exact public target revision',
  '        shell: bash',
  '        run: |',
  '          set -euo pipefail',
  '          git clone --filter=blob:none --no-checkout https://github.com/'+repo+'.git target',
  '          cd target',
  '          git fetch origin '+commit,
  '          git checkout --detach '+commit,
  '          test "$(git rev-parse HEAD)" = "'+commit+'"',
  '      - name: Execute public project tests',
  '        shell: bash',
  '        run: |',
  '          set -euo pipefail',
  '          cd target',
  '          if test -f Cargo.toml; then cargo test --locked',
  '          elif test -f go.mod; then go test ./...',
  '          elif test -f pnpm-lock.yaml; then corepack enable && pnpm install --frozen-lockfile && pnpm test',
  '          elif test -f package-lock.json; then npm ci && npm test',
  '          elif test -f package.json; then npm install --ignore-scripts && npm test',
  '          elif test -f pyproject.toml; then python -m unittest discover',
  '          else echo "No recognized test manifest" >&2; exit 66',
  '          fi'
 ];return lines.join('\n')+'\n';
}
async function removeBridge(fetcher,token,repository){
 const result=await github(fetcher,token,'/repos/'+repository,'DELETE');
 if(result.status!==204&&result.status!==404)throw Error('Disposable repository deletion failed (HTTP '+result.status+')');
 const proof=await github(fetcher,'','/repos/'+repository,'GET',undefined,true);
 return proof.status===404;
}
export async function startPublic(a,_db,p,ctx){
 if(a.confirm!==true)throw Error('Explicit confirmation required before disposable CI');
 const target=assertRepo(a.repository);
 if(!sha40.test(String(a.commit_sha||'')))throw Error('An exact 40-character lowercase target commit SHA is required');
 const selected=accountFor(a,p,ctx),token=selected.token;
 const user=requireOk(await github(ctx.fetcher,token,'/user'),'GitHub user lookup');
 if(!/^[A-Za-z0-9-]{1,39}$/.test(user.login)||!Number.isSafeInteger(user.id))throw Error('Invalid GitHub identity');
 if(target.toLowerCase()===(user.login+'/ATAX').toLowerCase())throw Error('ATAX itself cannot be used as a target-code runner');
 const targetInfo=requireOk(await github(ctx.fetcher,token,'/repos/'+target),'Public target lookup');
 if(targetInfo.full_name.toLowerCase()!==target.toLowerCase()||targetInfo.private!==false||targetInfo.archived||targetInfo.disabled)
  throw Error('FMRL public runner rejects private or unverified target repositories');
 const exact=requireOk(await github(ctx.fetcher,token,'/repos/'+target+'/commits/'+a.commit_sha),'Pinned commit lookup');
 if(exact.sha!==a.commit_sha)throw Error('Pinned public target revision mismatch');
 const requestId=crypto.randomUUID(),name='FMRL-'+requestId.replace(/-/g,'').slice(0,8)+'-'+requestId.replace(/-/g,'').slice(8,20);
 const repo=user.login+'/'+name;
 const created=requireOk(await github(ctx.fetcher,token,'/user/repos','POST',{
  name,private:false,auto_init:true,description:'Disposable ATAX public CI; delete after terminal result'
 }),'Disposable repository creation');
 if(created.full_name!==repo||created.private!==false)throw Error('Disposable repository identity or visibility mismatch');
 try{
  const main=created.default_branch||'main';
  if(!/^[A-Za-z0-9._/-]{1,100}$/.test(main)||main.includes('..'))throw Error('Invalid bridge branch');
  const workflow=actionYaml(target,a.commit_sha,requestId);
  const committed=requireOk(await github(ctx.fetcher,token,'/repos/'+repo+'/contents/.github/workflows/atax-fmrl.yml','PUT',{
   message:'ci: pin public target verification',branch:main,content:enc(workflow)
  }),'Disposable workflow setup');
  if(!sha40.test(committed.commit?.sha))throw Error('GitHub did not confirm workflow commit');
  const contract={request_id:requestId,target,commit_sha:a.commit_sha,workflow_commit:committed.commit.sha};
  const saved=requireOk(await github(ctx.fetcher,token,'/repos/'+repo+'/contents/.fmrl/contract.json','PUT',{
   message:'ci: record safe public CI contract',branch:main,content:enc(JSON.stringify(contract))
  }),'Disposable contract write');
  if(!sha40.test(saved.commit?.sha))throw Error('Disposable contract commit unverified');
  let accepted=false;
  for(let attempt=0;attempt<3;attempt++){
   const result=await github(ctx.fetcher,token,'/repos/'+repo+'/actions/workflows/atax-fmrl.yml/dispatches','POST',{ref:main});
   if(result.status===204){accepted=true;break;}
   if(result.status!==404&&result.status!==422)throw Error('Disposable Actions dispatch rejected (HTTP '+result.status+')');
  }
  if(!accepted)throw Error('Disposable workflow registration did not complete');
  return {request_id:requestId,repository:repo,commit_sha:a.commit_sha,workflow_commit:committed.commit.sha,
   status:'dispatch_accepted_not_executed',cleanup_verified:false,next_tool:'atax_fmrl_public_status',
   note:'External agent must poll terminal state. Cleanup is attempted on terminal status; a dispatch acknowledgment is not test success.'};
 }catch(error){
  let cleaned=false;try{cleaned=await removeBridge(ctx.fetcher,token,repo);}catch{}
  throw Error('FMRL setup failed; cleanup '+(cleaned?'verified':'UNVERIFIED')+'. '+String(error.message).slice(0,100));
 }
}
export async function statusPublic(a,_db,p,ctx){
 const selected=accountFor(a,p,ctx),token=selected.token;
 const repository=assertRepo(a.repository),requestId=String(a.request_id||'');
 const name=repository.split('/')[1];
 if(!bridgeName.test(name)||!/^[0-9a-f-]{36}$/.test(requestId))throw Error('Invalid disposable run locator');
 const identity=requireOk(await github(ctx.fetcher,token,'/user'),'GitHub identity');
 if(repository.split('/')[0]!==identity.login)throw Error('Disposable repository must belong to authenticated GitHub user');
 const encoded=requireOk(await github(ctx.fetcher,token,'/repos/'+repository+'/contents/.fmrl/contract.json'),'Disposable contract');
 if(encoded.encoding!=='base64'||typeof encoded.content!=='string')throw Error('Disposable contract encoding invalid');
 let contract;try{contract=JSON.parse(atob(encoded.content.replace(/\s/g,'')))}catch{throw Error('Invalid disposable contract')}
 if(contract.request_id!==requestId||!sha40.test(contract.commit_sha)||!named.test(contract.target))throw Error('Disposable contract mismatch');
 const runs=requireOk(await github(ctx.fetcher,token,'/repos/'+repository+'/actions/workflows/atax-fmrl.yml/runs?event=workflow_dispatch&per_page=50'),'FMRL run discovery');
 const list=(runs.workflow_runs||[]).filter(r=>r.display_title==='ATAX FMRL '+requestId||r.name==='ATAX disposable public verification');
 if(list.length!==1)return {request_id:requestId,repository,state:'awaiting_exact_run_discovery',cleanup_verified:false};
 const run=list[0];
 if(run.status!=='completed')return {request_id:requestId,repository,state:run.status||'unknown',cleanup_verified:false,run_url:run.html_url};
 const details=requireOk(await github(ctx.fetcher,token,'/repos/'+repository+'/actions/runs/'+run.id+'/jobs?per_page=100'),'FMRL jobs');
 const jobs=(details.jobs||[]).map(x=>({name:String(x.name||'').slice(0,100),status:x.status,conclusion:x.conclusion}));
 const pass=run.conclusion==='success'&&jobs.length>0&&jobs.every(j=>j.status==='completed'&&j.conclusion==='success');
 let cleaned=false;try{cleaned=await removeBridge(ctx.fetcher,token,repository);}catch{}
 return {request_id:requestId,repository,run_url:run.html_url,run_id:run.id,
  state:'completed',conclusion:run.conclusion,jobs,cleanup_verified:cleaned,verified_success:pass&&cleaned,
  note:cleaned?'Public disposable repository independently confirmed absent':'CLEANUP BLOCKER: repository absence not independently verified'};
}
export const tenantFmrlTools=[
 tool('atax_fmrl_public_start','Provision disposable public CI repository in authenticated tenant GitHub account; exact public commit, no private source/credentials. Terminal check MUST delete and independently verify 404.','atax:fmrl:execute',
 schema({...common,repository:s('Public target owner/name'),commit_sha:s('Exact lowercase Git commit SHA',40),confirm:{type:'boolean'}},['repository','commit_sha','confirm']),startPublic),
 tool('atax_fmrl_public_status','Poll disposable public GitHub Actions CI, then on terminal result delete public bridge and independently verify 404. Never treat dispatch as CI success.','atax:fmrl:execute',
 schema({...common,repository:s('Disposable repository owner/FMRL-name'),request_id:s('Exact correlation UUID',36)},['repository','request_id']),statusPublic)
];