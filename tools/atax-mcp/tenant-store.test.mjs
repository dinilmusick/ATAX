import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,webcrypto} from 'node:crypto';
import {invite,revokeInvite,authorizeHostedPrincipal,saveConnection,listConnections,deleteConnection,scopedTenantEnvironment,hostedConfigured} from './tenant-store.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
class D1Memory{
  constructor(){this.principals=new Map();this.connections=new Map();this.audit=[];}
  prepare(sql){const db=this;let args=[];
    return {bind(...values){args=values;return this;},
      async first(){if(sql.startsWith('SELECT scopes,active'))return db.principals.get(args[0])||null;return null;},
      async all(){
        if(sql.startsWith('SELECT provider,alias,metadata'))return {results:[...db.connections.values()].filter(x=>x.subject===args[0]).map(x=>({provider:x.provider,alias:x.alias,metadata:x.metadata,updated_at:x.updated_at}))};
        if(sql.startsWith('SELECT subject,provider,alias'))return {results:[...db.connections.values()].filter(x=>x.subject===args[0])};
        if(sql.startsWith('SELECT subject,active'))return {results:[...db.principals.entries()].map(([subject,x])=>({subject,...x,updated_at:'now'}))};
        throw Error('Unknown SELECT: '+sql);
      },
      async run(){
        if(sql.startsWith('INSERT INTO atax_principals'))db.principals.set(args[0],{scopes:args[1],active:1});
        else if(sql.startsWith('DELETE FROM atax_access_keys WHERE subject=?')){ /* no invitation keys in this fixture */ }
        else if(sql.startsWith('UPDATE atax_principals')){const p=db.principals.get(args[0]);if(p)p.active=0;}
        else if(sql.startsWith('INSERT INTO atax_connections')){
          const [subject,provider,alias,ciphertext,iv,metadata]=args;
          db.connections.set([subject,provider,alias].join('|'),{subject,provider,alias,ciphertext,iv,metadata,updated_at:'now'});
        }else if(sql.startsWith('DELETE FROM atax_connections WHERE subject=? AND provider=?')){
          db.connections.delete(args.join('|'));
        }else if(sql.startsWith('DELETE FROM atax_connections WHERE subject=?')){
          for(const k of db.connections.keys())if(k.startsWith(args[0]+'|'))db.connections.delete(k);
        }else if(sql.startsWith('INSERT INTO atax_audit'))db.audit.push(args);
        else throw Error('Unknown mutation: '+sql);
        return {success:true};
      }
    };
  }
}
const vault=()=>({
  ATAX_TENANTS:new D1Memory(),MCP_MULTI_TENANT_ENABLED:'true',
  MCP_VAULT_KEY_B64:randomBytes(32).toString('base64'),
  MCP_ADMIN_SUBJECT:'admin-principal',MCP_AUTH_JWKS_URL:'https://id.example/jwks',
  MCP_AUTH_ISSUER:'https://id.example',MCP_AUTH_AUDIENCE:'atax',
  SUPABASE_URL:'https://ownersensitive.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'OWNER_SECRET_MUST_NEVER_REACH_TENANT',
  GH_TOKEN_OWNER:'OWNER_GITHUB_CREDENTIAL',CLOUDFLARE_TOKEN_OWNER:'OWNER_CF_CREDENTIAL',
  VERCEL_TOKEN_OWNER:'OWNER_VERCEL_CREDENTIAL',
});
const admin={id:'admin-principal',authMethod:'jwt',scopes:new Set(['atax:admin'])};
const user=id=>({id,authMethod:'jwt',scopes:new Set(['atax:read','atax:write','atax:github:read','atax:cloudflare:read','atax:vercel:read'])});
const inviteScopes=['atax:read','atax:write','atax:github:read','atax:cloudflare:read','atax:vercel:read'];
test('hosted JWT principals must be invited; shared tokens never qualify; administrator cannot grant admin to invitee',async()=>{
  const env=vault(); assert.equal(hostedConfigured(env),true);
  assert.equal(await authorizeHostedPrincipal(env,user('alice-principal')),null);
  assert.equal(await authorizeHostedPrincipal(env,{...user('alice-principal'),authMethod:'shared'}),null);
  await assert.rejects(invite(env,admin,{subject:'alice-principal',scopes:['atax:admin']}),/Invalid invited principal scopes/);
  await invite(env,admin,{subject:'alice-principal',scopes:inviteScopes});
  assert.deepEqual([...((await authorizeHostedPrincipal(env,user('alice-principal'))).scopes)].sort(),[...user('alice-principal').scopes].sort());
  await revokeInvite(env,admin,'alice-principal');
  assert.equal(await authorizeHostedPrincipal(env,user('alice-principal')),null);
});
test('one user credentials are AES-GCM encrypted and never inherited by another invited user',async()=>{
  const env=vault(),alice=user('alice-principal'),bob=user('other-principal');
  await invite(env,admin,{subject:alice.id,scopes:inviteScopes});
  await invite(env,admin,{subject:bob.id,scopes:inviteScopes});
  const credential=['unit','only','supabase','credential','alice','001'].join('_');
  const url='https://abcdefghijklmnopqrst.supabase.co';
  const output=await saveConnection(env,alice,{provider:'supabase',alias:'DEFAULT',url,token:credential});
  assert.deepEqual(output,{provider:'supabase',alias:'DEFAULT',metadata:{project_url:url},stored:true});
  const stored=[...env.ATAX_TENANTS.connections.values()][0];
  assert.ok(stored.ciphertext.length>30);
  assert.ok(!JSON.stringify(stored).includes(credential));
  assert.equal((await scopedTenantEnvironment(env,alice)).SUPABASE_SECRET_KEY,credential);
  const bobEnv=await scopedTenantEnvironment(env,bob);
  assert.equal(bobEnv.SUPABASE_SECRET_KEY,undefined);
  assert.equal(bobEnv.SUPABASE_URL,undefined);
  assert.equal(bobEnv.GH_TOKEN_OWNER,undefined);
  assert.equal(bobEnv.CLOUDFLARE_TOKEN_OWNER,undefined);
  assert.equal(bobEnv.VERCEL_TOKEN_OWNER,undefined);
  assert.ok(!JSON.stringify(await listConnections(env,alice)).includes(credential));
});
test('invalid Supabase URLs cannot contact arbitrary hosts; provider aliases and revoke are subject scoped',async()=>{
  const env=vault(),alice=user('alice-principal'),bob=user('other-principal');
  await invite(env,admin,{subject:alice.id,scopes:inviteScopes});
  await invite(env,admin,{subject:bob.id,scopes:inviteScopes});
  for(const url of ['https://127.0.0.1','http://abcdefghijklmnopqrst.supabase.co','https://abcdefghijklmnopqrst.supabase.co.evil.com','https://evil@abcdefghijklmnopqrst.supabase.co','https://abcdefghijklmnopqrst.supabase.co/rest/v1']){
    await assert.rejects(saveConnection(env,alice,{provider:'supabase',url,token:['unit','only','invalid','url','credential','001'].join('_')}),/Supabase URL/);
  }
  const gh=['unit','github','alice','credential','only','01'].join('_');
  const fetcher=async(url,init)=>{assert.equal(url,'https://api.github.com/user');assert.equal(init.headers.authorization,'Bearer '+gh);return Response.json({login:'alice'});};
  await saveConnection(env,alice,{provider:'github',alias:'WORK',token:gh},fetcher);
  assert.deepEqual((await scopedTenantEnvironment(env,alice)).MCP_GITHUB_OWNER_WORK,'alice');
  assert.equal((await scopedTenantEnvironment(env,bob)).GH_TOKEN_WORK,undefined);
  const list=(await listConnections(env,alice)).connections;
  assert.equal(list.length,1);assert.deepEqual(list[0].metadata,{github_owner:'alice'});
  await deleteConnection(env,bob,'github','WORK');
  assert.equal((await listConnections(env,alice)).connections.length,1);
  await deleteConnection(env,alice,'github','WORK');
  assert.equal((await listConnections(env,alice)).connections.length,0);
  assert.equal(env.ATAX_TENANTS.audit.some(x=>x[1]==='credential_delete'),true);
});
test('encrypted ciphertext bound to subject, provider and alias; authentication grant cannot exceed invitation',async()=>{
  const env=vault(),alice=user('alice-principal'),bob=user('other-principal');
  await invite(env,admin,{subject:alice.id,scopes:['atax:read']});
  await invite(env,admin,{subject:bob.id,scopes:inviteScopes});
  const p=await authorizeHostedPrincipal(env,alice);
  assert.deepEqual([...p.scopes],['atax:read']);
  await saveConnection(env,alice,{provider:'cloudflare',alias:'WORK',token:['unit','cloudflare','test','credential','not','real'].join('_'),account_id:'38bdf043bc4cb132cfc22b13d597ca2e'});
  const stored=[...env.ATAX_TENANTS.connections.values()][0];
  env.ATAX_TENANTS.connections.set('other-principal|cloudflare|WORK',{...stored,subject:'other-principal'});
  await assert.rejects(scopedTenantEnvironment(env,bob),/Credential decryption failed/);
});
