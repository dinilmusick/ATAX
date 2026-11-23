import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createHandler as createRuntimeHandler} from './worker.mjs';

const resource = 'https://atax.example/mcp';
const issuer = 'https://issuer.example/oauth';
const keyPair = await webcrypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
const pub = await webcrypto.subtle.exportKey('jwk',keyPair.publicKey);
pub.kid='generic-ed25519-key'; pub.alg='EdDSA';
const fetcher = async (url,options={}) => {
  if (url === 'https://issuer.example/oauth/jwks')return Response.json({keys:[pub]});
  if (String(url).includes('/rpc/'))return Response.json({ok:true,params:JSON.parse(options.body||'{}')});
  throw Error('Unexpected upstream request');
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
  MCP_ATAX_OWNER_JWT_SUBJECT:'owner-1',
  MCP_AUTH_OWNER_SCOPES:'atax:read atax:write',
};
const b64 = data => Buffer.from(data).toString('base64url');
async function jwt(override={}){
  const header=b64(JSON.stringify({typ:'at+jwt',alg:'EdDSA',kid:pub.kid}));
  const payload=b64(JSON.stringify({iss:issuer,aud:resource,sub:'owner-1',azp:'gemini-client-registered',scope:'openid profile offline_access',exp:Math.floor(Date.now()/1000)+300,iat:Math.floor(Date.now()/1000),...override}));
  const signature=await webcrypto.subtle.sign({name:'Ed25519'},keyPair.privateKey,new TextEncoder().encode(header+'.'+payload));
  return header+'.'+payload+'.'+b64(signature);
}
async function rpc(token,env=config){
  const request=new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  return handler(request,env);
}

test('OAuth resource metadata is public and supports both well-known paths',async()=>{
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']){
    const r=await handler(new Request('https://atax.example'+path),config);
    assert.equal(r.status,200);
    const metadata=await r.json();
    assert.equal(metadata.resource,resource);
    assert.deepEqual(metadata.authorization_servers,[issuer]);
    assert.ok(metadata.scopes_supported.includes('openid'));
  }
});

test('MCP 401 challenge advertises path-specific metadata',async()=>{
  const r=await handler(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),config);
  assert.equal(r.status,401);
  assert.match(r.headers.get('www-authenticate'),/\.well-known\/oauth-protected-resource\/mcp/);
});

test('Provider-neutral EdDSA resource audience and owner policy unlock only the pinned identity',async()=>{
  const accepted=await rpc(await jwt());
  assert.equal(accepted.status,200);
  const names=(await accepted.json()).result.tools.map(x=>x.name);
  assert.ok(names.includes('atax_context'));
  assert.ok(names.includes('atax_task_claim_next'));
  assert.ok(!names.includes('atax_verification_claim'));
  const other=await rpc(await jwt({sub:'other-user'}));
  const otherNames=(await other.json()).result.tools.map(x=>x.name);
  assert.ok(!otherNames.includes('atax_context'));
  const noPolicy=await rpc(await jwt(),{...config,MCP_AUTH_OWNER_SCOPES:''});
  const noPolicyNames=(await noPolicy.json()).result.tools.map(x=>x.name);
  assert.ok(!noPolicyNames.includes('atax_context'));
  const incorrectAudience=await rpc(await jwt({aud:'https://some-other-api/mcp'}));
  assert.equal(incorrectAudience.status,401);
  const missingClient=await rpc(await jwt({azp:undefined}));
  assert.equal(missingClient.status,401);
  const expired=await rpc(await jwt({exp:1}));
  assert.equal(expired.status,401);
  const parts=(await jwt()).split('.');
  parts[2]=(parts[2].startsWith('A')?'B':'A')+parts[2].slice(1);
  const forged=await rpc(parts.join('.'));
  assert.equal(forged.status,401);
});

test('independent verification cannot be conferred by read/write owner OAuth policy',async()=>{
  const res=await rpc(await jwt());
  const names=(await res.json()).result.tools.map(x=>x.name);
  assert.ok(!names.includes('atax_verification_submit'));
  assert.ok(!names.includes('atax_verification_claim'));
});

test('same owner across OAuth clients uses identical substrate identity and fenced claims',async()=>{
  const args={jsonrpc:'2.0',id:101,method:'tools/call',params:{name:'atax_task_claim_next',arguments:{capabilities:['backend'],lease_seconds:300}}};
  const call=async(token)=>handler(new Request(resource,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(args)}),config);
  const clientA=await (await call(await jwt({azp:'oauth-client-a'}))).json();
  const clientB=await (await call(await jwt({azp:'oauth-client-b'}))).json();
  const first=clientA.result.structuredContent.result.params.agent_id_in;
  const second=clientB.result.structuredContent.result.params.agent_id_in;
  assert.equal(first,'owner-1');
  assert.equal(second,'owner-1');
  const unauthorized=await (await call(await jwt({sub:'someone-else'}))).json();
  assert.equal(unauthorized.result.isError,true);
});
