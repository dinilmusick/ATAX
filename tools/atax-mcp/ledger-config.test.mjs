import test from 'node:test';
import assert from 'node:assert/strict';
import {loadMcpRuntimeConfig} from './ledger-config.mjs';
const config={settings:{
  MCP_SHARED_SUBJECT:'owner',MCP_SHARED_SCOPES:'atax:read',
  MCP_SHARED_TOKEN_SHA256:'a'.repeat(64)
},accounts:[
  {provider:'github',alias:'PERSONAL',token:'github-mock-token-longer-than-16',accountId:null},
  {provider:'cloudflare',alias:'WORK',token:'cf-mock-token-longer-than-16',accountId:'acct_100'},
  {provider:'vercel',alias:'FUTURE',token:'vercel-mock-token-longer-than-16',accountId:'team_200'},
  {provider:'neon',alias:'PRIMARY',token:'neon-mock-token-longer-than-16',accountId:'org-300'},
  {provider:'fly',alias:'TEAM_A',token:'fly-mock-token-longer-than-16',accountId:null},
  {provider:'groq',alias:'TEAM_A',token:'groq-mock-token-longer-than-16',accountId:null},
  {provider:'google',alias:'TEAM_A',token:'google-mock-token-longer-than-16',accountId:null},
]};
const open=async ()=>({rpc:async()=>config});
test('only DB-derived policy and Vault credentials enter the MCP process',async()=>{
  const r=await loadMcpRuntimeConfig({ATAX_SUPABASE_URL:'https://fake.supabase.co',
    ATAX_SUPABASE_SECRET_KEY:'fake-secret-key-0123456789',
    GH_KEY_EVIL:'ignored',MCP_SHARED_SUBJECT:'ignored'},open);
  assert.equal(r.MCP_SHARED_SUBJECT,'owner');
  assert.equal(r.GH_KEY_PERSONAL,config.accounts[0].token);
  assert.equal(r.CF_KEY_WORK,config.accounts[1].token);
  assert.equal(r.CLOUDFLARE_ACCOUNT_ID_WORK,'acct_100');
  assert.equal(r.VERCEL_KEY_FUTURE,config.accounts[2].token);
  assert.equal(r.VERCEL_TEAM_ID_FUTURE,'team_200');
  assert.equal(r.NEON_KEY_PRIMARY,config.accounts[3].token);
  assert.equal(r.NEON_ORG_ID_PRIMARY,'org-300');
  assert.equal(r.FRNES_KEY_fly__TEAM_A,config.accounts[4].token);
  assert.equal(r.AI_KEY_groq__TEAM_A,config.accounts[5].token);
  assert.equal(r.AI_KEY_google__TEAM_A,config.accounts[6].token);
  assert.equal(r.GH_KEY_EVIL,undefined);
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

test('restricted socket configuration cannot hydrate any maintainer provider credential',async()=>{
  const {loadSocketRuntimeConfig}=await import('./ledger-config.mjs');
  const settings={SOCKET_MODEL_ID:'unknown',SOCKET_AUTH_AUDIENCE:'task-only'};
  const open=async()=>({rpc:async name=>{
    assert.equal(name,'atax_mcp_socket_config_v1');
    return settings;
  }});
  const r=await loadSocketRuntimeConfig({},open);
  assert.deepEqual(Object.keys(r).sort(),['SOCKET_AUTH_AUDIENCE','SOCKET_MODEL_ID','__ledgerDb'].sort());
  assert.equal(r.GH_KEY_PERSONAL,undefined);
  assert.equal(r.NEON_KEY_PRIMARY,undefined);
  assert.equal(r.VERCEL_KEY_FUTURE,undefined);
  assert.equal(r.MCP_SHARED_TOKEN_SHA256,undefined);
});
