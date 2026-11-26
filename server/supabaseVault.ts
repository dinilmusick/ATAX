import {
  LedgerError,
  openControlPlaneLedger,
  parseDataApiConfig,
  sanitizeErrorMessage,
  type LedgerDb,
} from '../tools/atax-mcp/data-api-ledger.mjs';

export type ProviderType = string;

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

const VALID_PROVIDERS = /^[a-z][a-z0-9_-]{1,63}$/;
const ALIAS_REGEX = /^[A-Z][A-Z0-9_]{0,47}$/;
const ACCOUNT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_REGEX = /^[\w.@:-]{3,200}$/;

export function sanitizeVaultMessage(
  rawMessage: string,
  secretKeyOrHost?: string | null,
  extraUrlOrSecret?: string | null
): string {
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) return '';
  let sanitized = rawMessage;
  if (secretKeyOrHost) sanitized = sanitized.split(secretKeyOrHost).join('[REDACTED]');
  if (extraUrlOrSecret) sanitized = sanitized.split(extraUrlOrSecret).join('[REDACTED]');
  return sanitizeErrorMessage(sanitized);
}

export function inspectSupabaseConnection(
  env: Record<string, string | undefined> = process.env
): ConnectionInspection {
  const urlRaw = typeof (env.ATAX_SUPABASE_URL || env.SUPABASE_URL) === 'string'
    ? String(env.ATAX_SUPABASE_URL || env.SUPABASE_URL).trim()
    : '';
  const keyRaw = typeof (env.ATAX_SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY) === 'string'
    ? String(env.ATAX_SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY).trim()
    : '';

  if (!urlRaw && !keyRaw) {
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
    const cfg = parseDataApiConfig(env);
    return {
      configured: true,
      reachable: undefined,
      hostLabel: new URL(cfg.baseUrl).hostname,
      error: null,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
    };
  } catch (err) {
    return {
      configured: false,
      reachable: false,
      hostLabel: null,
      error: err instanceof Error ? err.message : 'Supabase Data API configuration is invalid.',
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
  if (!VALID_PROVIDERS.test(providerRaw)) {
    throw new VaultError('Invalid provider identifier.', 400);
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
  if (provider === 'vercel') {
    throw new VaultError('Vercel provider adapter is not implemented.', 501);
  }
  if (!VALID_PROVIDERS.test(provider)) {
    throw new VaultError('Invalid provider identifier.', 400);
  }
  const alias = typeof aliasRaw === 'string' ? aliasRaw.trim().toUpperCase() : '';
  if (!ALIAS_REGEX.test(alias)) {
    throw new VaultError('Invalid account alias.', 400);
  }
  return { provider: provider as ProviderType, alias };
}

export type VaultLedgerOpener = (
  bootstrapEnv?: Record<string, string | undefined>,
  fetcher?: typeof fetch
) => Promise<Pick<LedgerDb, 'rpc'>>;

export function createVaultService(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
  ledgerOpener: VaultLedgerOpener = openControlPlaneLedger
) {
  async function open() {
    const inspection = inspectSupabaseConnection(env);
    if (!inspection.configured) {
      throw new VaultError(inspection.error || 'Supabase backend is not configured.', 503);
    }
    let db: Awaited<ReturnType<typeof ledgerOpener>>;
    try {
      db = await ledgerOpener(env, fetcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Supabase Data API backend is unavailable.';
      throw new VaultError(
        sanitizeVaultMessage(message, inspection.hostLabel) || 'Supabase Data API backend is unavailable.',
        503
      );
    }
    return {
      async rpc(name: string, params: Record<string, unknown> = {}) {
        try {
          return await db.rpc(name, params);
        } catch (err) {
          if (err instanceof LedgerError) {
            const status = err.status >= 500 ? 502 : err.status;
            throw new VaultError(
              sanitizeVaultMessage(err.message, inspection.hostLabel) || 'Canonical vault operation failed.',
              status
            );
          }
          throw err;
        }
      },
    };
  }

  async function ownerSubject(db: Awaited<ReturnType<typeof open>>, supplied?: string): Promise<string> {
    const owner = String(await db.rpc('atax_mcp_instance_owner_subject_v1', {}));
    if (!SUBJECT_REGEX.test(owner)) {
      throw new VaultError('ATAX instance owner is not configured.', 503);
    }
    if (supplied && supplied !== owner) {
      throw new VaultError('ATAX provider owner authorization failed.', 403);
    }
    return owner;
  }

  async function listAccounts(suppliedOwner?: string): Promise<ProviderAccountSummary[]> {
    const db = await open();
    const owner = await ownerSubject(db, suppliedOwner);
    const raw = await db.rpc('atax_mcp_provider_summary_v1', { owner_subject_in: owner });
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
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
    if (actor !== owner) {
      throw new VaultError('ATAX provider actor authorization failed.', 403);
    }
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
    if (!id) {
      throw new VaultError('Supabase Vault did not return a credential reference.', 502);
    }
    return {
      id,
      provider: valid.provider,
      alias: valid.alias,
      accountId: valid.accountId,
      enabled: valid.enabled,
    };
  }

  async function setAccountEnabled(
    suppliedOwner: string | undefined,
    providerRaw: string,
    aliasRaw: string,
    enabled: boolean,
    suppliedActor?: string
  ): Promise<void> {
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    const db = await open();
    const owner = await ownerSubject(db, suppliedOwner);
    if (suppliedActor && suppliedActor !== owner) {
      throw new VaultError('ATAX provider actor authorization failed.', 403);
    }
    await db.rpc('atax_mcp_set_provider_enabled_v1', {
      owner_subject_in: owner,
      provider_in: provider,
      alias_in: alias,
      enabled_in: Boolean(enabled),
      actor_subject_in: owner,
    });
  }

  async function deleteAccount(
    suppliedOwner: string | undefined,
    providerRaw: string,
    aliasRaw: string,
    suppliedActor?: string
  ): Promise<void> {
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    const db = await open();
    const owner = await ownerSubject(db, suppliedOwner);
    if (suppliedActor && suppliedActor !== owner) {
      throw new VaultError('ATAX provider actor authorization failed.', 403);
    }
    await db.rpc('atax_mcp_delete_provider_v1', {
      owner_subject_in: owner,
      provider_in: provider,
      alias_in: alias,
      actor_subject_in: owner,
    });
  }

  async function testAccountConnection(
    suppliedOwner: string | null | undefined,
    providerRaw: string,
    aliasRaw: string
  ): Promise<ProviderTestResult> {
    // Phase 1 bug fix: reject undefined/null owner up front with a clear error
    // rather than forwarding it to the RPC which would silently fail to find
    // the credential because no owner subject was supplied for the Vault lookup.
    if (suppliedOwner === undefined || suppliedOwner === null || suppliedOwner === '') {
      throw new VaultError(
        'Instance owner subject is required to retrieve provider credentials. Ensure the instance passkey is initialized and the session is valid.',
        503
      );
    }
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    const db = await open();
    const owner = await ownerSubject(db, suppliedOwner);
    const cfg = (await db.rpc('atax_mcp_runtime_config_v1', {})) as
      | {
          settings?: Record<string, unknown>;
          accounts?: Array<{ provider: string; alias: string; token: string }>;
        }
      | undefined;

    const configuredOwner =
      typeof cfg?.settings?.MCP_OWNER_SUBJECT === 'string'
        ? cfg.settings.MCP_OWNER_SUBJECT
        : null;
    if (configuredOwner && configuredOwner !== owner) {
      return {
        ok: false,
        provider,
        alias,
        statusCode: 403,
        summary: 'Configured Vault owner does not match the instance owner.',
        checkedAt: new Date().toISOString(),
      };
    }

    const match = Array.isArray(cfg?.accounts)
      ? cfg.accounts.find((a) => a.provider === provider && a.alias === alias)
      : undefined;

    if (!match || !match.token) {
      return {
        ok: false,
        provider,
        alias,
        statusCode: 404,
        summary: 'Active Vault secret not found for this alias (ensure account is enabled).',
        checkedAt: new Date().toISOString(),
      };
    }

    const probeUrls:Record<string,string|undefined>={
      github:'https://api.github.com/user',
      cloudflare:'https://api.cloudflare.com/client/v4/user/tokens/verify',
      fly:'https://api.machines.dev/v1/apps?org_slug=personal',
      northflank:'https://api.northflank.com/v1/projects',
      koyeb:'https://app.koyeb.com/v1/apps',
      render:'https://api.render.com/v1/services?limit=1',
    };
    const probeUrl=probeUrls[provider];
    if(!probeUrl){
      const result:ProviderTestResult={
        ok:false,provider,alias,statusCode:501,
        summary:'No live provider probe is implemented for this provider yet.',
        checkedAt:new Date().toISOString(),
      };
      try{await db.rpc('atax_mcp_audit_provider_test_v1',{provider_in:provider,alias_in:alias,ok_in:false,status_code_in:501,actor_subject_in:owner});}catch{}
      return result;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let result: ProviderTestResult;
    try {
      const res = await fetcher(probeUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${match.token}`,
          Accept: 'application/json',
          'User-Agent': 'atax-control-plane',
        },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        result = {
          ok: false,
          provider,
          alias,
          statusCode: res.status,
          summary: `Provider rejected credential (HTTP ${res.status}).`,
          checkedAt: new Date().toISOString(),
        };
      } else if (provider === 'github' && typeof data.login === 'string') {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified GitHub account @${data.login}`,
          checkedAt: new Date().toISOString(),
        };
      } else if (provider === 'cloudflare') {
        const resultObj = data.result as Record<string, unknown> | undefined;
        const cfStatus = typeof resultObj?.status === 'string' ? resultObj.status : 'active';
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Cloudflare token status: ${cfStatus}`,
          checkedAt: new Date().toISOString(),
        };
      } else if (['fly','northflank','koyeb','render'].includes(provider)) {
        result = {
          ok: true, provider, alias, statusCode: res.status,
          summary: 'Provider credential verified by live API probe.',
          checkedAt: new Date().toISOString(),
        };
      } else {
        result = {
          ok: false, provider, alias, statusCode: 501,
          summary: 'No live provider probe is implemented for this provider yet.',
          checkedAt: new Date().toISOString(),
        };
      }
    } catch {
      result = {
        ok: false,
        provider,
        alias,
        statusCode: 502,
        summary: 'Upstream provider probe timed out or could not be reached.',
        checkedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }

    try {
      await db.rpc('atax_mcp_audit_provider_test_v1', {
        provider_in: provider,
        alias_in: alias,
        ok_in: result.ok,
        status_code_in: result.statusCode,
        actor_subject_in: owner,
      });
    } catch {
      // Audit failure must not turn a verified provider response into a secret-bearing error.
    }
    return result;
  }

  return {
    listAccounts,
    upsertSecret,
    setAccountEnabled,
    deleteAccount,
    testAccountConnection,
  };
}
