import test from 'node:test';
import assert from 'node:assert/strict';
import {createBootstrap,tenantBootstrapTools} from './tenant-bootstrap.mjs';
const token=['github','tenant','test','notreal'].join('_');
const principal={id:'gh-101',authMethod:'byoc',scopes:new Set(['atax:github:workflow:write'])};
const env={GH_TOKEN_DEFAULT:token,MCP_PROVIDER_ACCOUNT_GRANTS:JSON.stringify({'gh-101':{github:['DEFAULT']}})};
function mock({branch='main',permission=true,createStatus=201}={}){
 const calls=[];
 async function fetcher(url,options={}){
  calls.push({url,options});
  if(url.endsWith('/repos/my-user/bootstrap'))
   return Response.json({full_name:'my-user/bootstrap',default_branch:branch,private:true,permissions:{push:permission}});
  if(url.endsWith('/repos/my-user/bootstrap/contents/.github/workflows/atax-tenant-bootstrap.yml'))
   return createStatus===201?Response.json({commit:{sha:'f'.repeat(40)}},{status:201}):
    Response.json({message:'Already exists'},{status:createStatus});
  throw Error('Unexpected endpoint: '+url);
 }
 return {fetcher,calls};
}
const inputs={repository:'my-user/bootstrap',branch:'main',confirm:true};
test('tenant-owned bootstrap workflow is immutable and requires only private GitHub secret',async()=>{
 const m=mock();
 const result=await createBootstrap(inputs,null,principal,{env,fetcher:m.fetcher});
 assert.equal(result.state,'installed_not_executed');
 assert.equal(result.verified,false);
 assert.equal(result.required_secret,'ATAX_BOOTSTRAP_DATABASE_URL');
 assert.equal(result.schema_sha.length,40);
 const put=m.calls.find(x=>x.options.method==='PUT');
 assert.ok(put);
 assert.equal(put.options.headers.authorization,'Bearer '+token);
 const payload=JSON.parse(put.options.body);
 assert.equal(payload.sha,undefined,'Must not silently overwrite existing workflow');
 const yaml=Buffer.from(payload.content,'base64').toString();
 assert.ok(yaml.includes('supabase db push --remote="$ATAX_BOOTSTRAP_DATABASE_URL" --yes'));
 assert.ok(yaml.includes('ref: '+result.schema_sha));
 assert.ok(yaml.includes('supabase/setup-cli@689adcfb80d947100a1eab127289b97d1fb07b13'));
 assert.ok(!yaml.includes(token));
 assert.ok(!yaml.includes('d182e89a590a088bebd3aa18add8891ad3001fb2?'));
});
test('bootstrap refuses missing confirmation, non-default branches and unauthorized writes',async()=>{
 const m=mock();
 await assert.rejects(createBootstrap({...inputs,confirm:false},null,principal,{env,fetcher:m.fetcher}),/confirmation/);
 const other=mock({branch:'production'});
 await assert.rejects(createBootstrap(inputs,null,principal,{env,fetcher:other.fetcher}),/default branch/);
 const forbidden=mock({permission:false});
 await assert.rejects(createBootstrap(inputs,null,principal,{env,fetcher:forbidden.fetcher}),/permission/);
 const exists=mock({createStatus:422});
 await assert.rejects(createBootstrap(inputs,null,principal,{env,fetcher:exists.fetcher}),/HTTP 422/);
});
test('bootstrap has independent scoped tool contract without accepting SQL or secrets',()=>{
 const [tool]=tenantBootstrapTools;
 assert.equal(tool.name,'atax_supabase_bootstrap_workflow_create');
 assert.equal(tool.scope,'atax:github:workflow:write');
 assert.equal(Object.keys(tool.inputSchema.properties).join(','),'repository,branch,account,confirm');
});
