import {openLedger} from '../tools/atax-mcp/data-api-ledger.mjs';
import {createVaultService, inspectSupabaseConnection, VaultError} from './supabaseVault.ts';

export const SETTINGS_SESSION_COOKIE = 'atax_settings_session';
export const SETTINGS_SESSION_TTL_SECONDS = 30 * 60;

export interface SettingsStatus {
  backend: {configured: boolean; reachable: boolean};
  authentication: {required: true; authenticated: boolean};
  providers: {github: boolean; cloudflare: boolean; vercel: false};
}

function headerValue(headers: Headers | Record<string,string|undefined>, key: string): string | null {
  if (headers instanceof Headers) return headers.get(key);
  return headers[key] ?? headers[key.toLowerCase()] ?? null;
}

export function sameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function parseCookies(headers: Headers): Record<string,string> {
  const raw=headers.get('cookie') || '';
  const result: Record<string,string>={};
  for(const piece of raw.split(';')){
    const idx=piece.indexOf('=');
    if(idx<0) continue;
    const key=piece.slice(0,idx).trim();
    const value=piece.slice(idx+1).trim();
    if(key) result[key]=decodeURIComponent(value);
  }
  return result;
}

function randomToken(): string {
  const bytes=new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}

function cookieHeader(token: string, maxAge: number): string {
  return `${SETTINGS_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function backendUnavailableStatus(message?: string): SettingsStatus {
  return {
    backend:{configured:false,reachable:false},
    authentication:{required:true,authenticated:false},
    providers:{github:true,cloudflare:true,vercel:false},
  };
}

export type LedgerFactory = (env: Record<string,string|undefined>) => Promise<any>;
export type VaultFactory = (env: Record<string,string|undefined>, fetcher: typeof fetch) => any;

export function createSettingsControlPlane(
  env: Record<string,string|undefined>,
  fetcher: typeof fetch = fetch,
  ledgerFactory: LedgerFactory = openLedger,
  vaultFactory: VaultFactory = createVaultService,
) {
  const vault=vaultFactory(env,fetcher);

  async function db() {
    const inspection=inspectSupabaseConnection(env);
    if(!inspection.configured) throw new VaultError(inspection.error || 'Supabase backend is not configured.',503);
    return ledgerFactory(env);
  }

  async function sessionHashFromRequest(request: Request): Promise<string | null> {
    const cookies=parseCookies(request.headers);
    const token=cookies[SETTINGS_SESSION_COOKIE];
    if(!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    return sha256Hex(token);
  }

  async function authenticated(request: Request): Promise<boolean> {
    const hash=await sessionHashFromRequest(request);
    if(!hash) return false;
    try{
      const connection=await db();
      return Boolean(await connection.rpc('atax_mcp_validate_instance_session_v1',{session_hash_in:hash}));
    }catch{
      return false;
    }
  }

  async function status(request: Request): Promise<{status: SettingsStatus; httpStatus: number}> {
    const inspection=inspectSupabaseConnection(env);
    if(!inspection.configured){
      return {
        status:{
          ...backendUnavailableStatus(),
          backend:{configured:false,reachable:false},
        },
        httpStatus:503,
      };
    }
    try{
      const connection=await db();
      await connection.ping();
      const authState=await connection.rpc('atax_mcp_instance_auth_status_v1',{});
      const authConfigured=Boolean((authState as Record<string,unknown>|null)?.passkeyConfigured);
      const isAuthenticated=await authenticated(request);
      if(!authConfigured){
        return {
          status:{
            backend:{configured:true,reachable:true},
            authentication:{required:true,authenticated:false},
            providers:{github:true,cloudflare:true,vercel:false},
          },
          httpStatus:200,
        };
      }
      return {
        status:{
          backend:{configured:true,reachable:true},
          authentication:{required:true,authenticated:isAuthenticated},
          providers:{github:true,cloudflare:true,vercel:false},
        },
        httpStatus:200,
      };
    }catch{
      return {
        status:{
          backend:{configured:true,reachable:false},
          authentication:{required:true,authenticated:false},
          providers:{github:true,cloudflare:true,vercel:false},
        },
        httpStatus:503,
      };
    }
  }

  async function unlock(request: Request, passkey: string): Promise<{body:Record<string,unknown>; headers:Headers; status:number}> {
    if(!sameOriginRequest(request)) return {body:{error:'Cross-origin request rejected.'},headers:new Headers(),status:403};
    if(typeof passkey!=='string'||passkey.length<12||passkey.length>256)
      return {body:{error:'Invalid passkey.'},headers:new Headers(),status:400};
    try{
      const connection=await db();
      const result=await connection.rpc('atax_mcp_verify_instance_passkey_v1',{passkey_in:passkey}) as {ok?:boolean;reason?:string}|null;
      if(!result?.ok){
        const reason=result?.reason;
        if(reason==='unconfigured') return {body:{error:'Instance passkey is not initialized.'},headers:new Headers(),status:503};
        if(reason==='locked') return {body:{error:'Passkey temporarily locked.'},headers:new Headers(),status:429};
        return {body:{error:'Invalid passkey.'},headers:new Headers(),status:401};
      }
      const rawToken=randomToken();
      const hash=await sha256Hex(rawToken);
      const expiresAt=new Date(Date.now()+SETTINGS_SESSION_TTL_SECONDS*1000).toISOString();
      await connection.rpc('atax_mcp_create_instance_session_v1',{session_hash_in:hash,expires_at_in:expiresAt});
      const headers=new Headers();
      headers.set('Set-Cookie',cookieHeader(rawToken,SETTINGS_SESSION_TTL_SECONDS));
      return {body:{ok:true,authenticated:true,expiresAt},headers,status:200};
    }catch(err){
      if(err instanceof VaultError) {
        return {body:{error:err.message},headers:new Headers(),status:err.statusCode};
      }
      return {body:{error:'Supabase backend unavailable.'},headers:new Headers(),status:503};
    }
  }

  async function logout(request: Request): Promise<{body:Record<string,unknown>;headers:Headers;status:number}> {
    if(!sameOriginRequest(request)) return {body:{error:'Cross-origin request rejected.'},headers:new Headers(),status:403};
    const hash=await sessionHashFromRequest(request);
    if(hash){
      try{ const connection=await db(); await connection.rpc('atax_mcp_revoke_instance_session_v1',{session_hash_in:hash}); }
      catch{}
    }
    const headers=new Headers();
    headers.set('Set-Cookie',cookieHeader('',0));
    return {body:{ok:true},headers,status:200};
  }

  async function requireSession(request: Request): Promise<{ok:true}|{ok:false;status:number;error:string}> {
    let connection: Awaited<ReturnType<LedgerFactory>>;
    try {
      connection = await db();
    } catch (err) {
      const status = err instanceof VaultError ? err.statusCode : 503;
      return {ok:false,status,error:'Supabase backend unavailable.'};
    }

    const hash = await sessionHashFromRequest(request);
    if (!hash) return {ok:false,status:401,error:'Instance authentication required.'};

    try {
      const valid = Boolean(await connection.rpc('atax_mcp_validate_instance_session_v1',{session_hash_in:hash}));
      if (!valid) return {ok:false,status:401,error:'Instance authentication required.'};
      return {ok:true};
    } catch {
      return {ok:false,status:503,error:'Supabase backend unavailable.'};
    }
  }

  async function listProviders(request: Request) {
    const auth=await requireSession(request);
    if(!auth.ok) return {body:{error:auth.error},status:auth.status};
    try{return {body:{accounts:await vault.listAccounts()},status:200};}
    catch(err){return {body:{error:err instanceof Error?err.message:'Provider registry unavailable.'},status:err instanceof VaultError?err.statusCode:502};}
  }

  async function upsertProvider(request: Request, body: Record<string,unknown>) {
    if(!sameOriginRequest(request)) return {body:{error:'Cross-origin mutation rejected.'},status:403};
    const auth=await requireSession(request);
    if(!auth.ok) return {body:{error:auth.error},status:auth.status};
    try{
      const saved=await vault.upsertSecret({
        provider:String(body.provider||''),
        alias:String(body.alias||''),
        credential:String(body.credential||''),
        accountId:body.accountId==null?null:String(body.accountId),
        enabled:body.enabled!==false,
      });
      return {body:{account:saved},status:201};
    }catch(err){return {body:{error:err instanceof Error?err.message:'Failed to store provider credential.'},status:err instanceof VaultError?err.statusCode:502};}
  }

  async function setEnabled(request: Request, provider: string, alias: string, enabled: unknown) {
    if(!sameOriginRequest(request)) return {body:{error:'Cross-origin mutation rejected.'},status:403};
    const auth=await requireSession(request);
    if(!auth.ok) return {body:{error:auth.error},status:auth.status};
    if(typeof enabled!=='boolean') return {body:{error:'Boolean enabled field is required.'},status:400};
    try{await vault.setAccountEnabled(undefined,provider,alias,enabled);return {body:{ok:true},status:200};}
    catch(err){return {body:{error:err instanceof Error?err.message:'Failed to update provider state.'},status:err instanceof VaultError?err.statusCode:502};}
  }

  async function deleteProvider(request: Request, provider: string, alias: string) {
    if(!sameOriginRequest(request)) return {body:{error:'Cross-origin mutation rejected.'},status:403};
    const auth=await requireSession(request);
    if(!auth.ok) return {body:{error:auth.error},status:auth.status};
    try{await vault.deleteAccount(undefined,provider,alias);return {body:{ok:true},status:200};}
    catch(err){return {body:{error:err instanceof Error?err.message:'Failed to delete provider credential.'},status:err instanceof VaultError?err.statusCode:502};}
  }

  async function testProvider(request: Request, provider: string, alias: string) {
    const auth=await requireSession(request);
    if(!auth.ok) return {body:{error:auth.error},status:auth.status};
    try{return {body:await vault.testAccountConnection(undefined,provider,alias),status:200};}
    catch(err){return {body:{error:err instanceof Error?err.message:'Provider test failed.'},status:err instanceof VaultError?err.statusCode:502};}
  }

  return {status,unlock,logout,listProviders,upsertProvider,setEnabled,deleteProvider,testProvider,authenticated};
}

export function jsonHeaders(): Record<string,string> {
  return {
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
  };
}

export {headerValue, parseCookies, sameOriginRequest as isSameOriginRequest};
