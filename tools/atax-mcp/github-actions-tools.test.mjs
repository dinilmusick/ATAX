import test from 'node:test';
import assert from 'node:assert/strict';
import {githubActionTools} from './github-actions-tools.mjs';
const principal={id:'tenant-user',authMethod:'jwt'};
const env={MCP_PROVIDER_ACCOUNT_GRANTS:JSON.stringify({'tenant-user':{github:['WORK']}}),MCP_SHARED_SUBJECT:'disabled',
 GH_TOKEN_WORK:['fixture','github','actions','token','safe'].join('_'),MCP_MULTI_TENANT_ENABLED:'true'};
const invoke=(name,args,fetcher)=>githubActionTools.find(t=>t.name===name).invoke(args,null,principal,{env,fetcher});
test('GitHub Actions uses only invited account, returns exact SHA and bounded job conclusions',async()=>{
 const called=[];
 const fetcher=async(url,config={})=>{
  called.push({url,config});
  if(url.endsWith('/actions/workflows?per_page=50'))return Response.json({workflows:[{id:12,name:'build',path:'.github/workflows/build.yml',state:'active',html_url:'https://github.com/org/app/actions'}]});
  if(url.endsWith('/actions/runs/7/jobs?per_page=50'))return Response.json({jobs:[{id:22,name:'CI',status:'completed',conclusion:'success',steps:[{name:'tests',status:'completed',conclusion:'success',number:1}],private_key:'NEVER_RETURN'}]});
  if(url.endsWith('/actions/runs/7'))return Response.json({id:7,status:'completed',conclusion:'success',head_sha:'f'.repeat(40),run_attempt:2,html_url:'https://github.com/org/app/actions/runs/7'});
  throw Error('Unexpected GitHub request: '+url);
 };
 const list=await invoke('atax_github_actions_workflows_list',{account:'WORK',repository:'org/app'},fetcher);
 assert.equal(list.workflows[0].name,'build');
 const run=await invoke('atax_github_actions_run_status',{account:'WORK',repository:'org/app',run_id:7},fetcher);
 assert.equal(run.head_sha,'f'.repeat(40));assert.equal(run.jobs[0].conclusion,'success');
 assert.ok(!JSON.stringify(run).includes('NEVER_RETURN'));
 assert.ok(called.every(r=>r.config.headers.authorization==='Bearer '+env.GH_TOKEN_WORK));
});
test('Dispatch demands explicit intent, public repo, safe typed inputs and returns only acknowledgement',async()=>{
 const observed=[];
 const fetcher=async(url,options={})=>{
  observed.push({url,options});
  if(url==='https://api.github.com/repos/org/app')return Response.json({private:false});
  if(url.endsWith('/actions/workflows/test.yml'))return Response.json({id:4,state:'active'});
  if(url.endsWith('/dispatches'))return new Response(null,{status:204});
  throw Error('Unexpected request: '+url);
 };
 const base={repository:'org/app',account:'WORK',workflow:'test.yml',ref:'main',inputs:{target:'release',debug:false}};
 await assert.rejects(invoke('atax_github_actions_dispatch',base,fetcher),/confirmation required/);
 await assert.rejects(invoke('atax_github_actions_dispatch',{...base,confirm:true,inputs:{api_key:'unsafe'}},fetcher),/Unsupported CI input key/);
 const result=await invoke('atax_github_actions_dispatch',{...base,confirm:true},fetcher);
 assert.equal(result.state,'dispatch_accepted_not_executed');
 const posted=observed.find(x=>x.url.endsWith('/dispatches'));
 assert.deepEqual(JSON.parse(posted.options.body),{ref:'main',inputs:base.inputs});
 await assert.rejects(invoke('atax_github_actions_dispatch',{...base,confirm:true},async()=>Response.json({private:true})),/Private-target Actions are disabled/);
});
