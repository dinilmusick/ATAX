/**
 * Single server-side bootstrap for ATAX remote MCP.
 *
 * SUPABASE_URL is the ONLY deployment environment binding consumed here.
 * It is a secret URL: https://<project>.supabase.co/#key=<server-key>
 * The fragment is NEVER transmitted to Supabase. Never place this URL in a
 * browser bundle, wrangler [vars], logs, GitHub issues, or API responses.
 */
const CONFIG_RPC = '/rest/v1/rpc/atax_mcp_runtime_config_v1';
const MAX_CONFIG_BYTES = 524288;
const ALIAS = /^[A-Z][A-Z0-9_]{0,47}$/;
const ALLOWED_SETTINGS = new Set([
  'MCP_GITHUB_OWNER','MCP_FMRL_ALLOWED_TARGETS',
  'MCP_SHARED_TOKEN_SHA256','MCP_SHARED_SUBJECT','MCP_SHARED_SCOPES',
  'MCP_ATAX_OWNER_JWT_SUBJECT','MCP_AUTH_OWNER_SCOPES',
  'MCP_AUTH_AUTHORIZATION_SERVER','MCP_AUTH_ISSUER',
  'MCP_AUTH_JWKS_URL','MCP_AUTH_AUDIENCE','MCP_ALLOWED_ORIGINS',
  'SOCKET_AUTH_ISSUER','SOCKET_AUTH_JWKS_URL',
  'SOCKET_AUTH_AUDIENCE','SOCKET_AUTH_CLIENT_ID',
  'SOCKET_WORKFLOW_CATALOG_JSON','SOCKET_MODEL_ID'
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseLedgerBootstrap(env) {
  const raw=env?.SUPABASE_URL;
  if(typeof raw!=='string'||raw.length>4096||raw.length<48)
    throw Error('Canonical ledger bootstrap unavailable');
  let url;
  try{url=new URL(raw);}catch{throw Error('Invalid canonical ledger bootstrap URL');}
  if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||
     url.hostname==='.supabase.co'||url.username||url.password||
     url.search||url.pathname!=='/')
    throw Error('Invalid canonical ledger bootstrap origin');
  const parts=new URLSearchParams(url.hash.slice(1));
  const token=parts.get('key');
  if(parts.size!==1||!token||!/^[A-Za-z0-9._-]{20,2048}$/.test(token))
    throw Error('Missing canonical ledger bootstrap credential');
  return {origin:url.origin,secret:token};
}

async function boundedJson(response) {
  if(!response.ok)throw Error('Canonical ledger configuration unavailable');
  if(Number(response.headers.get('content-length')||0)>MAX_CONFIG_BYTES)
    throw Error('Canonical ledger configuration too large');
  if(!response.body)throw Error('Canonical ledger configuration empty');
  const reader=response.body.getReader();
  const chunks=[];let total=0;
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>MAX_CONFIG_BYTES){await reader.cancel();throw Error('Canonical ledger configuration too large');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const data=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
  catch{throw Error('Canonical ledger configuration invalid');}
}

/**
 * Service-role-only RPC returns vetted policy and active Vault credentials.
 * The returned internal object is NOT deployment environment configuration;
 * it is a per-request server-side value for existing MCP adapters.
 */
export async function loadMcpRuntimeConfig(bootstrapEnv,fetcher=fetch) {
  const {origin,secret}=parseLedgerBootstrap(bootstrapEnv);
  const headers={'apikey':secret,'content-type':'application/json','accept':'application/json'};
  if(!secret.startsWith('sb_secret_'))headers.authorization='Bearer '+secret;
  const response=await fetcher(origin+CONFIG_RPC,{
    method:'POST',redirect:'error',headers,body:'{}'
  });
  const config=await boundedJson(response);
  if(!object(config)||!object(config.settings)||!Array.isArray(config.accounts))
    throw Error('Canonical ledger configuration missing');
  const resolved={SUPABASE_URL:origin,SUPABASE_SECRET_KEY:secret};
  for(const [key,value] of Object.entries(config.settings)) {
    if(!ALLOWED_SETTINGS.has(key)||typeof value!=='string'||value.length>16384)
      throw Error('Canonical ledger settings rejected');
    resolved[key]=value;
  }
  const used=new Set();
  for(const account of config.accounts) {
    if(!object(account)||!['github','cloudflare','vercel'].includes(account.provider)||
       typeof account.alias!=='string'||!ALIAS.test(account.alias)||
       typeof account.token!=='string'||account.token.length<16||
       account.token.length>8192)
      throw Error('Canonical ledger provider account rejected');
    const identity=account.provider+':'+account.alias;
    if(used.has(identity))throw Error('Duplicate canonical ledger provider account');
    used.add(identity);
    // Vercel is deliberately stored for the future UI adapter, but not
    // exposed as an operational MCP credential until that adapter exists.
    if(account.provider==='vercel')continue;
    const prefix=account.provider==='github'?'GH_KEY_':'CF_KEY_';
    resolved[prefix+account.alias]=account.token;
    if(account.provider==='cloudflare' && account.accountId!==null &&
       account.accountId!==undefined) {
      if(typeof account.accountId!=='string'||
         !/^[A-Za-z0-9_-]{1,128}$/.test(account.accountId))
        throw Error('Invalid canonical Cloudflare account binding');
      resolved['CLOUDFLARE_ACCOUNT_ID_'+account.alias]=account.accountId;
    }
  }
  return resolved;
}
