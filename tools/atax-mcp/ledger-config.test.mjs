import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseLedgerBootstrap,loadMcpRuntimeConfig} from './ledger-config.mjs';
import {createHandler} from './worker.mjs';

const KEY='sb_secret_'+ 'x'.repeat(40);
const URL='https://project.supabase.co/#key='+KEY;
const bearer='owner-only-bearer-that-is-long-enough';
const digest=createHash('sha256').update(bearer).digest('hex');
const settings={MCP_GITHUB_OWNER:'dinilmusick',MCP_SHARED_TOKEN_SHA256:digest,
  MCP_SHARED_SUBJECT:'test-owner',MCP_SHARED_SCOPES:'atax:read'};
const config={settings,accounts:[
  {provider:'github',alias:'PERSONAL',token:'ghp_mock_nonproduction_1234567890',accountId:null},
  {provider:'cloudflare',alias:'SECONDARY',token:'cf_mock_nonproduction_1234567890',accountId:'cloudflare1'},
  {provider:'vercel',alias:'FUTURE',token:'vc_mock_nonproduction_1234567890',accountId:null}
]};

test('one secret-bearing SUPABASE_URL is sufficient, fragments are never transmitted',async()=>{
  assert.deepEqual(parseLedgerBootstrap({SUPABASE_URL:URL}),{origin:'https://project.supabase.co',secret:KEY});
  const seen=[];
  const env=await loadMcpRuntimeConfig({SUPABASE_URL:URL,GH_KEY_EVIL:'must-not-use'},async(url,options)=>{
    seen.push({url,options});
    return Response.json(config);
  });
  assert.equal(seen.length,1);
  assert.equal(seen[0].url,'https://project.supabase.co/rest/v1/rpc/atax_mcp_runtime_config_v1');
  assert.equal(seen[0].options.headers.apikey,KEY);
  assert.ok(!seen[0].url.includes(KEY));
  assert.equal(env.GH_KEY_PERSONAL,config.accounts[0].token);
  assert.equal(env.CF_KEY_SECONDARY,config.accounts[1].token);
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID_SECONDARY,'cloudflare1');
  assert.equal(env.VERCEL_TOKEN_FUTURE,undefined);
  assert.equal(env.GH_KEY_EVIL,undefined,'legacy external variables must not leak through');
});

test('malformed, public or non-Supabase bootstrap values fail closed',()=>{
  for(const value of [
    '', 'https://project.supabase.co/', 'http://project.supabase.co/#key='+KEY,
    'https://evil.example/#key='+KEY,
    'https://project.supabase.co/?key='+KEY,
    'https://user:pass@project.supabase.co/#key='+KEY,
    'https://project.supabase.co/#key=x',
    'https://project.supabase.co/#key='+KEY+'&other=1'
  ])assert.throws(()=>parseLedgerBootstrap({SUPABASE_URL:value}));
  assert.throws(()=>parseLedgerBootstrap({SUPABASE_URL:'https://project.supabase.co/other#key='+KEY}));
});

test('unexpected settings, untrusted provider aliases, duplicate identities and large responses fail closed',async()=>{
  const bad=[
    {settings:{...settings,SUPABASE_SECRET_KEY:'overridden'},accounts:[]},
    {settings,accounts:[{provider:'github',alias:'../BAD',token:'test_secret_long_enough'}]},
    {settings,accounts:[config.accounts[0],config.accounts[0]]}
  ];
  for(const value of bad)
    await assert.rejects(loadMcpRuntimeConfig({SUPABASE_URL:URL},async()=>Response.json(value)));
  await assert.rejects(loadMcpRuntimeConfig({SUPABASE_URL:URL},async()=>new Response('x'.repeat(524289))));
  await assert.rejects(loadMcpRuntimeConfig({SUPABASE_URL:URL},async()=>new Response('{}',{status:403})));
});

test('full maintainer MCP request works with only SUPABASE_URL and ledger-stored auth policy',async()=>{
  const fetcher=async(url,opts)=>{
    if(url.endsWith('/rpc/atax_mcp_runtime_config_v1'))return Response.json({settings,accounts:[]});
    if(url.endsWith('/rpc/agent_context_overview'))return Response.json({from:'canonical-rpc'});
    throw Error('Unexpected request');
  };
  const handler=createHandler(fetcher);
  const request=(token)=>handler(new Request('https://mcp.example/mcp',{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'atax_context',arguments:{}}})
  }),{SUPABASE_URL:URL,GH_KEY_BAD:'legacy-ignored'});
  const success=await request(bearer);
  assert.equal(success.status,200);
  const payload=await success.json();
  assert.equal(payload.result.structuredContent.result.from,'canonical-rpc');
  assert.equal((await request('not-the-owner-token-1234567')).status,401);
  assert.equal((await handler(new Request('https://mcp.example/mcp',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})
  }),{SUPABASE_URL:'https://project.supabase.co/'})).status,503);
});
