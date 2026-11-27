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
  apiReachable?: boolean;
  authVerified?: boolean;
  computeSupported?: boolean;
  inferenceSupported?: boolean;
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
const RESERVED_PROVIDERS = new Set(['__proto__', 'constructor', 'prototype']);
const COMPUTE_SUPPORTED_PROVIDERS = new Set(['fly', 'northflank', 'render', 'railway']);
const INFERENCE_SUPPORTED_PROVIDERS = new Set([
  'google',
  'groq',
  'cerebras',
  'together',
  'nvidia',
  'openrouter',
  'huggingface',
  'anthropic',
  'openai',
]);
const ALIAS_REGEX = /^[A-Z][A-Z0-9_]{0,47}$/;
const ACCOUNT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_REGEX = /^[\w.@:-]{3,200}$/;

function assertValidProviderId(raw: unknown): ProviderType {
  const provider = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!VALID_PROVIDERS.test(provider) || RESERVED_PROVIDERS.has(provider)) {
    throw new VaultError('Invalid provider identifier.', 400);
  }
  return provider;
}

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
  const providerRaw = assertValidProviderId(input.provider);

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
    provider: providerRaw,
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
  const provider = assertValidProviderId(providerRaw);
  const alias = typeof aliasRaw === 'string' ? aliasRaw.trim().toUpperCase() : '';
  if (!ALIAS_REGEX.test(alias)) {
    throw new VaultError('Invalid account alias.', 400);
  }
  return { provider, alias };
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

    const computeSupported = COMPUTE_SUPPORTED_PROVIDERS.has(provider);
    const inferenceSupported = INFERENCE_SUPPORTED_PROVIDERS.has(provider);

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
        apiReachable: false,
        authVerified: false,
        computeSupported,
        inferenceSupported,
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
        apiReachable: false,
        authVerified: false,
        computeSupported,
        inferenceSupported,
      };
    }

    const probeSpecs: Record<string, { url: string; method: 'GET' | 'POST'; body?: string; authStyle?: 'bearer' | 'goog' | 'anthropic' }> = {
      github: { url: 'https://api.github.com/user', method: 'GET' },
      cloudflare: { url: 'https://api.cloudflare.com/client/v4/user/tokens/verify', method: 'GET' },
      neon: { url: 'https://console.neon.tech/api/v2/users/me', method: 'GET' },
      vercel: { url: 'https://api.vercel.com/v2/user', method: 'GET' },
      fly: { url: 'https://api.machines.dev/v1/apps?org_slug=personal', method: 'GET' },
      northflank: { url: 'https://api.northflank.com/v1/projects', method: 'GET' },
      koyeb: { url: 'https://app.koyeb.com/v1/apps', method: 'GET' },
      render: { url: 'https://api.render.com/v1/services?limit=1', method: 'GET' },
      railway: {
        url: 'https://backboard.railway.com/graphql/v2',
        method: 'POST',
        body: JSON.stringify({ query: 'query{me{id name}}' }),
      },
      google: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', method: 'GET', authStyle: 'goog' },
      groq: { url: 'https://api.groq.com/openai/v1/models', method: 'GET' },
      cerebras: { url: 'https://api.cerebras.ai/v1/models', method: 'GET' },
      together: { url: 'https://api.together.xyz/v1/models', method: 'GET' },
      nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', method: 'GET' },
      openrouter: { url: 'https://openrouter.ai/api/v1/auth/key', method: 'GET' },
      huggingface: { url: 'https://huggingface.co/api/whoami-v2', method: 'GET' },
      anthropic: { url: 'https://api.anthropic.com/v1/models', method: 'GET', authStyle: 'anthropic' },
      openai: { url: 'https://api.openai.com/v1/models', method: 'GET' },
    };
    const spec = probeSpecs[provider];
    if (!spec) {
      const result: ProviderTestResult = {
        ok: false,
        provider,
        alias,
        statusCode: 501,
        summary: 'No live provider probe is implemented for this provider yet.',
        checkedAt: new Date().toISOString(),
        apiReachable: false,
        authVerified: false,
        computeSupported,
        inferenceSupported,
      };
      try {
        await db.rpc('atax_mcp_audit_provider_test_v1', {
          provider_in: provider,
          alias_in: alias,
          ok_in: false,
          status_code_in: 501,
          actor_subject_in: owner,
        });
      } catch {}
      return result;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let result: ProviderTestResult;
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'atax-control-plane',
      };
      if (spec.authStyle === 'goog') {
        headers['x-goog-api-key'] = match.token;
      } else if (spec.authStyle === 'anthropic') {
        headers['x-api-key'] = match.token;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.Authorization = `Bearer ${match.token}`;
      }
      if (spec.body) headers['Content-Type'] = 'application/json';

      const res = await fetcher(spec.url, {
        method: spec.method,
        redirect: 'manual',
        signal: controller.signal,
        headers,
        ...(spec.body ? { body: spec.body } : {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        result = {
          ok: false,
          provider,
          alias,
          statusCode: res.status,
          summary: `Provider rejected credential (HTTP ${res.status}).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: false,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'github' && data && typeof (data as Record<string, unknown>).login === 'string') {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified GitHub account @${(data as Record<string, unknown>).login}`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'cloudflare' && data && (data as Record<string, unknown>).success === true) {
        const resultObj = (data as Record<string, unknown>).result as Record<string, unknown> | undefined;
        const cfStatus = typeof resultObj?.status === 'string' ? resultObj.status : 'active';
        result = {
          ok: cfStatus === 'active',
          provider,
          alias,
          statusCode: res.status,
          summary: `Cloudflare token status: ${cfStatus}`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: cfStatus === 'active',
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'neon' && data && (typeof (data as Record<string, unknown>).id === 'string' || typeof (data as Record<string, unknown>).email === 'string')) {
        const label = String((data as Record<string, unknown>).email || (data as Record<string, unknown>).login || (data as Record<string, unknown>).id);
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Neon account (${label}).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'vercel' && data && typeof ((data as Record<string, any>).user?.username ?? (data as Record<string, any>).user?.email ?? (data as Record<string, any>).username) === 'string') {
        const u = (data as Record<string, any>).user ?? (data as Record<string, any>);
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Vercel account @${String(u.username || u.email || u.id)}.`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'fly' && data && Array.isArray((data as Record<string, unknown>).apps)) {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Fly.io credential (${((data as Record<string, unknown>).apps as unknown[]).length} apps accessible).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'northflank' && data && Array.isArray(((data as Record<string, any>).data?.projects ?? (data as Record<string, any>).data))) {
        const projects = ((data as Record<string, any>).data?.projects ?? (data as Record<string, any>).data) as unknown[];
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Northflank credential (${projects.length} projects accessible).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'koyeb' && data && Array.isArray((data as Record<string, unknown>).apps)) {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Koyeb credential (${((data as Record<string, unknown>).apps as unknown[]).length} apps accessible; compute execution not yet implemented).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported: false,
          inferenceSupported,
        };
      } else if (provider === 'render' && Array.isArray(data)) {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Render credential (${data.length} services sampled).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'railway' && data && !Array.isArray((data as Record<string, any>).errors) && typeof (data as Record<string, any>).data?.me?.id === 'string') {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Railway credential (${String((data as Record<string, any>).data.me.name || (data as Record<string, any>).data.me.id)}).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'google' && data && Array.isArray((data as Record<string, unknown>).models)) {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Google AI Studio key (${((data as Record<string, unknown>).models as unknown[]).length} models listed).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (
        (provider === 'groq' || provider === 'cerebras' || provider === 'nvidia' || provider === 'anthropic' || provider === 'openai') &&
        data &&
        Array.isArray((data as Record<string, unknown>).data)
      ) {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified ${provider} API key (${((data as Record<string, unknown>).data as unknown[]).length} models accessible).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'together' && (Array.isArray(data) || (data && Array.isArray((data as Record<string, unknown>).data)))) {
        const count = Array.isArray(data) ? data.length : ((data as Record<string, unknown>).data as unknown[]).length;
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Together AI key (${count} models accessible).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'openrouter' && data && typeof (data as Record<string, any>).data === 'object' && (data as Record<string, any>).data !== null) {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: 'Verified OpenRouter API key.',
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else if (provider === 'huggingface' && data && (typeof (data as Record<string, unknown>).name === 'string' || typeof (data as Record<string, unknown>).id === 'string')) {
        result = {
          ok: true,
          provider,
          alias,
          statusCode: res.status,
          summary: `Verified Hugging Face token (${String((data as Record<string, unknown>).name || (data as Record<string, unknown>).id)}).`,
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: true,
          computeSupported,
          inferenceSupported,
        };
      } else {
        result = {
          ok: false,
          provider,
          alias,
          statusCode: 502,
          summary: 'Provider API returned an unexpected or unauthenticated response payload.',
          checkedAt: new Date().toISOString(),
          apiReachable: true,
          authVerified: false,
          computeSupported,
          inferenceSupported,
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
        apiReachable: false,
        authVerified: false,
        computeSupported,
        inferenceSupported,
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
