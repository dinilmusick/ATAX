import postgres from 'postgres';

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
  connectionUrl: string | null;
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

export interface SqlRunner {
  unsafe: (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
}

const VALID_PROVIDERS = new Set<ProviderType>(['github', 'cloudflare', 'vercel']);
const ALIAS_REGEX = /^[A-Z][A-Z0-9_]{0,47}$/;
const ACCOUNT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_REGEX = /^[\w.@:-]{3,200}$/;

export function inspectSupabaseConnection(
  env: Record<string, string | undefined> = process.env
): ConnectionInspection {
  const raw = (env.ATAX_SUPABASE_CONNECTION_URL || '').trim();
  if (!raw) {
    return {
      configured: false,
      hostLabel: null,
      error: null,
      connectionUrl: null,
    };
  }

  if (raw.length < 24 || raw.length > 8192) {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_CONNECTION_URL has an invalid length.',
      connectionUrl: null,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_CONNECTION_URL must be a valid PostgreSQL connection URI.',
      connectionUrl: null,
    };
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_CONNECTION_URL must use postgres:// or postgresql:// with TLS.',
      connectionUrl: null,
    };
  }

  if (!url.hostname || !url.username || !url.password || !url.pathname || url.pathname === '/') {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_CONNECTION_URL must include host, credentials, and database name.',
      connectionUrl: null,
    };
  }

  const sslMode = url.searchParams.get('sslmode');
  if (sslMode && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    return {
      configured: false,
      hostLabel: null,
      error: 'ATAX_SUPABASE_CONNECTION_URL requires TLS (sslmode=require or verify-full).',
      connectionUrl: null,
    };
  }

  return {
    configured: true,
    hostLabel: url.hostname,
    error: null,
    connectionUrl: raw,
  };
}

export function validateProviderInput(input: UpsertSecretInput): ValidatedUpsertInput {
  const providerRaw = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : '';
  if (!VALID_PROVIDERS.has(providerRaw as ProviderType)) {
    throw new Error('Unsupported provider. Choose github, cloudflare, or vercel.');
  }
  const provider = providerRaw as ProviderType;

  const alias = typeof input.alias === 'string' ? input.alias.trim().toUpperCase() : '';
  if (!ALIAS_REGEX.test(alias)) {
    throw new Error(
      'Alias must start with A-Z and contain 1-48 uppercase letters, digits, or underscores.'
    );
  }

  const credential = typeof input.credential === 'string' ? input.credential.trim() : '';
  if (credential.length < 16 || credential.length > 8192) {
    throw new Error('Secret token must be between 16 and 8192 characters.');
  }

  const ownerSubject = typeof input.ownerSubject === 'string' ? input.ownerSubject.trim() : '';
  if (!SUBJECT_REGEX.test(ownerSubject)) {
    throw new Error('Owner subject must be 3-200 characters (letters, digits, ., _, @, :, -).');
  }

  const actorSubject = typeof input.actorSubject === 'string' ? input.actorSubject.trim() : '';
  if (!SUBJECT_REGEX.test(actorSubject)) {
    throw new Error('Actor subject is invalid.');
  }

  let accountId: string | null = null;
  if (input.accountId !== undefined && input.accountId !== null && String(input.accountId).trim() !== '') {
    const trimmed = String(input.accountId).trim();
    if (!ACCOUNT_ID_REGEX.test(trimmed)) {
      throw new Error('Account ID may only contain letters, digits, _ or - (max 128 chars).');
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
    throw new Error('Unsupported provider.');
  }
  const alias = typeof aliasRaw === 'string' ? aliasRaw.trim().toUpperCase() : '';
  if (!ALIAS_REGEX.test(alias)) {
    throw new Error('Invalid account alias.');
  }
  return { provider: provider as ProviderType, alias };
}

const pools = new Map<string, ReturnType<typeof postgres>>();

function getSqlRunner(connectionUrl: string): SqlRunner {
  let sql = pools.get(connectionUrl);
  if (!sql) {
    sql = postgres(connectionUrl, {
      ssl: 'require',
      max: 3,
      prepare: false,
      connect_timeout: 8,
      idle_timeout: 20,
    });
    pools.set(connectionUrl, sql);
  }
  return sql as unknown as SqlRunner;
}

export function createVaultService(
  env: Record<string, string | undefined> = process.env,
  runnerFactory: (url: string) => SqlRunner = getSqlRunner,
  fetcher: typeof fetch = fetch
) {
  function requireRunner(): SqlRunner {
    const inspection = inspectSupabaseConnection(env);
    if (!inspection.configured || !inspection.connectionUrl) {
      throw new Error(
        inspection.error ||
          'Supabase backend is not configured. Set ATAX_SUPABASE_CONNECTION_URL in your environment.'
      );
    }
    return runnerFactory(inspection.connectionUrl);
  }

  async function listAccounts(ownerSubject: string): Promise<ProviderAccountSummary[]> {
    if (!SUBJECT_REGEX.test(ownerSubject)) {
      throw new Error('Invalid owner subject.');
    }
    const sql = requireRunner();
    const rows = await sql.unsafe(
      'SELECT public.atax_mcp_provider_summary_v1($1) AS result',
      [ownerSubject]
    );
    const raw = rows[0]?.result;
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

  async function ensureOwnerPolicy(sql: SqlRunner, ownerSubject: string, actorSubject: string): Promise<void> {
    try {
      const cfgRows = await sql.unsafe('SELECT public.atax_mcp_runtime_config_v1() AS cfg', []);
      const cfg = cfgRows[0]?.cfg as { settings?: Record<string, unknown> } | undefined;
      const existingSettings =
        cfg && cfg.settings && typeof cfg.settings === 'object' && !Array.isArray(cfg.settings)
          ? { ...cfg.settings }
          : {};

      if (!existingSettings.MCP_OWNER_SUBJECT) {
        existingSettings.MCP_OWNER_SUBJECT = ownerSubject;
        await sql.unsafe('SELECT public.atax_mcp_set_settings_v1($1::jsonb, $2)', [
          JSON.stringify(existingSettings),
          actorSubject,
        ]);
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
    const sql = requireRunner();

    await ensureOwnerPolicy(sql, valid.ownerSubject, valid.actorSubject);

    const rows = await sql.unsafe(
      'SELECT public.atax_mcp_upsert_provider_v1($1, $2, $3, $4, $5, $6, $7) AS id',
      [
        valid.ownerSubject,
        valid.provider,
        valid.alias,
        valid.credential,
        valid.actorSubject,
        valid.accountId,
        valid.enabled,
      ]
    );

    const id = rows[0]?.id ? String(rows[0].id) : '';
    if (!id) {
      throw new Error('Supabase Vault did not return a credential reference.');
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
      throw new Error('Invalid subject.');
    }
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    const sql = requireRunner();
    await sql.unsafe(
      'SELECT public.atax_mcp_set_provider_enabled_v1($1, $2, $3, $4, $5)',
      [ownerSubject, provider, alias, Boolean(enabled), actorSubject]
    );
  }

  async function deleteAccount(
    ownerSubject: string,
    providerRaw: string,
    aliasRaw: string,
    actorSubject: string
  ): Promise<void> {
    if (!SUBJECT_REGEX.test(ownerSubject) || !SUBJECT_REGEX.test(actorSubject)) {
      throw new Error('Invalid subject.');
    }
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    const sql = requireRunner();
    await sql.unsafe('SELECT public.atax_mcp_delete_provider_v1($1, $2, $3, $4)', [
      ownerSubject,
      provider,
      alias,
      actorSubject,
    ]);
  }

  async function testAccountConnection(
    ownerSubject: string,
    providerRaw: string,
    aliasRaw: string
  ): Promise<ProviderTestResult> {
    if (!SUBJECT_REGEX.test(ownerSubject)) {
      throw new Error('Invalid owner subject.');
    }
    const { provider, alias } = validateProviderKey(providerRaw, aliasRaw);
    const sql = requireRunner();
    const rows = await sql.unsafe('SELECT public.atax_mcp_runtime_config_v1() AS cfg', []);
    const cfg = rows[0]?.cfg as
      | {
          settings?: Record<string, unknown>;
          accounts?: Array<{ provider: string; alias: string; token: string }>;
        }
      | undefined;

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
