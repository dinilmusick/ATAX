import {openLedger} from '../tools/atax-mcp/data-api-ledger.mjs';

export type ProviderType = 'github' | 'cloudflare' | 'vercel';

export interface ProviderAccountSummary {
  id: string;
  provider: ProviderType;
  alias: string;
  accountId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionInspection {
  configured: boolean;
  reachable?: boolean;
  hostLabel: string | null;
  error: string | null;
  baseUrl: string | null;
  apiKey: string | null;
}

export interface UpsertSecretInput {
  ownerSubject?: string;
  provider: string;
  alias: string;
  credential: string;
  actorSubject?: string;
  accountId?: string | null;
  enabled?: boolean;
}

export interface ValidatedUpsertInput {
  provider: ProviderType;
  alias: string;
  credential: string;
  accountId: string | null;
  enabled: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: ProviderType;
  alias: string;
  statusCode: number;
  summary: string;
  checkedAt: string;
}

export class VaultError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'VaultError';
    this.statusCode = statusCode;
  }
}

const VALID_PROVIDERS = new Set<ProviderType>(['github', 'cloudflare']);
const ALIAS_REGEX = /^[A-Z][A-Z0-9_]{0,47}$/;
const ACCOUNT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_REGEX = /^[\w.@:-]{3,200}$/;

export function sanitizeVaultMessage(rawMessage: string, connectionHost?: string | null): string {
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) return '';
  let sanitized = rawMessage;
  if (connectionHost) sanitized = sanitized.split(connectionHost).join('[REDACTED_HOST]');
  return sanitized
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_URI]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function inspectSupabaseConnection(
  env: Record<string, string | undefined> = process.env
): ConnectionInspection {
  const raw = typeof env.ATAX_SUPABASE_CONNECTION_URL === 'string'
    ? env.ATAX_SUPABASE_CONNECTION_URL.trim()
    : '';
  if (!raw) {
    return {
      configured: false,
      reachable: false,
      hostLabel: null,
      error: null,
      baseUrl: null,
      apiKey: null,
    };
  }
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL URI required.');
    if (!url.hostname) throw new Error('PostgreSQL hostname missing.');
    return {
      configured: true,
      reachable: undefined,
      hostLabel: url.hostname,
      error: null,
      baseUrl: null,
      apiKey: null,
    };
  } catch {
    return {
      configured: false,
      reachable: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_CONNECTION_URL must be a valid trusted PostgreSQL connection URI.',
      baseUrl: null,
      apiKey: null,
    };
  }
}

export function validateProviderInput(input: UpsertSecretInput): ValidatedUpsertInput {
  const providerRaw = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : '';
  if (providerRaw === 'vercel') {
    throw new VaultError('Vercel provider adapter is not implemented.', 501);
  }
  if (!VALID_PROVIDERS.has(providerRaw as ProviderType)) {
    throw new VaultError('Unsupported provider. Choose github or cloudflare.', 400);
  }

  const alias = typeof input.alias === 'string' ? input.alias.trim().toUpperCase() : '';
  if (!ALIAS_REGEX.test(alias)) {
    throw new VaultError('Alias must start with A-Z and contain 1-48 uppercase letters, digits, or underscores.', 400);
  }

  const credential = typeof input.credential === 'string' ? input.credential.trim() : '';
  if (credential.length < 16 || credential.length > 8192) {
    throw new VaultError('Secret token must be between 16 and 8192 characters.', 400);
  }

  let accountId: string | null = null;
  if (input.accountId !== undefined && input.accountId !== null && String(input.accountId).trim() !== '') {
    const trimmed = String(input.accountId).trim();
    if (!ACCOUNT_ID_REGEX.test(trimmed)) {
      throw new VaultError('Account ID may only contain letters, digits, _ or - (max 128 chars).', 400);
    }
    accountId = trimmed;
  }

  return {
    provider: providerRaw as ProviderType,
    alias,
    credential,
    accountId,
    enabled: input.enabled !== false,
  };
}

export function validateProviderKey(providerRaw: string, aliasRaw: string): {
  provider: ProviderType;
  alias: string;
} {
  const provider = typeof providerRaw === 'string' ? providerRaw.trim().toLowerCase() : '';
  if (provider === 'vercel') throw new VaultError('Vercel provider adapter is not implemented.', 501);
  if (!VALID_PROVIDERS.has(provider as ProviderType)) throw new VaultError('Unsupported provider.', 400);
  const alias = typeof aliasRaw === 'string' ? aliasRaw.trim().toUpperCase() : '';
  if (!ALIAS_REGEX.test(alias)) throw new VaultError('Invalid account alias.', 400);
  return {provider: provider as ProviderType, alias};
}

export function createVaultService(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
) {
  async function open() {
    const inspection = inspectSupabaseConnection(env);
    if (!inspection.configured) {
      throw new VaultError(inspection.error || 'Supabase backend is not configured.', 503);
    }
    try {
      return await openLedger(env);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Supabase PostgreSQL backend is unavailable.';
      throw new VaultError(sanitizeVaultMessage(message, inspection.hostLabel) || 'Supabase PostgreSQL backend is unavailable.', 503);
    }
  }

  async function ownerSubject(db: Awaited<ReturnType<typeof open>>, supplied?: string): Promise<string> {
    const owner = String(await db.rpc('atax_mcp_instance_owner_subject_v1', {}));
    if (!SUBJECT_REGEX.test(owner)) throw new VaultError('ATAX instance owner is not configured.', 503);
    if (supplied && supplied !== owner) throw new VaultError('ATAX provider owner authorization failed.', 403);
    return owner;
  }

  async function listAccounts(suppliedOwner?: string): Promise<ProviderAccountSummary[]> {
    const db = await open();
    const owner = await ownerSubject(db, suppliedOwner);
    const raw = await db.rpc('atax_mcp_provider_summary_v1', {owner_subject_in: owner});
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map(item => ({
        id: String(item.id || ''),
        provider: String(item.provider || 'github') as ProviderType,
        alias: String(item.alias || ''),
        accountId: item.accountId ? String(item.accountId) : null,
        enabled: item.enabled !== false,
        createdAt: String(item.createdAt || ''),
        updatedAt: String(item.updatedAt || ''),
      }));
  }

  async function upsertSecret(input: UpsertSecretInput): Promise<{
    id: string;
    provider: ProviderType;
    alias: string;
    accountId: string | null;
    enabled: boolean;
  }> {
    const valid = validateProviderInput(input);
    const db = await open();
    const owner = await ownerSubject(db, input.ownerSubject);
    const actor = input.actorSubject || owner;
    if (actor !== owner) throw new VaultError('ATAX provider actor authorization failed.', 403);
    const idRaw = await db.rpc('atax_mcp_upsert_provider_v1', {
      owner_subject_in: owner,
      provider_in: valid.provider,
      alias_in: valid.alias,
      credential_in: valid.credential,
      actor_subject_in: owner,
      account_id_in: valid.accountId,
      enabled_in: valid.enabled,
    });
    const id = typeof idRaw === 'string' ? idRaw : idRaw ? String(idRaw) : '';
    if (!id) throw new VaultError('Supabase Vault did not return a credential reference.', 502);
    return {id,provider:valid.provider,alias:valid.alias,accountId:valid.accountId,enabled:valid.enabled};
  }

  async function setAccountEnabled(
    suppliedOwner: string | undefined,
    providerRaw: string,
    aliasRaw: string,
    enabled: boolean,
    suppliedActor?: string
  ): Promise<void> {
    const {provider,alias}=validateProviderKey(providerRaw,aliasRaw);
    const db=await open();
    const owner=await ownerSubject(db,suppliedOwner);
    if (suppliedActor && suppliedActor !== owner) throw new VaultError('ATAX provider actor authorization failed.',403);
    await db.rpc('atax_mcp_set_provider_enabled_v1',{
      owner_subject_in:owner,provider_in:provider,alias_in:alias,enabled_in:Boolean(enabled),actor_subject_in:owner
    });
  }

  async function deleteAccount(
    suppliedOwner: string | undefined,
    providerRaw: string,
    aliasRaw: string,
    suppliedActor?: string
  ): Promise<void> {
    const {provider,alias}=validateProviderKey(providerRaw,aliasRaw);
    const db=await open();
    const owner=await ownerSubject(db,suppliedOwner);
    if (suppliedActor && suppliedActor !== owner) throw new VaultError('ATAX provider actor authorization failed.',403);
    await db.rpc('atax_mcp_delete_provider_v1',{
      owner_subject_in:owner,provider_in:provider,alias_in:alias,actor_subject_in:owner
    });
  }

  async function testAccountConnection(
    suppliedOwner: string | undefined,
    providerRaw: string,
    aliasRaw: string
  ): Promise<ProviderTestResult> {
    const {provider,alias}=validateProviderKey(providerRaw,aliasRaw);
    const db=await open();
    const owner=await ownerSubject(db,suppliedOwner);
    const cfg=await db.rpc('atax_mcp_runtime_config_v1',{}) as
      | {settings?:Record<string,unknown>;accounts?:Array<{provider:string;alias:string;token:string}>}
      | null;
    const match=Array.isArray(cfg?.accounts)
      ? cfg.accounts.find(a=>a.provider===provider&&a.alias===alias)
      : undefined;
    if(!match?.token){
      const result={ok:false,provider,alias,statusCode:404,summary:'Active Vault secret not found for this alias (ensure the account is enabled).',checkedAt:new Date().toISOString()};
      return result;
    }
    let result: ProviderTestResult;
    const probeUrl=provider==='github'
      ? 'https://api.github.com/user'
      : 'https://api.cloudflare.com/client/v4/user/tokens/verify';
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),8000);
      try{
        const res=await fetcher(probeUrl,{
          method:'GET',redirect:'error',signal:controller.signal,
          headers:{Authorization:`Bearer ${match.token}`,Accept:'application/json','User-Agent':'atax-control-plane'}
        });
        const data=(await res.json().catch(()=>({}))) as Record<string,unknown>;
        if(!res.ok){
          result={ok:false,provider,alias,statusCode:res.status,summary:`Provider rejected credential (HTTP ${res.status}).`,checkedAt:new Date().toISOString()};
        }else if(provider==='github'&&typeof data.login==='string'){
          result={ok:true,provider,alias,statusCode:res.status,summary:`Verified GitHub account @${data.login}`,checkedAt:new Date().toISOString()};
        }else if(provider==='cloudflare'){
          const resultObj=data.result as Record<string,unknown>|undefined;
          const cfStatus=typeof resultObj?.status==='string'?resultObj.status:'active';
          result={ok:true,provider,alias,statusCode:res.status,summary:`Cloudflare token status: ${cfStatus}`,checkedAt:new Date().toISOString()};
        }else{
          result={ok:true,provider,alias,statusCode:res.status,summary:'Token verified',checkedAt:new Date().toISOString()};
        }
      }finally{clearTimeout(timer);}
    }catch{
      result={ok:false,provider,alias,statusCode:502,summary:'Upstream provider probe timed out or could not be reached.',checkedAt:new Date().toISOString()};
    }

    try{
      await db.rpc('atax_mcp_audit_provider_test_v1',{
        provider_in:provider,alias_in:alias,ok_in:result.ok,status_code_in:result.statusCode,actor_subject_in:owner
      });
    }catch{
      // Audit failure must not turn a verified provider response into a secret-bearing error.
    }
    return result;
  }

  return {listAccounts,upsertSecret,setAccountEnabled,deleteAccount,testAccountConnection};
}
