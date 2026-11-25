import { createSubstrateService } from './server/supabaseSubstrate.ts';
import { createSettingsControlPlane, jsonHeaders } from './server/settingsControlPlane.ts';
import { createHandler as createMcpHandler } from './tools/atax-mcp/worker.mjs';

function json(value: unknown, status = 200, extraHeaders: Record<string,string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders(), ...extraHeaders },
  });
}

async function readJson(request: Request): Promise<Record<string,unknown>> {
  const length=Number(request.headers.get('content-length')||0);
  if(length>64*1024) throw new Error('Request body too large.');
  const text=await request.text();
  if(new TextEncoder().encode(text).length>64*1024) throw new Error('Request body too large.');
  const body=JSON.parse(text||'{}');
  if(!body || typeof body!=='object' || Array.isArray(body)) throw new Error('JSON object required.');
  return body as Record<string,unknown>;
}

async function settingsResponse(request: Request, env: Record<string,unknown>) {
  const controller=createSettingsControlPlane(env as Record<string,string|undefined>);

  if(request.method==='GET' && new URL(request.url).pathname==='/api/settings/status'){
    const result=await controller.status(request);
    return json(result.status,result.httpStatus);
  }

  if(request.method==='POST' && new URL(request.url).pathname==='/api/settings/auth/unlock'){
    try{
      const body=await readJson(request);
      const result=await controller.unlock(request,typeof body.passkey==='string'?body.passkey:'');
      return json(result.body,result.status,Object.fromEntries(result.headers.entries()));
    }catch(err){
      return json({error:err instanceof Error?err.message:'Invalid request.'},400);
    }
  }

  if(request.method==='POST' && new URL(request.url).pathname==='/api/settings/auth/logout'){
    const result=await controller.logout(request);
    return json(result.body,result.status,Object.fromEntries(result.headers.entries()));
  }

  if(request.method==='GET' && new URL(request.url).pathname==='/api/settings/providers'){
    const result=await controller.listProviders(request);
    return json(result.body,result.status);
  }

  if(request.method==='POST' && new URL(request.url).pathname==='/api/settings/providers'){
    try{
      const body=await readJson(request);
      const result=await controller.upsertProvider(request,body);
      return json(result.body,result.status);
    }catch(err){
      return json({error:err instanceof Error?err.message:'Invalid request.'},400);
    }
  }

  const match=new URL(request.url).pathname.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)\/test$/);
  if(match && request.method==='POST'){
    const result=await controller.testProvider(request,decodeURIComponent(match[1]),decodeURIComponent(match[2]));
    return json(result.body,result.status);
  }

  const enabledMatch=new URL(request.url).pathname.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)\/enabled$/);
  if(enabledMatch && request.method==='PATCH'){
    try{
      const body=await readJson(request);
      const result=await controller.setEnabled(request,decodeURIComponent(enabledMatch[1]),decodeURIComponent(enabledMatch[2]),body.enabled);
      return json(result.body,result.status);
    }catch(err){
      return json({error:err instanceof Error?err.message:'Invalid request.'},400);
    }
  }

  const deleteMatch=new URL(request.url).pathname.match(/^\/api\/settings\/providers\/([^/]+)\/([^/]+)$/);
  if(deleteMatch && request.method==='DELETE'){
    const result=await controller.deleteProvider(request,decodeURIComponent(deleteMatch[1]),decodeURIComponent(deleteMatch[2]));
    return json(result.body,result.status);
  }

  return null;
}

async function substrateResponse(path: string, env: Record<string,unknown>) {
  const service = createSubstrateService(env as Record<string,string|undefined>);
  try {
    if (path === '/api/substrate/systems') return json(await service.getSystemsGraph());
    if (path === '/api/substrate/visions-goals') return json(await service.getVisionsGoalsGraph());
    if (path === '/api/substrate/skills') return json(await service.getSkillsCatalog());
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supabase substrate unavailable.';
    const status =
      message.includes('ATAX_SUPABASE_CONNECTION_URL')
        ? 503
        : 502;
    return json({ error: message }, status);
  }
}

const mcpHandler = createMcpHandler();

export default {
  async fetch(request: Request, env: Record<string,unknown>) {
    const url = new URL(request.url);

    if (
      url.pathname === '/mcp' ||
      url.pathname === '/socket' ||
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      return mcpHandler(request, env);
    }

    if (url.pathname === '/health') {
      const configured=Boolean(env.ATAX_SUPABASE_CONNECTION_URL);
      return json({
        service: 'atax',
        version: '1.1.0',
        status: 'ok',
        transports: ['dashboard', 'mcp', 'socket'],
        databaseTransport: configured ? 'postgresql' : 'unconfigured',
        settings: {routes:true, authentication:'instance-passkey'},
      });
    }

    if (url.pathname.startsWith('/api/settings/')) {
      const response=await settingsResponse(request,env);
      return response || json({error:'Not found'},404);
    }

    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return substrateResponse(url.pathname, env);
    }

    if (!env.ASSETS) return json({ error: 'Static asset binding unavailable' }, 500);
    return env.ASSETS.fetch(request);
  },
};
