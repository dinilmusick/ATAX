import test from 'node:test';
import assert from 'node:assert/strict';
import {startPublic,statusPublic,tenantFmrlTools} from './tenant-fmrl.mjs';
const token=['tenant','github','fixture','token','notreal'].join('-');
const principal={id:'gh-101',authMethod:'byoc',scopes:new Set(['atax:fmrl:execute'])};
const env={GH_TOKEN_DEFAULT:token,MCP_PROVIDER_ACCOUNT_GRANTS:JSON.stringify({'gh-101':{github:['DEFAULT']}})};
const caller=fetcher=>({env,fetcher});
const SHA='f'.repeat(40),owner='test-user',target='public-org/repository';
function server({privateTarget=false,cleanup=true,runStatus='completed',runConclusion='success',runCount=1,declineDispatch=false}={}){
 const calls=[];
 let contract=null,workflow='',bridge='',requestId='',deleted=false;
 async function fetcher(url,opts={}){
  const path=new URL(url).pathname,method=opts.method||'GET';
  calls.push({path,method,opts});
  if(path==='/user')return Response.json({login:owner,id:101});
  if(path==='/repos/'+target)return Response.json({full_name:target,private:privateTarget,archived:false,disabled:false});
  if(path==='/repos/'+target+'/commits/'+SHA)return Response.json({sha:SHA});
  if(path==='/user/repos'&&method==='POST'){
   const body=JSON.parse(opts.body);bridge=owner+'/'+body.name;
   assert.match(body.name,/^FMRL-/);assert.equal(body.private,false);
   return Response.json({full_name:bridge,private:false,default_branch:'main'}, {status:201});
  }
  if(path==='/repos/'+bridge+'/contents/.github/workflows/atax-fmrl.yml'&&method==='PUT'){
   const body=JSON.parse(opts.body);workflow=Buffer.from(body.content,'base64').toString();
   requestId=workflow.match(/run-name: ATAX FMRL ([0-9a-f-]+)/)[1];
   return Response.json({commit:{sha:'a'.repeat(40)}},{status:201});
  }
  if(path==='/repos/'+bridge+'/contents/.fmrl/contract.json'&&method==='PUT'){
   contract=JSON.parse(Buffer.from(JSON.parse(opts.body).content,'base64').toString());
   return Response.json({commit:{sha:'b'.repeat(40)}},{status:201});
  }
  if(path==='/repos/'+bridge+'/actions/workflows/atax-fmrl.yml/dispatches'&&method==='POST'){
   return new Response(declineDispatch?'not found':null,{status:declineDispatch?404:204});
  }
  if(path==='/repos/'+bridge+'/contents/.fmrl/contract.json'&&method==='GET')
   return Response.json({encoding:'base64',content:Buffer.from(JSON.stringify(contract)).toString('base64')});
  if(path==='/repos/'+bridge+'/actions/workflows/atax-fmrl.yml/runs'&&method==='GET'){
   return Response.json({workflow_runs:Array.from({length:runCount},(_,i)=>({
    id:777+i,display_title:'ATAX FMRL '+requestId,status:runStatus,conclusion:runConclusion,
    html_url:'https://github.com/'+bridge+'/actions/runs/777'
   }))});
  }
  if(path==='/repos/'+bridge+'/actions/runs/777/jobs'&&method==='GET')
   return Response.json({jobs:[{name:'verify',status:'completed',conclusion:runConclusion}]});
  if(path==='/repos/'+bridge&&method==='DELETE'){deleted=true;return new Response(null,{status:cleanup?204:403});}
  if(path==='/repos/'+bridge&&method==='GET')return Response.json({message:'Not Found'},{
   status:deleted&&cleanup?404:200
  });
  throw Error('Unexpected Github endpoint '+method+' '+path);
 }
 return {fetcher,calls,read:()=>({contract,workflow,bridge,requestId,deleted})};
}
test('tenant public FMRL creates disposable repository, pins exact revision and dispatches',async()=>{
 const fx=server();
 const result=await startPublic({repository:target,commit_sha:SHA,confirm:true},null,principal,caller(fx.fetcher));
 assert.match(result.repository,/^test-user\/FMRL-/);
 assert.equal(result.status,'dispatch_accepted_not_executed');
 assert.equal(result.cleanup_verified,false);
 assert.equal(fx.read().contract.commit_sha,SHA);
 assert.ok(fx.read().workflow.includes('test "$(git rev-parse HEAD)" = "'+SHA+'"'));
 assert.ok(!fx.read().workflow.includes(token),'GitHub credential must not enter public workflow');
 assert.ok(fx.calls.every(c=>c.method!=='POST'||c.path!=='/repos/dinilmusick/ATAX/actions/workflows/private-repo-ci.yml/dispatches'));
});
test('terminal FMRL success requires successful tests AND confirmed public repo deletion',async()=>{
 const fx=server();const started=await startPublic({repository:target,commit_sha:SHA,confirm:true},null,principal,caller(fx.fetcher));
 const result=await statusPublic({repository:started.repository,request_id:started.request_id},null,principal,caller(fx.fetcher));
 assert.equal(result.state,'completed');assert.equal(result.verified_success,true);assert.equal(result.cleanup_verified,true);
 assert.ok(fx.read().deleted);
 assert.ok(fx.calls.some(x=>x.method==='GET'&&x.path==='/repos/'+started.repository&&!x.opts.headers.authorization),
 'Independent absence proof must omit private bearer credentials');
});
test('failed CI is reported honestly and still deletes bridge',async()=>{
 const fx=server({runConclusion:'failure'}),started=await startPublic({repository:target,commit_sha:SHA,confirm:true},null,principal,caller(fx.fetcher));
 const result=await statusPublic({repository:started.repository,request_id:started.request_id},null,principal,caller(fx.fetcher));
 assert.equal(result.verified_success,false);assert.equal(result.cleanup_verified,true);
});
test('nonterminal run stays live until external agent invokes status again',async()=>{
 const fx=server({runStatus:'in_progress'}),started=await startPublic({repository:target,commit_sha:SHA,confirm:true},null,principal,caller(fx.fetcher));
 const result=await statusPublic({repository:started.repository,request_id:started.request_id},null,principal,caller(fx.fetcher));
 assert.equal(result.cleanup_verified,false);assert.equal(result.state,'in_progress');assert.equal(fx.read().deleted,false);
});
test('cleanup failures never count as successful verification',async()=>{
 const fx=server({cleanup:false}),started=await startPublic({repository:target,commit_sha:SHA,confirm:true},null,principal,caller(fx.fetcher));
 const result=await statusPublic({repository:started.repository,request_id:started.request_id},null,principal,caller(fx.fetcher));
 assert.equal(result.verified_success,false);assert.equal(result.cleanup_verified,false);
});
test('private targets, invalid commit refs and missing confirmation fail closed',async()=>{
 const f=server({privateTarget:true});
 await assert.rejects(startPublic({repository:target,commit_sha:SHA,confirm:true},null,principal,caller(f.fetcher)),/rejects private/);
 await assert.rejects(startPublic({repository:target,commit_sha:'main',confirm:true},null,principal,caller(f.fetcher)),/exact 40-character/);
 await assert.rejects(startPublic({repository:target,commit_sha:SHA},null,principal,caller(f.fetcher)),/confirmation/);
});
test('dispatch-registration failures attempt deletion and never claim a result',async()=>{
 const f=server({declineDispatch:true});
 await assert.rejects(startPublic({repository:target,commit_sha:SHA,confirm:true},null,principal,caller(f.fetcher)),/cleanup verified/);
 assert.equal(f.read().deleted,true);
});
test('FMRL tools have separate tenant execution scope',()=>{
 assert.deepEqual(tenantFmrlTools.map(t=>t.name),['atax_fmrl_public_start','atax_fmrl_public_status']);
 assert.ok(tenantFmrlTools.every(t=>t.scope==='atax:fmrl:execute'));
});
