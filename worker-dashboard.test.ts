import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardWorker} from './worker-dashboard.ts';
import {handleConsentApi} from './server/oauthConsent.ts';

function fakeSettings() {
  const status = {
    backend:{configured:true,reachable:true},
    authentication:{required:true,authenticated:false},
    providers:{github:true,cloudflare:true,vercel:false},
  };
  const json = (value:unknown) => value;
  return {
    status: async () => ({status,httpStatus:200}),
    unlock: async () => ({body:{ok:true},headers:new Headers({'Set-Cookie':'atax_settings_session=test'}),status:200}),
    logout: async () => ({body:{ok:true},headers:new Headers({'Set-Cookie':'atax_settings_session=; Max-Age=0'}),status:200}),
    listProviders: async () => ({body:{accounts:[]},status:401}),
    upsertProvider: async () => ({body:{account:{id:'x'}},status:201}),
    setEnabled: async () => ({body:{ok:true},status:200}),
    deleteProvider: async () => ({body:{ok:true},status:200}),
    testProvider: async () => ({body:{ok:true,statusCode:200},status:200}),
    authenticated: async () => false,
    json,
  };
}

const worker=createDashboardWorker(()=>fakeSettings() as never);

async function assertRoute(path:string,method:string,expected:number,body?:unknown){
  const request=new Request('https://atax.example'+path,{
    method,
    headers:body?{'content-type':'application/json'}:undefined,
    body:body?JSON.stringify(body):undefined,
  });
  const response=await worker.fetch(request,{});
  assert.equal(response.status,expected,`${method} ${path}`);
}

test('production Worker settings routes are explicitly wired and never fall through to generic 404', async()=>{
  await assertRoute('/api/settings/status','GET',200);
  await assertRoute('/api/settings/auth/unlock','POST',200,{passkey:'abcdefghijkl'});
  await assertRoute('/api/settings/auth/logout','POST',200);
  await assertRoute('/api/settings/providers','GET',401);
  await assertRoute('/api/settings/providers','POST',201,{provider:'github',alias:'PRIMARY',credential:'secret-secret-secret'});
  await assertRoute('/api/settings/providers/github/PRIMARY/test','POST',200);
  await assertRoute('/api/settings/providers/github/PRIMARY/enabled','PATCH',200,{enabled:false});
  await assertRoute('/api/settings/providers/github/PRIMARY','DELETE',200);
});

test('real Worker entrypoint returns semantic backend errors instead of generic 404/401', async()=>{
  const worker = createDashboardWorker();
  const status = await worker.fetch(new Request('https://atax.example/api/settings/status'),{});
  assert.equal(status.status,503);
  const statusBody = await status.json() as {backend?:unknown};
  assert.ok(statusBody.backend);

  const providers = await worker.fetch(new Request('https://atax.example/api/settings/providers'),{});
  assert.equal(providers.status,503);
  const providersBody = await providers.json() as {error?:string};
  assert.equal(providersBody.error,'Supabase backend unavailable.');
});

test('production Worker /health reports supabase-data-api when configured and unconfigured otherwise', async()=>{
  const unconfigured = await worker.fetch(new Request('https://atax.example/health'),{});
  assert.equal(unconfigured.status,200);
  const uBody = await unconfigured.json() as {databaseTransport?:string;settings?:{routes?:boolean;authentication?:string}};
  assert.equal(uBody.databaseTransport,'unconfigured');
  assert.equal(uBody.settings?.routes,true);
  assert.equal(uBody.settings?.authentication,'instance-passkey');

  const configured = await worker.fetch(new Request('https://atax.example/health'),{
    ATAX_SUPABASE_URL:'https://vcaerawuwffziufvpbvw.supabase.co',
    ATAX_SUPABASE_SECRET_KEY:'sb_secret_test_key_0123456789abcdef',
  });
  assert.equal(configured.status,200);
  const cBody = await configured.json() as {databaseTransport?:string};
  assert.equal(cBody.databaseTransport,'supabase-data-api');
});

test('production Worker forwards OAuth discovery well-known paths to MCP handler instead of ASSETS', async()=>{
  const realWorker = createDashboardWorker();
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/openid-configuration',
  ]) {
    const res = await realWorker.fetch(new Request('https://atax.example' + path), {});
    // Unconfigured env fails closed at MCP configLoader (503 JSON), never 500 static asset error
    assert.equal(res.status, 503, path);
    const body = await res.json() as { error?: string };
    assert.equal(body.error, 'ATAX MCP not configured');
  }
});

test('production Worker /oauth/consent renders HTML and never leaks secret key', async () => {
  const realWorker = createDashboardWorker();
  const secretValue = ['sb', 'secret', 'never', 'expose', 'this'].join('_');
  const res = await realWorker.fetch(
    new Request('https://atax.example/oauth/consent?authorization_id=abc12345'),
    {
      ATAX_SUPABASE_URL: 'https://vcaerawuwffziufvpbvw.supabase.co',
      ATAX_SUPABASE_SECRET_KEY: secretValue,
    }
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /ATAX OAuth Authorization/);
  assert.match(html, /https:\/\/vcaerawuwffziufvpbvw\.supabase\.co/);
  assert.equal(html.includes(secretValue), false);
});

test('handleConsentApi proxies details and approve/deny to Supabase GoTrue with bearer token', async () => {
  const calls: Array<{ url: string; method: string; body?: string; apikey?: string; auth?: string }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method || 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      apikey: h.get('apikey') || undefined,
      auth: h.get('authorization') || undefined,
    });
    return new Response(JSON.stringify({ redirect_url: 'https://claude.ai/api/mcp/auth_callback?code=ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const env = {
    ATAX_SUPABASE_URL: 'https://vcaerawuwffziufvpbvw.supabase.co',
    ATAX_SUPABASE_SECRET_KEY: 'srv_key_123',
  };

  const detailsRes = await handleConsentApi(
    new Request('https://atax.example/api/oauth/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_jwt_abc' },
      body: JSON.stringify({ action: 'details', authorization_id: 'auth_id_12345' }),
    }),
    env,
    fakeFetch
  );
  assert.equal(detailsRes.status, 200);
  assert.equal(calls[0].url, 'https://vcaerawuwffziufvpbvw.supabase.co/auth/v1/oauth/authorizations/auth_id_12345');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].apikey, 'srv_key_123');
  assert.equal(calls[0].auth, 'Bearer user_jwt_abc');

  const approveRes = await handleConsentApi(
    new Request('https://atax.example/api/oauth/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_jwt_abc' },
      body: JSON.stringify({ action: 'approve', authorization_id: 'auth_id_12345' }),
    }),
    env,
    fakeFetch
  );
  assert.equal(approveRes.status, 200);
  assert.equal(calls[1].url, 'https://vcaerawuwffziufvpbvw.supabase.co/auth/v1/oauth/authorizations/auth_id_12345/consent');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body, JSON.stringify({ action: 'approve' }));
});
