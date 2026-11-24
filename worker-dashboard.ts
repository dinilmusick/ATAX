import { createSubstrateService } from './server/supabaseSubstrate.ts';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: jsonHeaders,
  });
}

async function substrateResponse(path, env) {
  const service = createSubstrateService(env);
  try {
    if (path === '/api/substrate/systems') {
      return json(await service.getSystemsGraph());
    }
    if (path === '/api/substrate/visions-goals') {
      return json(await service.getVisionsGoalsGraph());
    }
    if (path === '/api/substrate/skills') {
      return json(await service.getSkillsCatalog());
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supabase substrate unavailable.';
    return json({ error: message }, message.includes('ATAX_SUPABASE_CONNECTION_URL') ? 503 : 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        service: 'atax-dashboard',
        status: 'ok',
        supabaseConfigured: typeof env.ATAX_SUPABASE_CONNECTION_URL === 'string' &&
          env.ATAX_SUPABASE_CONNECTION_URL.length > 0,
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405);
      }
      return substrateResponse(url.pathname, env);
    }

    if (!env.ASSETS) {
      return json({ error: 'Static asset binding unavailable' }, 500);
    }

    return env.ASSETS.fetch(request);
  },
};
