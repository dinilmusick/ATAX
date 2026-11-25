import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSettingsControlPlane,
  parseCookies,
} from './settingsControlPlane.ts';

type FakeState = {
  passkeyConfigured: boolean;
  validPasskey: string;
  sessionValid: boolean;
  revoked: boolean;
  createdSessionHash: string | null;
  providerCalls: Array<{name:string;params:Record<string,unknown>}>;
};

function makeFixture() {
  const state: FakeState = {
    passkeyConfigured: true,
    validPasskey: 'right-passphrase',
    sessionValid: false,
    revoked: false,
    createdSessionHash: null,
    providerCalls: [],
  };

  const ledgerFactory = async () => ({
    ping: async () => true,
    rpc: async (name: string, params: Record<string,unknown> = {}) => {
      state.providerCalls.push({name,params});
      if (name === 'atax_mcp_instance_auth_status_v1') {
        return {passkeyConfigured: state.passkeyConfigured};
      }
      if (name === 'atax_mcp_verify_instance_passkey_v1') {
        return params.passkey_in === state.validPasskey
          ? {ok:true,reason:null}
          : {ok:false,reason:'invalid'};
      }
      if (name === 'atax_mcp_create_instance_session_v1') {
        state.createdSessionHash = String(params.session_hash_in);
        state.sessionValid = true;
        return null;
      }
      if (name === 'atax_mcp_validate_instance_session_v1') {
        return state.sessionValid && !state.revoked;
      }
      if (name === 'atax_mcp_revoke_instance_session_v1') {
        state.revoked = true;
        state.sessionValid = false;
        return null;
      }
      if (name === 'atax_mcp_instance_owner_subject_v1') return 'canonical-owner';
      if (name === 'atax_mcp_provider_summary_v1') {
        return [{
          id:'a1',
          provider:'github',
          alias:'PRIMARY',
          accountId:'dinilmusick',
          enabled:true,
          createdAt:'2026-11-25T00:00:00Z',
          updatedAt:'2026-11-25T00:00:00Z',
        }];
      }
      if (name === 'atax_mcp_upsert_provider_v1') return '11111111-1111-4111-8111-111111111111';
      return null;
    },
  });

  const vaultFactory = () => ({
    listAccounts: async () => [{
      id:'a1',provider:'github',alias:'PRIMARY',accountId:'dinilmusick',
      enabled:true,createdAt:'2026-11-25T00:00:00Z',updatedAt:'2026-11-25T00:00:00Z'
    }],
    upsertSecret: async (input: Record<string,unknown>) => {
      state.providerCalls.push({name:'vault.upsertSecret',params:input});
      return {id:'a1',provider:String(input.provider),alias:String(input.alias),
        accountId:input.accountId ? String(input.accountId) : null,enabled:true};
    },
    setAccountEnabled: async (...args: unknown[]) => {
      state.providerCalls.push({name:'vault.setAccountEnabled',params:{args:args as unknown as Record<string,unknown>}});
    },
    deleteAccount: async (...args: unknown[]) => {
      state.providerCalls.push({name:'vault.deleteAccount',params:{args:args as unknown as Record<string,unknown>}});
    },
    testAccountConnection: async (...args: unknown[]) => {
      state.providerCalls.push({name:'vault.testAccountConnection',params:{args:args as unknown as Record<string,unknown>}});
      return {ok:true,provider:'github',alias:'PRIMARY',statusCode:200,
        summary:'Verified GitHub account @dinilmusick',checkedAt:'2026-11-25T00:00:00Z'};
    },
  });

  const env = {ATAX_SUPABASE_CONNECTION_URL:'postgresql://db-user:db-pass@db.vcaerawuwffziufvpbvw.supabase.co/postgres?sslmode=require'};
  const controller = createSettingsControlPlane(env, fetch, ledgerFactory, vaultFactory);
  return {controller,state};
}

function req(url:string, init:RequestInit={}) {
  return new Request(url, init);
}

test('status is structured, backend-owned, and never exposes legacy env requirements', async () => {
  const {controller} = makeFixture();
  const result = await controller.status(req('https://atax.example/api/settings/status'));
  assert.equal(result.httpStatus,200);
  assert.deepEqual(result.status.backend,{configured:true,reachable:true});
  assert.deepEqual(result.status.authentication,{required:true,authenticated:false});
  assert.deepEqual(result.status.providers,{github:true,cloudflare:true,vercel:false});
  assert.equal(JSON.stringify(result).includes('ATAX_SUPABASE_SECRET_KEY'),false);
  assert.equal(JSON.stringify(result).includes('operatorClaimed'),false);
});

test('valid passkey creates durable opaque cookie session; plaintext passkey never enters response', async () => {
  const {controller,state} = makeFixture();
  const result=await controller.unlock(
    req('https://atax.example/api/settings/auth/unlock',{method:'POST',headers:{origin:'https://atax.example'}}),
    'right-passphrase'
  );
  assert.equal(result.status,200);
  assert.deepEqual(result.body.ok,true);
  assert.equal(JSON.stringify(result.body).includes('right-passphrase'),false);
  const cookie=result.headers.get('set-cookie');
  assert.ok(cookie);
  const parsed=parseCookies(new Headers({cookie:cookie!.split(';')[0]}));
  assert.match(parsed.atax_settings_session,/^[0-9a-f]{64}$/);
  assert.equal(state.createdSessionHash?.length,64);
  assert.notEqual(state.createdSessionHash,parsed.atax_settings_session);
  assert.match(cookie!,/HttpOnly/);
  assert.match(cookie!,/Secure/);
  assert.match(cookie!,/SameSite=Strict/);
});

test('wrong passkey is rejected and never issues a session', async () => {
  const {controller,state}=makeFixture();
  const result=await controller.unlock(
    req('https://atax.example/api/settings/auth/unlock',{method:'POST',headers:{origin:'https://atax.example'}}),
    'wrong-passkey-123'
  );
  assert.equal(result.status,401);
  assert.equal(result.headers.get('set-cookie'),null);
  assert.equal(state.createdSessionHash,null);
});

test('expired or revoked session is denied; logout revokes it server-side', async () => {
  const {controller,state}=makeFixture();
  const unlock=await controller.unlock(req('https://atax.example/api/settings/auth/unlock',{method:'POST'}),'right-passphrase');
  const cookie=unlock.headers.get('set-cookie')!.split(';')[0];
  const list=await controller.listProviders(req('https://atax.example/api/settings/providers',{headers:{cookie}}));
  assert.equal(list.status,200);
  state.sessionValid=false;
  const denied=await controller.listProviders(req('https://atax.example/api/settings/providers',{headers:{cookie}}));
  assert.equal(denied.status,401);
  state.sessionValid=true;
  state.revoked=false;
  const logout=await controller.logout(req('https://atax.example/api/settings/auth/logout',{method:'POST',headers:{cookie,origin:'https://atax.example'}}));
  assert.equal(logout.status,200);
  assert.equal(state.revoked,true);
  const revoked=await controller.listProviders(req('https://atax.example/api/settings/providers',{headers:{cookie}}));
  assert.equal(revoked.status,401);
});

test('cross-origin mutation is rejected before credential persistence', async () => {
  const {controller,state}=makeFixture();
  const result=await controller.upsertProvider(
    req('https://atax.example/api/settings/providers',{method:'POST',headers:{origin:'https://evil.example'}}),
    {provider:'github',alias:'WORK',credential:'ghp_secret_value_123456789',accountId:'org'}
  );
  assert.equal(result.status,403);
  assert.equal(state.providerCalls.some(x=>x.name==='vault.upsertSecret'),false);
});

test('provider mutations never accept a browser owner subject', async () => {
  const {controller,state}=makeFixture();
  const unlock=await controller.unlock(req('https://atax.example/api/settings/auth/unlock',{method:'POST'}),'right-passphrase');
  const cookie=unlock.headers.get('set-cookie')!.split(';')[0];
  const result=await controller.upsertProvider(
    req('https://atax.example/api/settings/providers',{method:'POST',headers:{origin:'https://atax.example',cookie}}),
    {provider:'github',alias:'WORK',credential:'ghp_secret_value_123456789',accountId:'org',ownerSubject:'attacker',actorSubject:'attacker'}
  );
  assert.equal(result.status,201);
  const call=state.providerCalls.find(x=>x.name==='vault.upsertSecret');
  assert.ok(call);
  assert.equal(call.params.ownerSubject,undefined);
  assert.equal(call.params.actorSubject,undefined);
});

test('same control plane exposes only GitHub and Cloudflare as operational providers', async () => {
  const {controller}=makeFixture();
  assert.deepEqual((await controller.status(req('https://atax.example/api/settings/status'))).status.providers,
    {github:true,cloudflare:true,vercel:false});
});
