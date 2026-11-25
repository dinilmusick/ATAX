import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardWorker} from './worker-dashboard.ts';

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
