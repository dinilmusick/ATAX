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
  hostLabel: string | null;
  error: string | null;
  baseUrl: string | null;
  apiKey: string | null;
}

export interface UpsertSecretInput {
  ownerSubject: string;
  provider: string;
  alias: string;
  credential: string;
  actorSubject: string;
  accountId?: string | null;
  enabled?: boolean;
}

export interface ValidatedUpsertInput {
  ownerSubject: string;
  provider: ProviderType;
  alias: string;
  credential: string;
  actorSubject: string;
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

const VALID_PROVIDERS = new Set<ProviderType>(['github', 'cloudflare', 'vercel']);
const ALIAS_REGEX = /^[A-Z][A-Z0-9_]{0,47}$/;
const ACCOUNT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_REGEX = /^[\w.@:-]{3,200}$/;
const SECRET_KEY_REGEX = /^[A-Za-z0-9._\-+/=]{20,8192}$/;

export function sanitizeVaultMessage(
  rawMessage: string,
  apiKey?: string | null,
  baseUrl?: string | null
): string {
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
    return '';
  }
  let sanitized = rawMessage;
  if (apiKey) {
    sanitized = sanitized.split(apiKey).join('[REDACTED]');
  }
  if (baseUrl) {
    sanitized = sanitized.split(baseUrl).join('[REDACTED]');
  }
  return sanitized
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_URI]')
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function inspectSupabaseConnection(
  env: Record<string, string | undefined> = process.env
): ConnectionInspection {
  const urlRaw = (env.ATAX_SUPABASE_URL || '').trim();
  const keyRaw = (env.ATAX_SUPABASE_SECRET_KEY || '').trim();

  if (!urlRaw && !keyRaw) {
    return {
      configured: false,
      hostLabel: null,
      error: null,
      baseUrl: null,
      apiKey: null,
    };
  }

  if (!urlRaw || !keyRaw) {
    return {
      configured: false,
      hostLabel: null,
      error: 'Both ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY are required.',
      baseUrl: null,
      apiKey: null,
    };
  }

  if (urlRaw.length > 2048) {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_URL exceeds maximum length.',
      baseUrl: null,
      apiKey: null,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_URL must be a valid HTTPS Supabase URL.',
      baseUrl: null,
      apiKey: null,
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_URL must use https://.',
      baseUrl: null,
      apiKey: null,
    };
  }

  const hostname = parsed.hostname;
  if (
    !hostname ||
    !(hostname.endsWith('.supabase.co') || hostname.endsWith('.supabase.com')) ||
    hostname.includes('..') ||
    hostname.startsWith('.')
  ) {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_URL must use a canonical .supabase.co or .supabase.com hostname.',
      baseUrl: null,
      apiKey: null,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_URL must not contain user credentials.',
      baseUrl: null,
      apiKey: null,
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_URL must not contain query parameters or hash.',
      baseUrl: null,
      apiKey: null,
    };
  }

  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_URL must not include a subpath.',
      baseUrl: null,
      apiKey: null,
    };
  }

  if (!SECRET_KEY_REGEX.test(keyRaw)) {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_SECRET_KEY must be 20-8192 valid token characters.',
      baseUrl: null,
      apiKey: null,
    };
  }

  return {
    configured: true,
    hostLabel: hostname,
    error: null,
    baseUrl: parsed.origin,
    apiKey: keyRaw,
  };
}

export function validateProviderInput(input: UpsertSecretInput): ValidatedUpsertInput {
  const providerRaw = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : '';
  if (!VALID_PROVIDERS.has(providerRaw as ProviderType)) {
    throw new VaultError('Unsupported provider. Choose github, cloudflare, or vercel.', 400);
  }
  const provider = providerRaw as ProviderType;

  const alias = typeof input.alias === 'string' ? input.alias.trim().toUpperCase() : '';
  if (!ALIAS_REGEX.test(alias)) {
    throw new VaultError(
      'Alias must start with A-Z and contain 1-48 uppercase letters, digits, or underscores.',
      400
    );
  }

  const credential = typeof input.credential === 'string' ? input.credential.trim() : '';
  if (credential.length < 16 || credential.length > 8192) {
    throw new VaultError('Secret token must be between 16 and 8192 characters.', 400);
  }

  const ownerSubject = typeof input.ownerSubject === 'string' ? input.ownerSubject.trim() : '';
  if (!SUBJECT_REGEX.test(ownerSubject)) {
    throw new VaultError('Owner subject must be 3-200 characters (letters, digits, ., _, @, :, -).', 400);
  }

  const actorSubject = typeof input.actorSubject === 'string' ? input.actorSubject.trim() : '';
  if (!SUBJECT_REGEX.test(actorSubject)) {
    throw new VaultError('Actor subject is invalid.', 400);
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
    ownerSubject,
    provider,
    alias,
    credential,
    actorSubject,
    accountId,
    enabled: input.enabled !== false,
  };
}

export function validateProviderKey(providerRaw: string, aliasRaw: string): {
  provider: ProviderType;
  alias: string;
} {
  const provider = typeof providerRaw === 'string' ? providerRaw.trim().toLowerCase() : '';
  if (!VALID_PROVIDERS.has(provider as ProviderType)) {
    throw new VaultError('Unsupported provider.', 400);
  }
  const alias = typeof aliasRaw === 'string' ? aliasRaw.trim().toUpperCase() : '';
  if (!ALIAS_REGEX.test(alias)) {
    throw new VaultError('Invalid account alias.', 400);
  }
  return { provider: provider as ProviderType, alias };
}

export function createVaultService(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
) {
  function requireDataApiConfig(): { baseUrl: string; apiKey: string } {
    const inspection = inspectSupabaseConnection(env);
    if (!inspection.configured || !inspection.baseUrl || !inspection.apiKey) {
      throw new VaultError(
        inspection.error ||
          'Supabase backend is not configured. Set ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY in your environment.',
        503
      );
    }
    return { baseUrl: inspection.baseUrl, apiKey: inspection.apiKey };
  }

  async function callRpc(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const { baseUrl, apiKey } = requireDataApiConfig();
    let res: Response;
    try {
      res = await fetcher(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Supabase Data API request failed.';
      const safeMsg = sanitizeVaultMessage(rawMsg, apiKey, baseUrl);
      throw new VaultError(
        safeMsg ? `Supabase Data API request failed: ${safeMsg}` : 'Supabase Data API request failed.',
        502
      );
    }

    if (res.status === 204) {
      return null;
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let parsedBody: Record<string, unknown> | null = null;
      if (text) {
        try {
          const candidate = JSON.parse(text);
          if (candidate && typeof candidate === 'object') {
            parsedBody = candidate as Record<string, unknown>;
          }
        } catch {
          parsedBody = null;
        }
      }
      const rawMessage =
        typeof parsedBody?.message === 'string' && parsedBody.message ? parsedBody.message : text;
      const pgCode = typeof parsedBody?.code === 'string' ? parsedBody.code : '';
      const sanitized = sanitizeVaultMessage(rawMessage, apiKey, baseUrl);

      if (res.status === 400 && (pgCode === 'P0001' || sanitized)) {
        throw new VaultError(sanitized || 'Vault operation rejected.', 400);
      }
      if (res.status === 409 || pgCode === '23505') {
        throw new VaultError(sanitized || 'Duplicate Vault record.', 409);
      }
      throw new VaultError(
        sanitized
          ? `Supabase Data API error (HTTP ${res.status}): ${sanitized}`
          : `Supabase Data API error (HTTP ${res.status}).`,
        502
      );
    }

    if (!text || !text.trim()) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new VaultError('Invalid JSON response from Supabase Data API.', 502);
    }
  }

  async function listAccounts(ownerSubject: string): Promise<ProviderAccountSummary[]> {
    if (!SUBJECT_REGEX.test(ownerSubject)) {
      throw new VaultError('Invalid owner subject.', 400);
    }
    const raw = await callRpc('atax_mcp_provider_summary_v1', {
      owner_subject_in: ownerSubject,
    });
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

  async function ensureOwnerPolicy(ownerSubject: string, actorSubject: string): Promise<void> {
    try {
      const cfg = (await callRpc('atax_mcp_runtime_config_v1', {})) as
        | { settings?: Record<string, unknown> }
        | null;
      const existingSettings =
        cfg && cfg.settings && typeof cfg.settings === 'object' && !Array.isArray(cfg.settings)
          ? { ...cfg.settings }
          : {};

      if (!existingSettings.MCP_OWNER_SUBJECT || existingSettings.MCP_OWNER_SUBJECT !== ownerSubject) {
        existingSettings.MCP_OWNER_SUBJECT = ownerSubject;
        await callRpc('atax_mcp_set_settings_v1', {
          settings_in: existingSettings,
          actor_subject_in: actorSubject,
        });
      }
    } catch {
      // Non-fatal if caller role has upsert grants without settings admin grant
    }
  }

  async function upsertSecret(input: UpsertSecretInput): Promise<{
    id: string;
    provider: ProviderType;
    alias: string;
    accountId: string | null;
    enabled: boolean;
  }> {
    const valid = validateProviderInput(input);
    requireDataApiConfig();

    await ensureOwnerPolicy(valid.ownerSubject, valid.actorSubject);

    const idRaw = await callRpc('atax_mcp_upsert_provider_v1', {
      owner_subject_in: valid.ownerSubject,
      provider_in: valid.provider,
      alias_in: valid.alias,
      credential_in: valid.credential,
      actor_subject_in: valid.actorSubject,
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
    ownerSubject: string,
    providerRaw: string,
    aliasRaw: string,
    enabled: boolean,
    actorSubject: string
  ): Promise<void> {
    if (!SUBJECT_REGEX.test(ownerSubject) || !SUBJECT_REGEX.test(actorSubject)) {
      throw new VaultError('Invalid subject.', 400);
    }
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    await callRpc('atax_mcp_set_provider_enabled_v1', {
      owner_subject_in: ownerSubject,
      provider_in: provider,
      alias_in: alias,
      enabled_in: Boolean(enabled),
      actor_subject_in: actorSubject,
    });
  }

  async function deleteAccount(
    ownerSubject: string,
    providerRaw: string,
    aliasRaw: string,
    actorSubject: string
  ): Promise<void> {
    if (!SUBJECT_REGEX.test(ownerSubject) || !SUBJECT_REGEX.test(actorSubject)) {
      throw new VaultError('Invalid subject.', 400);
    }
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    await callRpc('atax_mcp_delete_provider_v1', {
      owner_subject_in: ownerSubject,
      provider_in: provider,
      alias_in: alias,
      actor_subject_in: actorSubject,
    });
  }

  async function testAccountConnection(
    ownerSubject: string,
    providerRaw: string,
    aliasRaw: string
  ): Promise<ProviderTestResult> {
    if (!SUBJECT_REGEX.test(ownerSubject)) {
      throw new VaultError('Invalid owner subject.', 400);
    }
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    const cfg = (await callRpc('atax_mcp_runtime_config_v1', {})) as
      | {
          settings?: Record<string, unknown>;
          accounts?: Array<{ provider: string; alias: string; token: string }>;
        }
      | null;

    const configuredOwner =
      typeof cfg?.settings?.MCP_OWNER_SUBJECT === 'string'
        ? cfg.settings.MCP_OWNER_SUBJECT
        : null;
    if (configuredOwner && configuredOwner !== ownerSubject) {
      return {
        ok: false,
        provider,
        alias,
        statusCode: 403,
        summary: 'Configured Vault owner does not match the active operator session.',
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

    const probeUrl =
      provider === 'github'
        ? 'https://api.github.com/user'
        : provider === 'cloudflare'
        ? 'https://api.cloudflare.com/client/v4/user/tokens/verify'
        : 'https://api.vercel.com/v2/user';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetcher(probeUrl, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${match.token}`,
          Accept: 'application/json',
          'User-Agent': 'atax-control-plane',
        },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          ok: false,
          provider,
          alias,
          statusCode: res.status,
          summary: `Provider rejected credential (HTTP ${res.status}).`,
          checkedAt: new Date().toISOString(),
        };
      }

      let identitySummary = 'Token verified';
      if (provider === 'github' && typeof data.login === 'string') {
        identitySummary = `Verified GitHub account @${data.login}`;
      } else if (provider === 'cloudflare') {
        const resultObj = data.result as Record<string, unknown> | undefined;
        const cfStatus = typeof resultObj?.status === 'string' ? resultObj.status : 'active';
        identitySummary = `Cloudflare token status: ${cfStatus}`;
      } else if (provider === 'vercel') {
        const userObj = data.user as Record<string, unknown> | undefined;
        const handle =
          typeof userObj?.username === 'string'
            ? userObj.username
            : typeof userObj?.email === 'string'
            ? userObj.email
            : 'verified';
        identitySummary = `Verified Vercel account ${handle}`;
      }

      return {
        ok: true,
        provider,
        alias,
        statusCode: res.status,
        summary: identitySummary,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
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
  }

  return {
    listAccounts,
    upsertSecret,
    setAccountEnabled,
    deleteAccount,
    testAccountConnection,
  };
}
