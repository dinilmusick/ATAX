import { openControlPlaneLedger, type LedgerDb } from '../tools/atax-mcp/data-api-ledger.mjs';
import { createVaultService, inspectSupabaseConnection, VaultError } from './supabaseVault.ts';

export const SETTINGS_SESSION_COOKIE = 'atax_settings_session';
export const SETTINGS_SESSION_TTL_SECONDS = 30 * 60;

export interface SettingsStatus {
  backend: { configured: boolean; reachable: boolean };
  authentication: { required: true; authenticated: boolean };
  providers: { github: boolean; cloudflare: boolean; vercel: false };
}

function headerValue(headers: Headers | Record<string, string | undefined>, key: string): string | null {
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

export function parseCookies(headers: Headers): Record<string, string> {
  const raw = headers.get('cookie') || '';
  const result: Record<string, string> = {};
  for (const piece of raw.split(';')) {
    const idx = piece.indexOf('=');
    if (idx < 0) continue;
    const key = piece.slice(0, idx).trim();
    const value = piece.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function cookieHeader(token: string, maxAge: number, requestUrl: string): string {
  const isHttps = (() => {
    try {
      return new URL(requestUrl).protocol === 'https:';
    } catch {
      return true;
    }
  })();
  return [
    `${SETTINGS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    ...(isHttps ? ['Secure'] : []),
    'SameSite=Strict',
  ].join('; ');
}

function baseStatus(configured: boolean, reachable: boolean, authenticated: boolean): SettingsStatus {
  return {
    backend: { configured, reachable },
    authentication: { required: true, authenticated },
    providers: { github: true, cloudflare: true, vercel: false },
  };
}

export type LedgerFactory = (
  env?: Record<string, string | undefined>,
  fetcher?: typeof fetch
) => Promise<Pick<LedgerDb, 'rpc' | 'ping'>>;
export type VaultFactory = (env: Record<string, string | undefined>, fetcher: typeof fetch) => ReturnType<typeof createVaultService>;

export function createSettingsControlPlane(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
  ledgerFactory: LedgerFactory = openControlPlaneLedger,
  vaultFactory: VaultFactory = (e, f) => createVaultService(e, f, ledgerFactory)
) {
  const vault = vaultFactory(env, fetcher);

  async function db(): Promise<Pick<LedgerDb, 'rpc' | 'ping'>> {
    const inspection = inspectSupabaseConnection(env);
    if (!inspection.configured) {
      throw new VaultError(inspection.error || 'Supabase backend is not configured.', 503);
    }
    return ledgerFactory(env, fetcher);
  }

  async function sessionHashFromRequest(request: Request): Promise<string | null> {
    const cookies = parseCookies(request.headers);
    const token = cookies[SETTINGS_SESSION_COOKIE];
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    return sha256Hex(token);
  }

  async function authenticated(request: Request): Promise<boolean> {
    const hash = await sessionHashFromRequest(request);
    if (!hash) return false;
    try {
      const connection = await db();
      return Boolean(await connection.rpc('atax_mcp_validate_instance_session_v1', { session_hash_in: hash }));
    } catch {
      return false;
    }
  }

  async function status(request: Request): Promise<{ status: SettingsStatus; httpStatus: number }> {
    const inspection = inspectSupabaseConnection(env);
    if (!inspection.configured) {
      return { status: baseStatus(false, false, false), httpStatus: 503 };
    }
    try {
      const connection = await db();
      const authStatus = (await connection.rpc('atax_mcp_instance_auth_status_v1', {})) as
        | { passkeyConfigured?: boolean }
        | null;
      const hash = await sessionHashFromRequest(request);
      const isAuthenticated = hash
        ? Boolean(await connection.rpc('atax_mcp_validate_instance_session_v1', { session_hash_in: hash }))
        : false;
      return {
        status: baseStatus(true, authStatus !== null && typeof authStatus === 'object', isAuthenticated),
        httpStatus: 200,
      };
    } catch {
      return { status: baseStatus(true, false, false), httpStatus: 503 };
    }
  }

  async function unlock(
    request: Request,
    passkey: string
  ): Promise<{ body: Record<string, unknown>; headers: Headers; status: number }> {
    if (!sameOriginRequest(request)) {
      return { body: { error: 'Cross-origin request rejected.' }, headers: new Headers(), status: 403 };
    }
    if (typeof passkey !== 'string' || passkey.length < 12 || passkey.length > 256) {
      return { body: { error: 'Invalid passkey.' }, headers: new Headers(), status: 400 };
    }
    try {
      const connection = await db();
      const result = (await connection.rpc('atax_mcp_verify_instance_passkey_v1', {
        passkey_in: passkey,
      })) as { ok?: boolean; reason?: string } | null;

      if (!result?.ok) {
        const reason = result?.reason;
        if (reason === 'unconfigured') {
          return { body: { error: 'Instance passkey is not initialized.' }, headers: new Headers(), status: 503 };
        }
        if (reason === 'locked') {
          return { body: { error: 'Passkey temporarily locked.' }, headers: new Headers(), status: 429 };
        }
        return { body: { error: 'Invalid passkey.' }, headers: new Headers(), status: 401 };
      }

      const rawToken = randomToken();
      const hash = await sha256Hex(rawToken);
      const expiresAt = new Date(Date.now() + SETTINGS_SESSION_TTL_SECONDS * 1000).toISOString();
      await connection.rpc('atax_mcp_create_instance_session_v1', {
        session_hash_in: hash,
        expires_at_in: expiresAt,
      });
      const headers = new Headers();
      headers.set('Set-Cookie', cookieHeader(rawToken, SETTINGS_SESSION_TTL_SECONDS, request.url));
      return { body: { ok: true, authenticated: true, expiresAt }, headers, status: 200 };
    } catch (err) {
      if (err instanceof VaultError) {
        return { body: { error: err.message }, headers: new Headers(), status: err.statusCode };
      }
      return { body: { error: 'Supabase backend unavailable.' }, headers: new Headers(), status: 503 };
    }
  }

  async function logout(request: Request): Promise<{ body: Record<string, unknown>; headers: Headers; status: number }> {
    if (!sameOriginRequest(request)) {
      return { body: { error: 'Cross-origin request rejected.' }, headers: new Headers(), status: 403 };
    }
    const hash = await sessionHashFromRequest(request);
    if (hash) {
      try {
        const connection = await db();
        await connection.rpc('atax_mcp_revoke_instance_session_v1', { session_hash_in: hash });
      } catch {
        // Always clear client cookie on logout
      }
    }
    const headers = new Headers();
    headers.set('Set-Cookie', cookieHeader('', 0, request.url));
    return { body: { ok: true }, headers, status: 200 };
  }

  async function requireSession(request: Request): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    let connection: Pick<LedgerDb, 'rpc' | 'ping'>;
    try {
      connection = await db();
    } catch (err) {
      const statusCode = err instanceof VaultError ? err.statusCode : 503;
      return { ok: false, status: statusCode, error: 'Supabase backend unavailable.' };
    }

    const hash = await sessionHashFromRequest(request);
    if (!hash) return { ok: false, status: 401, error: 'Instance authentication required.' };

    try {
      const valid = Boolean(
        await connection.rpc('atax_mcp_validate_instance_session_v1', { session_hash_in: hash })
      );
      if (!valid) return { ok: false, status: 401, error: 'Instance authentication required.' };
      return { ok: true };
    } catch {
      return { ok: false, status: 503, error: 'Supabase backend unavailable.' };
    }
  }

  async function listProviders(request: Request) {
    const auth = await requireSession(request);
    if (!auth.ok) return { body: { error: auth.error }, status: auth.status };
    try {
      return { body: { accounts: await vault.listAccounts() }, status: 200 };
    } catch (err) {
      return {
        body: { error: err instanceof Error ? err.message : 'Provider registry unavailable.' },
        status: err instanceof VaultError ? err.statusCode : 502,
      };
    }
  }

  async function upsertProvider(request: Request, body: Record<string, unknown>) {
    if (!sameOriginRequest(request)) {
      return { body: { error: 'Cross-origin mutation rejected.' }, status: 403 };
    }
    const auth = await requireSession(request);
    if (!auth.ok) return { body: { error: auth.error }, status: auth.status };
    try {
      const saved = await vault.upsertSecret({
        provider: String(body.provider || ''),
        alias: String(body.alias || ''),
        credential: String(body.credential || ''),
        accountId: typeof body.accountId === 'string' ? body.accountId : null,
        enabled: body.enabled !== false,
      });
      return { body: { account: saved }, status: 201 };
    } catch (err) {
      return {
        body: { error: err instanceof Error ? err.message : 'Failed to store provider credential.' },
        status: err instanceof VaultError ? err.statusCode : 502,
      };
    }
  }

  async function setEnabled(request: Request, provider: string, alias: string, enabled: unknown) {
    if (!sameOriginRequest(request)) {
      return { body: { error: 'Cross-origin mutation rejected.' }, status: 403 };
    }
    const auth = await requireSession(request);
    if (!auth.ok) return { body: { error: auth.error }, status: auth.status };
    if (typeof enabled !== 'boolean') {
      return { body: { error: 'Boolean enabled field is required.' }, status: 400 };
    }
    try {
      await vault.setAccountEnabled(undefined, provider, alias, enabled);
      return { body: { ok: true }, status: 200 };
    } catch (err) {
      return {
        body: { error: err instanceof Error ? err.message : 'Failed to update provider state.' },
        status: err instanceof VaultError ? err.statusCode : 502,
      };
    }
  }

  async function deleteProvider(request: Request, provider: string, alias: string) {
    if (!sameOriginRequest(request)) {
      return { body: { error: 'Cross-origin mutation rejected.' }, status: 403 };
    }
    const auth = await requireSession(request);
    if (!auth.ok) return { body: { error: auth.error }, status: auth.status };
    try {
      await vault.deleteAccount(undefined, provider, alias);
      return { body: { ok: true }, status: 200 };
    } catch (err) {
      return {
        body: { error: err instanceof Error ? err.message : 'Failed to delete provider credential.' },
        status: err instanceof VaultError ? err.statusCode : 502,
      };
    }
  }

  async function testProvider(request: Request, provider: string, alias: string) {
    const auth = await requireSession(request);
    if (!auth.ok) return { body: { error: auth.error }, status: auth.status };
    try {
      return { body: await vault.testAccountConnection(undefined, provider, alias), status: 200 };
    } catch (err) {
      return {
        body: { error: err instanceof Error ? err.message : 'Provider test failed.' },
        status: err instanceof VaultError ? err.statusCode : 502,
      };
    }
  }

  return {
    status,
    unlock,
    logout,
    listProviders,
    upsertProvider,
    setEnabled,
    deleteProvider,
    testProvider,
    authenticated,
  };
}

export function jsonHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}

export async function dispatchSettingsRequest(
  request: Request,
  controller: ReturnType<typeof createSettingsControlPlane>
): Promise<{ status: number; body: unknown; headers?: Headers } | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  const readJson = async () => {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Request body must be a JSON object.');
    }
    return body;
  };

  if (request.method === 'GET' && path === '/api/settings/status') {
    const result = await controller.status(request);
    return { status: result.httpStatus, body: result.status };
  }

  if (request.method === 'POST' && path === '/api/settings/auth/unlock') {
    try {
      const body = await readJson();
      const result = await controller.unlock(request, typeof body.passkey === 'string' ? body.passkey : '');
      return { status: result.status, body: result.body, headers: result.headers };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : 'Invalid request.' } };
    }
  }

  if (request.method === 'POST' && path === '/api/settings/auth/logout') {
    const result = await controller.logout(request);
    return { status: result.status, body: result.body, headers: result.headers };
  }

  if (request.method === 'GET' && path === '/api/settings/providers') {
    const result = await controller.listProviders(request);
    return { status: result.status, body: result.body };
  }

  if (request.method === 'POST' && path === '/api/settings/providers') {
    try {
      const body = await readJson();
      const result = await controller.upsertProvider(request, body);
      return { status: result.status, body: result.body };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : 'Invalid request.' } };
    }
  }

  const testMatch = path.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)\/test$/);
  if (testMatch && request.method === 'POST') {
    const result = await controller.testProvider(
      request,
      decodeURIComponent(testMatch[1]),
      decodeURIComponent(testMatch[2])
    );
    return { status: result.status, body: result.body };
  }

  const enabledMatch = path.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)\/enabled$/);
  if (enabledMatch && request.method === 'PATCH') {
    try {
      const body = await readJson();
      const result = await controller.setEnabled(
        request,
        decodeURIComponent(enabledMatch[1]),
        decodeURIComponent(enabledMatch[2]),
        body.enabled
      );
      return { status: result.status, body: result.body };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : 'Invalid request.' } };
    }
  }

  const deleteMatch = path.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)$/);
  if (deleteMatch && request.method === 'DELETE') {
    const result = await controller.deleteProvider(
      request,
      decodeURIComponent(deleteMatch[1]),
      decodeURIComponent(deleteMatch[2])
    );
    return { status: result.status, body: result.body };
  }

  return null;
}

export { headerValue, sameOriginRequest as isSameOriginRequest };
