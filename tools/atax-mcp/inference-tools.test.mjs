import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inferenceTools, INFERENCE_PROVIDER_IDS} from './inference-tools.mjs';
import {
  computeEffectiveWeight,
  rankWeightedAccounts,
  recordAccountUsage,
  resetAccountUsage,
  selectWeightedAccount,
} from './weighted-rotation.mjs';
import {providerTools} from './provider-accounts.mjs';

const findTool=(name)=>inferenceTools.find(x=>x.name===name);
const owner={id:'owner',authMethod:'shared'};
const outsider={id:'outsider',authMethod:'jwt'};

const baseEnv={
  MCP_SHARED_SUBJECT:'owner',
  MCP_SHARED_TOKEN_SHA256:'test-hash',
  AI_KEY_groq__GROUP_A:'groq-group-a-secret-token',
  AI_KEY_groq__GROUP_B:'groq-group-b-secret-token',
  AI_KEY_google__GROUP_A:'google-group-a-secret-token',
  AI_INFERENCE_ACCOUNTS_JSON:JSON.stringify([
    {providerId:'openrouter',alias:'GROUP_C',token:'openrouter-group-c-secret-token',weight:3},
  ]),
};

test('weighted-rotation applies usage spread, error penalty, and 429 cooldowns',()=>{
  resetAccountUsage();
  const candidates=[
    {providerId:'groq',alias:'GROUP_A',weight:1},
    {providerId:'groq',alias:'GROUP_B',weight:1},
  ];
  assert.equal(computeEffectiveWeight(candidates[0],1000),1);
  recordAccountUsage('groq','GROUP_A',{ok:true},1000);
  assert.ok(computeEffectiveWeight(candidates[0],1000)<computeEffectiveWeight(candidates[1],1000));

  recordAccountUsage('groq','GROUP_B',{ok:false,rateLimited:true},1000);
  assert.equal(computeEffectiveWeight(candidates[1],2000),0);
  assert.equal(selectWeightedAccount(candidates,0.5,2000).alias,'GROUP_A');
  assert.equal(rankWeightedAccounts(candidates,2000)[0].candidate.alias,'GROUP_A');
  resetAccountUsage();
});

test('atax_inference_providers exposes all 9 Aiko providers, apiKeyUrls, and aliases without leaking tokens',async()=>{
  resetAccountUsage();
  const res=await findTool('atax_inference_providers').invoke({},null,owner,{env:baseEnv,fetcher:fetch});
  assert.equal(res.providers.length,9);
  assert.deepEqual(res.providers.map(p=>p.providerId),INFERENCE_PROVIDER_IDS);
  const groq=res.providers.find(p=>p.providerId==='groq');
  assert.deepEqual(groq.aliases,['GROUP_A','GROUP_B']);
  assert.equal(groq.apiKeyUrl,'https://console.groq.com/keys');
  const openrouter=res.providers.find(p=>p.providerId==='openrouter');
  assert.deepEqual(openrouter.aliases,['GROUP_C']);
  assert.equal(JSON.stringify(res).includes('secret-token'),false);

  const listTool=providerTools.find(t=>t.name==='atax_provider_accounts_list');
  const safe=await listTool.invoke({},null,owner,{env:baseEnv,fetcher:fetch});
  assert.ok(Array.isArray(safe.inference));
  assert.equal(JSON.stringify(safe).includes('secret-token'),false);
});

test('atax_inference_execute rotates accounts, fails over on 429, and rejects unauthorized callers',async()=>{
  resetAccountUsage();
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url,headers:init.headers,body:JSON.parse(init.body)});
    if(init.headers.authorization==='Bearer groq-group-a-secret-token'){
      return new Response(JSON.stringify({error:'rate_limited'}),{status:429});
    }
    return Response.json({choices:[{message:{content:'Hello from failover!'}}]});
  };

  const out=await findTool('atax_inference_execute').invoke({
    providerId:'groq',
    prompt:'Say hi',
  },null,owner,{env:baseEnv,fetcher});

  assert.equal(out.providerId,'groq');
  assert.equal(out.text,'Hello from failover!');
  assert.ok(out.failoverChain.length>=1);

  await assert.rejects(
    findTool('atax_inference_execute').invoke({prompt:'Hi'},null,outsider,{env:baseEnv,fetcher}),
    /not authorized/
  );
  resetAccountUsage();
});

test('atax_inference_execute supports Google AI Studio format',async()=>{
  resetAccountUsage();
  const fetcher=async(url,init)=>{
    assert.ok(url.includes('generativelanguage.googleapis.com'));
    assert.equal(init.headers['x-goog-api-key'],'google-group-a-secret-token');
    return Response.json({candidates:[{content:{parts:[{text:'Gemini ok'}]}}]});
  };
  const out=await findTool('atax_inference_execute').invoke({
    providerId:'google',
    alias:'GROUP_A',
    prompt:'Ping',
  },null,owner,{env:baseEnv,fetcher});
  assert.equal(out.text,'Gemini ok');
  resetAccountUsage();
});
