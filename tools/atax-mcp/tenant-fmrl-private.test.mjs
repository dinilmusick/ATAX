import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateFmrl,tenantPrivateFmrlTools} from './tenant-fmrl-private.mjs';
const secret=['tenant','access','token','notreal'].join('_');
const principal={id:'gh-101',authMethod:'byoc'};
const env={GH_TOKEN_DEFAULT:secret,MCP_PROVIDER_ACCOUNT_GRANTS:JSON.stringify({'gh-101':{github:['DEFAULT']}})};
const params={repository:'member/private-workspace',branch:'main',confirm:true};
function fixture({privateRepo=true,defaultBranch='main',write=true,conflict=false}={}){
 const recorded=[];
 async function fetcher(url,opts={}){
  recorded.push({url,opts});
  if(url.endsWith('/repos/member/private-workspace')){
   return Response.json({full_name:'member/private-workspace',private:privateRepo,
    default_branch:defaultBranch,archived:false,disabled:false,permissions:{push:write}});
  }
  if(url.endsWith('/repos/member/private-workspace/contents/.github/workflows/atax-tenant-private-fmrl.yml')){
   return conflict?Response.json({message:'already exists'},{status:422}):
    Response.json({commit:{sha:'c'.repeat(40)}},{status:201});
  }
  throw Error('Unexpected GitHub request: '+url);
 }
 return {recorded,fetcher};
}
test('private-target FMRL workflow is installed exclusively in owner private GitHub repo',async()=>{
 const f=fixture();
 const r=await createPrivateFmrl(params,null,principal,{env,fetcher:f.fetcher});
 assert.equal(r.state,'installed_not_executed');
 assert.equal(r.verified,false);
 assert.equal(r.required_github_secrets.length,4);
 assert.equal(r.commit_sha,'c'.repeat(40));
 const write=f.recorded.find(x=>(x.opts.method||'GET')==='PUT');
 assert.equal(write.opts.headers.authorization,'Bearer '+secret);
 const body=JSON.parse(write.opts.body);
 assert.equal(body.sha,undefined,'No overwrites without separate user review');
 const yaml=Buffer.from(body.content,'base64').toString();
 assert.ok(yaml.includes('repository: dinilmusick/ATAX'));
 assert.ok(yaml.includes('ref: '+r.atax_script_sha));
 assert.ok(yaml.includes('python3 tools/github/disposable_workspace.py'));
 assert.ok(yaml.includes('private FMRL')||yaml.includes('private FMRL'.toLowerCase()));
 assert.ok(yaml.includes('python3 tools/github/repository_lifecycle.py delete'));
 assert.ok(yaml.includes("if: always() && steps.bridge.outputs.repository != ''"));
 assert.ok(yaml.includes('ATAX_FMRL_ACTIONS_SECRET_TOKEN'));
 assert.ok(!yaml.includes(secret),'User bearer must never be committed');
 assert.ok(yaml.includes('GH_TOKEN: $'+'{{ secrets.ATAX_FMRL_ACTIONS_DISPATCH_TOKEN }}'));
 assert.ok(yaml.includes('target_sha:'));
 assert.ok(yaml.includes('options: [direct, act]'));
});
test('private FMRL refuses public targets, wrong branch, missing confirmation and overwrites',async()=>{
 await assert.rejects(createPrivateFmrl({...params,confirm:false},null,principal,{env,fetcher:fixture().fetcher}),/confirmation/);
 await assert.rejects(createPrivateFmrl(params,null,principal,{env,fetcher:fixture({privateRepo:false}).fetcher}),/private repository/);
 await assert.rejects(createPrivateFmrl(params,null,principal,{env,fetcher:fixture({defaultBranch:'release'}).fetcher}),/default branch/);
 await assert.rejects(createPrivateFmrl(params,null,principal,{env,fetcher:fixture({write:false}).fetcher}),/permission/);
 await assert.rejects(createPrivateFmrl(params,null,principal,{env,fetcher:fixture({conflict:true}).fetcher}),/HTTP 422/);
});
test('tenant FMRL private workflow tool exposes only non-secret parameters',()=>{
 const [tool]=tenantPrivateFmrlTools;
 assert.equal(tool.name,'atax_fmrl_private_workflow_create');
 assert.equal(tool.scope,'atax:github:workflow:write');
 assert.deepEqual(Object.keys(tool.inputSchema.properties),['repository','branch','account','confirm']);
});
