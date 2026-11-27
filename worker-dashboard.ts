import { createSettingsControlPlane, dispatchSettingsRequest, jsonHeaders } from './server/settingsControlPlane.ts';
import { createSubstrateService } from './server/supabaseSubstrate.ts';
import { handleConsentApi, renderConsentPage } from './server/oauthConsent.ts';
import { createHandler as createMcpHandler } from './tools/atax-mcp/worker.mjs';
import { getVisualState, setVisualState } from './tools/atax-mcp/visual-store.mjs';

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders(), ...extraHeaders },
  });
}

async function substrateResponse(path: string, env: Record<string, unknown>) {
  const service = createSubstrateService(env as Record<string, string | undefined>);
  try {
    if (path === '/api/substrate/systems') return json(await service.getSystemsGraph());
    if (path === '/api/substrate/visions-goals') return json(await service.getVisionsGoalsGraph());
    if (path === '/api/substrate/worksockets') return json(await service.getWorkSockets());
    if (path === '/api/substrate/skills') return json(await service.getSkillsCatalog());
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supabase substrate unavailable.';
    const status =
      message.includes('ATAX_SUPABASE_URL') || message.includes('ATAX_SUPABASE_SECRET_KEY')
        ? 503
        : 502;
    return json({ error: message }, status);
  }
}

type SettingsFactory = (env: Record<string, string | undefined>) => ReturnType<typeof createSettingsControlPlane>;

export function createDashboardWorker(
  settingsFactory: SettingsFactory = (env) => createSettingsControlPlane(env)
) {
  const mcpHandler = createMcpHandler();

  return {
    async fetch(request: Request, env: Record<string, unknown> = {}, ctx?: unknown) {
      const url = new URL(request.url);

      if (
        url.pathname === '/mcp' ||
        url.pathname === '/socket' ||
        url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp' ||
        url.pathname === '/.well-known/oauth-authorization-server' ||
        url.pathname === '/.well-known/oauth-authorization-server/mcp' ||
        url.pathname === '/.well-known/openid-configuration'
      ) {
        return mcpHandler(request, env, ctx);
      }

      if (url.pathname === '/health') {
        const hasDataApiConfig =
          Boolean(env.ATAX_SUPABASE_URL || env.SUPABASE_URL) &&
          Boolean(env.ATAX_SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY);
        return json({
          service: 'atax',
          version: '1.1.0',
          status: 'ok',
          transports: ['dashboard', 'mcp', 'socket'],
          databaseTransport: hasDataApiConfig ? 'supabase-data-api' : 'unconfigured',
          settings: { routes: true, authentication: 'instance-passkey' },
        });
      }

      if (url.pathname === '/oauth/consent') {
        return renderConsentPage(env);
      }

      if (url.pathname === '/api/oauth/consent') {
        const result = await handleConsentApi(request, env);
        return json(result.body, result.status);
      }

      if (url.pathname.startsWith('/api/settings/')) {
        const controller = settingsFactory(env as Record<string, string | undefined>);
        const result = await dispatchSettingsRequest(request, controller);
        if (!result) return json({ error: 'Not found' }, 404);
        const extraHeaders = result.headers ? Object.fromEntries(result.headers.entries()) : {};
        return json(result.body, result.status, extraHeaders);
      }

      if (url.pathname === '/api/substrate/visual-state') {
        if (request.method === 'POST') {
          try {
            const body = await request.json();
            return json(setVisualState(body));
          } catch {
            return json({ error: 'Invalid visual state' }, 400);
          }
        }
        return json(getVisualState());
      }

      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        return substrateResponse(url.pathname, env);
      }

      const assets = env.ASSETS as { fetch: (req: Request) => Promise<Response> } | undefined;
      if (!assets) return json({ error: 'Static asset binding unavailable' }, 500);
      return assets.fetch(request);
    },
  };
}

export default createDashboardWorker();
