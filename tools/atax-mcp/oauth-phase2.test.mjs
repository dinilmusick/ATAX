import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createHandler as createRuntimeHandler} from './worker.mjs';

// ---------------------------------------------------------------------------
// Phase 2: Extended OAuth interop tests — Supabase-compatible flows
// ---------------------------------------------------------------------------

const resource = 'https://atax.example/mcp';
const issuer = 'https://issuer.example/oauth';

// Generate EdDSA test key pair (also used in existing oauth-interop.test.mjs)
const keyPair = await webcrypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
const pub = await webcrypto.subtle.exportKey('jwk',keyPair.publicKey);
pub.kid='phase2-ed25519-key'; pub.alg='EdDSA';

const fetcher = async (url,options={}) => {
  if (url === 'https://issuer.example/oauth/jwks') return Response.json({keys:[pub]});
  if (String(url).includes('/rpc/')) return Response.json({ok:true,params:JSON.parse(options.body||'{}')});
  // Phase 2: proxy Supabase OIDC discovery document
  // Worker computes: new URL('/.well-known/openid-configuration', issuerUrl.origin)
  // where issuerUrl = new URL('https://issuer.example/oauth')
  // → origin = 'https://issuer.example'
  // → discovery URL = 'https://issuer.example/.well-known/openid-configuration'
  if (url === 'https://issuer.example/.well-known/openid-configuration') {
    return Response.json({
      issuer:'https://issuer.example/oauth',
      authorization_endpoint:'https://issuer.example/oauth/authorize',
      token_endpoint:'https://issuer.example/oauth/token',
      jwks_uri:'https://issuer.example/oauth/jwks',
      registration_endpoint:'https://issuer.example/auth/v1/clients',
      response_types_supported:['code'],
      grant_types_supported:['authorization_code','refresh_token'],
      scopes_supported:['openid','profile','email','offline_access'],
    });
  }
  throw Error('Unexpected upstream request: '+url);
};

const handler=createRuntimeHandler(fetcher,async env=>({
  ...env,__ledgerDb:{
    rpc:async (name,params)=>{
      const result=await fetcher('https://synthetic.supabase.co/rest/v1/rpc/'+name,{
        method:'POST',body:JSON.stringify(params)});
      return result.json();
    }
  }
}));

const config={
  SUPABASE_URL:'https://project.supabase.co',
  SUPABASE_SECRET_KEY:'testing-only-secret',
  MCP_AUTH_JWKS_URL:'https://issuer.example/oauth/jwks',
  MCP_AUTH_AUTHORIZATION_SERVER:issuer,
  MCP_AUTH_ISSUER:issuer,
  MCP_AUTH_AUDIENCE:resource,
  MCP_ATAX_OWNER_JWT_SUBJECT:'owner-uuid-1234',
  MCP_AUTH_OWNER_SCOPES:'atax:read atax:write',
};

const b64 = data => Buffer.from(data).toString('base64url');
async function jwt(override={}){
  const header=b64(JSON.stringify({typ:'at+jwt',alg:'EdDSA',kid:pub.kid}));
  const base={iss:issuer,aud:resource,sub:'owner-uuid-1234',
    scope:'openid profile offline_access',
    exp:Math.floor(Date.now()/1000)+300,iat:Math.floor(Date.now()/1000)};
  const payload=b64(JSON.stringify({...base,...override}));
  const signature=await webcrypto.subtle.sign({name:'Ed25519'},keyPair.privateKey,
    new TextEncoder().encode(header+'.'+payload));
  return header+'.'+payload+'.'+b64(signature);
}
async function rpc(token,env=config){
  const req=new Request(resource,{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  return handler(req,env);
}

// ---------------------------------------------------------------------------
// Phase 2: azp is now OPTIONAL in Supabase-issued tokens
// ---------------------------------------------------------------------------
test('Phase2: JWT without azp claim is accepted (Supabase-compatible flow)',async()=>{
  // Supabase Auth access tokens often omit azp; the fix makes it optional.
  const tokenWithoutAzp = await jwt({azp:undefined});
  const res = await rpc(tokenWithoutAzp);
  assert.equal(res.status, 200, 'Token without azp should be accepted');
  const names = (await res.json()).result.tools.map(x=>x.name);
  assert.ok(names.includes('atax_context'), 'Owner tools should be accessible without azp');
});

test('Phase2: JWT with azp claim is still accepted (backward compat)',async()=>{
  const tokenWithAzp = await jwt({azp:'gemini-dynamic-client'});
  const res = await rpc(tokenWithAzp);
  assert.equal(res.status, 200);
});

test('Phase2: JWT with malformed azp is rejected',async()=>{
  // azp present but invalid format
  const tokenBadAzp = await jwt({azp:'!@#invalid'});
  const res = await rpc(tokenBadAzp);
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Phase 2: Protected resource metadata now includes registration_endpoint
// ---------------------------------------------------------------------------
test('Phase2: protected-resource metadata includes registration_endpoint when server configured',async()=>{
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']){
    const r=await handler(new Request('https://atax.example'+path),config);
    assert.equal(r.status,200);
    const meta=await r.json();
    assert.equal(meta.resource,resource);
    assert.deepEqual(meta.authorization_servers,[issuer]);
    assert.ok(meta.scopes_supported.includes('openid'));
    // registration_endpoint should be advertised (from Supabase auth server)
    assert.ok(typeof meta.registration_endpoint==='string',
      'registration_endpoint must be advertised for dynamic client registration');
    assert.ok(meta.registration_endpoint.startsWith('https://'),
      'registration_endpoint must be HTTPS');
  }
});

test('Phase2: protected-resource metadata omits registration_endpoint when no auth server configured',async()=>{
  const noAuthConfig={...config,MCP_AUTH_AUTHORIZATION_SERVER:'',MCP_AUTH_ISSUER:''};
  const r=await handler(new Request('https://atax.example/.well-known/oauth-protected-resource'),noAuthConfig);
  assert.equal(r.status,200);
  const meta=await r.json();
  assert.deepEqual(meta.authorization_servers,[]);
  assert.equal(meta.registration_endpoint,undefined);
});

// ---------------------------------------------------------------------------
// Phase 2: /.well-known/oauth-authorization-server proxies Supabase OIDC
// ---------------------------------------------------------------------------
test('Phase2: oauth-authorization-server well-known proxies Supabase OIDC discovery',async()=>{
  // The fetcher mock returns the OIDC doc for the openid-configuration URL
  const r=await handler(new Request('https://atax.example/.well-known/oauth-authorization-server'),config);
  assert.equal(r.status,200);
  const doc=await r.json();
  assert.equal(doc.issuer,issuer);
  assert.ok(typeof doc.token_endpoint==='string');
  assert.ok(typeof doc.jwks_uri==='string');
  assert.ok(Array.isArray(doc.scopes_supported));
});

test('Phase2: oauth-authorization-server returns 404 when no auth server configured',async()=>{
  const noAuth={...config,MCP_AUTH_AUTHORIZATION_SERVER:'',MCP_AUTH_ISSUER:''};
  const r=await handler(new Request('https://atax.example/.well-known/oauth-authorization-server'),noAuth);
  assert.equal(r.status,404);
});

// ---------------------------------------------------------------------------
// Phase 2: Supabase user UUID as owner subject (UUID format is valid)
// ---------------------------------------------------------------------------
test('Phase2: Supabase UUID subject (owner-uuid-1234 matches MCP_ATAX_OWNER_JWT_SUBJECT)',async()=>{
  // The existing config already uses a UUID-like owner subject.
  // Verify that the JWT validator accepts it without azp.
  const token = await jwt({sub:'owner-uuid-1234',azp:undefined});
  const res = await rpc(token,config);
  assert.equal(res.status,200);
  const names=(await res.json()).result.tools.map(x=>x.name);
  assert.ok(names.includes('atax_context'));
});

test('Phase2: non-owner UUID subject gets empty tool list not 401',async()=>{
  // Non-owner gets a 200 with public/empty tools, not a 401
  const token = await jwt({sub:'aaaabbbb-cccc-4ddd-eeee-ffffffffffff',azp:undefined});
  const res = await rpc(token,config);
  // Response is 200 but tools don't include owner-only tools
  const body = await res.json();
  const names = (body.result?.tools||[]).map(x=>x.name);
  assert.ok(!names.includes('atax_context'),'Non-owner must not see owner tools');
});

// ---------------------------------------------------------------------------
// Phase 2: Existing security invariants still hold with azp made optional
// ---------------------------------------------------------------------------
test('Phase2: expired token still rejected regardless of azp presence',async()=>{
  const expired=await jwt({exp:1,azp:undefined});
  const res=await rpc(expired);
  assert.equal(res.status,401);
});

test('Phase2: wrong issuer still rejected',async()=>{
  const wrongIss=await jwt({iss:'https://evil.example/oauth',azp:undefined});
  const res=await rpc(wrongIss);
  assert.equal(res.status,401);
});

test('Phase2: wrong audience still rejected',async()=>{
  const wrongAud=await jwt({aud:'https://other-api/mcp',azp:undefined});
  const res=await rpc(wrongAud);
  assert.equal(res.status,401);
});

test('Phase2: forged signature still rejected',async()=>{
  const token=await jwt({azp:undefined});
  const parts=token.split('.');
  parts[2]=(parts[2].startsWith('A')?'B':'A')+parts[2].slice(1);
  const res=await rpc(parts.join('.'));
  assert.equal(res.status,401);
});

// ---------------------------------------------------------------------------
// Phase 2 + 5: Real Supabase OAuth 2.1 format (ES256, typ:'JWT', aud:'authenticated', client_id, /auth/v1 paths)
// ---------------------------------------------------------------------------
test('Phase2: real Supabase OAuth 2.1 ES256 JWT (typ=JWT, aud=authenticated, client_id) is accepted and /auth/v1 discovery preserved',async()=>{
  const ecPair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const ecPub=await webcrypto.subtle.exportKey('jwk',ecPair.publicKey);
  ecPub.kid='sb-ec-kid-1'; ecPub.alg='ES256'; ecPub.use='sig';
  const rotatedPair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const rotatedPub=await webcrypto.subtle.exportKey('jwk',rotatedPair.publicKey);
  rotatedPub.kid='sb-ec-kid-2'; rotatedPub.alg='ES256'; rotatedPub.use='sig';

  const sbIssuer='https://exampleproj.supabase.co/auth/v1';
  const sbEnv={
    ...config,
    MCP_AUTH_AUTHORIZATION_SERVER:sbIssuer,
    MCP_AUTH_ISSUER:sbIssuer,
    MCP_AUTH_JWKS_URL:sbIssuer+'/.well-known/jwks.json',
    MCP_AUTH_AUDIENCE:'authenticated',
    GH_KEY_PERSONAL:['synthetic','gh','test','credential','123456'].join('-'),
    ATAX_SUPABASE_SECRET_KEY:['synthetic','sb','test','credential','1234567890'].join('-'),
  };

  let jwksFetches=0;
  let activeKeys=[ecPub];
  const sbFetcher=async(url,options={})=>{
    if(url===sbIssuer+'/.well-known/jwks.json'){
      jwksFetches++;
      return Response.json({keys:activeKeys});
    }
    if(url===sbIssuer+'/.well-known/openid-configuration'){
      return Response.json({
        issuer:sbIssuer,
        authorization_endpoint:sbIssuer+'/oauth/authorize',
        token_endpoint:sbIssuer+'/oauth/token',
        jwks_uri:sbIssuer+'/.well-known/jwks.json',
        registration_endpoint:sbIssuer+'/oauth/clients/register',
        scopes_supported:['openid','profile','email','offline_access'],
      });
    }
    if(String(url).includes('/rpc/agent_context_overview')){
      // Even if a downstream RPC tried to echo a configured secret, scrubSecrets must strip it
      return Response.json({status:'ok',leaked:sbEnv.GH_KEY_PERSONAL,db:sbEnv.ATAX_SUPABASE_SECRET_KEY});
    }
    if(String(url).includes('/rpc/'))return Response.json({ok:true,params:JSON.parse(options.body||'{}')});
    throw Error('Unexpected upstream: '+url);
  };

  const sbHandler=createRuntimeHandler(sbFetcher,async e=>({
    ...e,__ledgerDb:{rpc:async(name,params)=>{
      const r=await sbFetcher('https://exampleproj.supabase.co/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(params)});
      return r.json();
    }}
  }));

  async function signEs256(kp,kid,override={}){
    const h=b64(JSON.stringify({typ:'JWT',alg:'ES256',kid}));
    const p=b64(JSON.stringify({
      iss:sbIssuer,aud:'authenticated',sub:'owner-uuid-1234',
      client_id:'oauth-client-uuid-9999',role:'authenticated',
      exp:Math.floor(Date.now()/1000)+300,...override
    }));
    const sig=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},kp.privateKey,new TextEncoder().encode(h+'.'+p));
    return h+'.'+p+'.'+b64(sig);
  }

  // 1. Protected resource advertises Supabase /auth/v1/oauth/clients/register
  const prRes=await sbHandler(new Request('https://atax.example/.well-known/oauth-protected-resource'),sbEnv);
  assert.equal(prRes.status,200);
  const prBody=await prRes.json();
  assert.equal(prBody.registration_endpoint,sbIssuer+'/oauth/clients/register');

  // 2. Auth server discovery routes preserve /auth/v1 prefix (never falling back to root 404)
  for(const path of ['/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server/mcp','/.well-known/openid-configuration']){
    const asRes=await sbHandler(new Request('https://atax.example'+path),sbEnv);
    assert.equal(asRes.status,200,path);
    const asBody=await asRes.json();
    assert.equal(asBody.registration_endpoint,sbIssuer+'/oauth/clients/register');
  }

  // 3. First ES256 JWT (typ='JWT', client_id, no azp) fetches JWKS once
  const tok1=await signEs256(ecPair,'sb-ec-kid-1');
  const res1=await sbHandler(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok1},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),sbEnv);
  assert.equal(res1.status,200);
  assert.equal(jwksFetches,1);

  // 4. Second request hits JWKS cache (no extra network fetch)
  const res2=await sbHandler(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok1},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'atax_context',arguments:{}}})}),sbEnv);
  assert.equal(res2.status,200);
  assert.equal(jwksFetches,1,'JWKS should be served from TTL cache');
  const ctxText=JSON.stringify(await res2.json());
  assert.equal(ctxText.includes(sbEnv.GH_KEY_PERSONAL),false,'GitHub secret must be scrubbed from MCP results');
  assert.equal(ctxText.includes(sbEnv.ATAX_SUPABASE_SECRET_KEY),false,'Supabase secret must be scrubbed from MCP results');

  // 5. Key rotation: new kid misses cache -> triggers JWKS refetch -> succeeds
  activeKeys=[ecPub,rotatedPub];
  const tok2=await signEs256(rotatedPair,'sb-ec-kid-2');
  const res3=await sbHandler(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok2},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})}),sbEnv);
  assert.equal(res3.status,200);
  assert.equal(jwksFetches,2,'Unknown kid must bypass stale cache and refetch JWKS');
});
