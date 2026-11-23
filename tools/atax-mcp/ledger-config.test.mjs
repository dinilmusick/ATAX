import test from 'node:test';
import assert from 'node:assert/strict';
import {loadMcpRuntimeConfig} from './ledger-config.mjs';
const config={settings:{
  MCP_SHARED_SUBJECT:'owner',MCP_SHARED_SCOPES:'atax:read',
  MCP_SHARED_TOKEN_SHA256:'a'.repeat(64)
},accounts:[
  {provider:'github',alias:'PERSONAL',token:'github-mock-token-longer-than-16',accountId:null},
  {provider:'cloudflare',alias:'WORK',token:'cf-mock-token-longer-than-16',accountId:'acct_100'},
  {provider:'vercel',alias:'FUTURE',token:'vercel-mock-token-longer-than-16',accountId:null}
]};
const open=async ()=>({rpc:async()=>config});
test('only DB-derived policy and Vault credentials enter the MCP process',async()=>{
  const r=await loadMcpRuntimeConfig({ATAX_SUPABASE_CONNECTION_URL:'fake',
    GH_KEY_EVIL:'ignored',MCP_SHARED_SUBJECT:'ignored'},open);
  assert.equal(r.MCP_SHARED_SUBJECT,'owner');
  assert.equal(r.GH_KEY_PERSONAL,config.accounts[0].token);
  assert.equal(r.CF_KEY_WORK,config.accounts[1].token);
  assert.equal(r.CLOUDFLARE_ACCOUNT_ID_WORK,'acct_100');
  assert.equal(r.GH_KEY_EVIL,undefined);
  assert.equal(r.VERCEL_TOKEN_FUTURE,undefined);
  assert.ok(r.__ledgerDb);
});
test('malformed or malicious canonical settings fail closed',async()=>{
  for(const fake of [
    {settings:{SUPABASE_SECRET_KEY:'bad'},accounts:[]},
    {settings:{},accounts:[{provider:'github',alias:'../BAD',token:'token_long-enough'}]},
    {settings:{},accounts:[config.accounts[0],config.accounts[0]]},
    {settings:{},accounts:[{...config.accounts[0],token:'short'}]}
  ])await assert.rejects(loadMcpRuntimeConfig({},async()=>({rpc:async()=>fake})));
});
