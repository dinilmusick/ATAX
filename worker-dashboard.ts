import { createSubstrateService } from './server/supabaseSubstrate.ts';
import { createHandler as createMcpHandler } from './tools/atax-mcp/worker.mjs';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

async function substrateResponse(path, env) {
  const service = createSubstrateService(env);
  try {
    if (path === '/api/substrate/systems') return json(await service.getSystemsGraph());
    if (path === '/api/substrate/visions-goals') return json(await service.getVisionsGoalsGraph());
    if (path === '/api/substrate/skills') return json(await service.getSkillsCatalog());
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supabase substrate unavailable.';
    const status = message.includes('ATAX_SUPABASE_CONNECTION_URL') ? 503 : 502;
    return json({ error: message }, status);
  }
}

const mcpHandler = createMcpHandler();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      url.pathname === '/mcp' ||
      url.pathname === '/socket' ||
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      return mcpHandler(request, env, ctx);
    }

    if (url.pathname === '/health') {
      return json({
        service: 'atax',
        version: '1.0.3',
        status: 'ok',
        transports: ['dashboard', 'mcp', 'socket'],
        databaseTransport:
          env.HYPERDRIVE &&
          typeof env.HYPERDRIVE.connectionString === 'string' &&
          env.HYPERDRIVE.connectionString.length > 0
            ? 'cloudflare-hyperdrive'
            : 'unconfigured',
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return substrateResponse(url.pathname, env);
    }

    if (!env.ASSETS) return json({ error: 'Static asset binding unavailable' }, 500);
    return env.ASSETS.fetch(request);
  },
};
