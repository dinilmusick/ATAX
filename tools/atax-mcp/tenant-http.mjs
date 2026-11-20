/** Same-origin, bearer-authenticated setup API. Secrets are entered in a browser,
 * never via LLM tool arguments, URLs, chats, or hosted MCP resources. */
import {invite,revokeInvite,listInvites,listConnections,saveConnection,deleteConnection} from './tenant-store.mjs';
const security={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY'};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...security,'content-type':'application/json; charset=utf-8'}});
async function data(req){
  if(!req.headers.get('content-type')?.startsWith('application/json'))throw Error('application/json required');
  if(Number(req.headers.get('content-length')||0)>12000)throw Error('Payload too large');
  const raw=await req.text();if(raw.length>12000)throw Error('Payload too large');
  const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Object expected');
  return parsed;
}
export async function tenantApi(req,env,principal,fetcher=fetch){
  const u=new URL(req.url),path=u.pathname;
  if(req.headers.get('origin') && req.headers.get('origin')!==u.origin)return reply({error:'Cross-origin setup is forbidden'},403);
  try {
    if(path==='/api/self' && req.method==='GET')return reply({subject:principal.id,scopes:[...principal.scopes].sort()});
    if(path==='/api/connections' && req.method==='GET')return reply(await listConnections(env,principal));
    if(path==='/api/connections' && req.method==='POST')return reply(await saveConnection(env,principal,await data(req),fetcher),201);
    if(path.startsWith('/api/connections/') && req.method==='DELETE'){
      const segments=path.split('/');
      if(segments.length!==5)return reply({error:'Invalid connection path'},404);
      return reply(await deleteConnection(env,principal,segments[3],segments[4]));
    }
    if(path==='/api/admin/invites' && req.method==='GET')return reply(await listInvites(env,principal));
    if(path==='/api/admin/invites' && req.method==='POST')return reply(await invite(env,principal,await data(req)),201);
    if(path.startsWith('/api/admin/invites/') && req.method==='DELETE'){
      const segments=path.split('/');
      if(segments.length!==5)return reply({error:'Invalid invite path'},404);
      return reply(await revokeInvite(env,principal,decodeURIComponent(segments[4])));
    }
    return reply({error:'Unknown setup operation'},404);
  }catch(e){
    const message=String(e?.message||'Setup operation failed');
    // Database and credential faults may not be returned verbatim.
    const safe=/^(Invalid |Unsupported |Supabase URL |Provider credential |GitHub credential |Administrator |Cannot revoke|Credential decryption failed|application\/json|Payload too large|Object expected|Tenant encryption key)/.test(message);
    return reply({error:safe?message.slice(0,160):'Setup request failed'},safe?400:503);
  }
}
export function setupPage(){
 const nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
 const content=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATAX connection setup</title>
 <style nonce="${nonce}">body{max-width:680px;margin:2rem auto;font:16px system-ui;padding:1rem;color:#171923}input,select,button{display:block;width:100%;box-sizing:border-box;font:inherit;padding:.65rem;margin:.5rem 0 1rem;border:1px solid #999;border-radius:6px}button{background:#252b41;color:white;cursor:pointer}small{color:#555}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f3f5;padding:1rem}label{font-weight:600}</style>
 </head><body><h1>ATAX · Private connection setup</h1>
 <p>Only invited, authenticated developers can save connections. Enter your individual <strong>revocable ATAX invitation key</strong>, or an OAuth access token from an approved identity provider. The credential remains in this page's memory; it is never stored by the browser.</p>
 <label>Invite key or OAuth token (never paste into chat)<input id="access" type="password" autocomplete="off"></label>
 <button id="check">Check access</button>
 <label>Provider<select id="provider"><option value="supabase">Supabase</option><option value="github">GitHub</option><option value="cloudflare">Cloudflare</option><option value="vercel">Vercel</option></select></label>
 <label>Account alias (UPPERCASE)<input id="alias" value="DEFAULT" maxlength="48"></label>
 <label>Supabase project URL (only for Supabase)<input id="url" placeholder="https://your-project.supabase.co"></label>
 <label>Cloudflare account ID (optional) / Vercel team ID (optional)<input id="scope" placeholder="Account or team ID"></label>
 <label>Scoped credential (never paste into chat)<input id="credential" type="password" autocomplete="off"></label>
 <button id="save">Store or rotate encrypted connection</button><button id="list">List my connection metadata</button>
 <small>Use a dedicated Supabase project and least-privilege provider tokens. ATAX never displays stored token values. Removing an invite revokes access and deletes its connections. Provider scope changes may require token rotation. Do not supply your production credentials to anyone else.</small><pre id="out" role="status"></pre>
 <script nonce="${nonce}">
 const el=id=>document.getElementById(id);const out=v=>el('out').textContent=JSON.stringify(v,null,2);
 async function call(path,method='GET',data){
   const token=el('access').value.trim();if(!token)throw Error('Enter a valid access token');
   const r=await fetch(path,{method,headers:{'Authorization':'Bearer '+token,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),cache:'no-store',credentials:'omit',redirect:'error'});
   const j=await r.json();if(!r.ok)throw Error(j.error||'HTTP '+r.status);return j;
 }
 el('check').onclick=async()=>{try{out(await call('/api/self'))}catch(e){out({error:e.message})}};
 el('list').onclick=async()=>{try{out(await call('/api/connections'))}catch(e){out({error:e.message})}};
 el('save').onclick=async()=>{
   try{
     const provider=el('provider').value,alias=el('alias').value.trim().toUpperCase();
     const payload={provider,alias,token:el('credential').value};
     if(provider==='supabase')payload.url=el('url').value.trim();
     if(provider==='cloudflare'&&el('scope').value.trim())payload.account_id=el('scope').value.trim();
     if(provider==='vercel'&&el('scope').value.trim())payload.team_id=el('scope').value.trim();
     const result=await call('/api/connections','POST',payload);el('credential').value='';out(result);
   }catch(e){out({error:e.message})}
 };
 </script></body></html>`;
 return new Response(content,{status:200,headers:{...security,'content-type':'text/html; charset=utf-8','content-security-policy':`default-src 'none'; connect-src 'self'; form-action 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`}});
}
