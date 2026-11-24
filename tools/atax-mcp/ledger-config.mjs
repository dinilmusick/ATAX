import {openLedger} from './pg-ledger.mjs';

/** Database-held server policy and Vault secrets, never deployment env vars. */
const ALIAS=/^[A-Z][A-Z0-9_]{0,47}$/;
const SETTINGS=new Set([
  'MCP_OWNER_SUBJECT','MCP_GITHUB_OWNER','MCP_FMRL_ALLOWED_TARGETS',
  'MCP_SHARED_TOKEN_SHA256','MCP_SHARED_SUBJECT','MCP_SHARED_SCOPES',
  'MCP_ATAX_OWNER_JWT_SUBJECT','MCP_AUTH_OWNER_SCOPES',
  'MCP_AUTH_AUTHORIZATION_SERVER','MCP_AUTH_ISSUER','MCP_AUTH_JWKS_URL',
  'MCP_AUTH_AUDIENCE','MCP_ALLOWED_ORIGINS',
  'SOCKET_AUTH_ISSUER','SOCKET_AUTH_JWKS_URL','SOCKET_AUTH_AUDIENCE',
  'SOCKET_AUTH_CLIENT_ID','SOCKET_WORKFLOW_CATALOG_JSON','SOCKET_MODEL_ID'
]);
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

/** Use openLedger() by default, inject a fake for isolated tests only. */
export async function loadMcpRuntimeConfig(bootstrapEnv,open=openLedger) {
  const db=await open(bootstrapEnv);
  const config=await db.rpc('atax_mcp_runtime_config_v1',{});
  if(!obj(config)||!obj(config.settings)||!Array.isArray(config.accounts))
    throw Error('Canonical MCP policy unavailable');
  const resolved={__ledgerDb:db};
  for(const [key,value] of Object.entries(config.settings)){
    if(!SETTINGS.has(key)||typeof value!=='string'||value.length>16384)
      throw Error('Invalid canonical MCP settings');
    resolved[key]=value;
  }
  const used=new Set();
  for(const account of config.accounts){
    if(!obj(account)||!['github','cloudflare','vercel'].includes(account.provider)||
       typeof account.alias!=='string'||!ALIAS.test(account.alias)||
       typeof account.token!=='string'||account.token.length<16||account.token.length>8192)
      throw Error('Invalid canonical provider credential');
    const name=account.provider+':'+account.alias;
    if(used.has(name))throw Error('Duplicate canonical provider account');
    used.add(name);
    // Vercel secrets can be stored but are deliberately not an operating
    // MCP adapter until independently tested.
    if(account.provider==='vercel')continue;
    const prefix=account.provider==='github'?'GH_KEY_':'CF_KEY_';
    resolved[prefix+account.alias]=account.token;
    if(account.provider==='cloudflare'&&account.accountId!==null&&account.accountId!==undefined){
      if(typeof account.accountId!=='string'||
         !/^[A-Za-z0-9_-]{1,128}$/.test(account.accountId))
        throw Error('Invalid canonical Cloudflare account ID');
      resolved['CLOUDFLARE_ACCOUNT_ID_'+account.alias]=account.accountId;
    }
  }
  return resolved;
}

/** Restricted sockets receive ONLY socket policy and a narrowly granted DB RPC adapter.
 * No GitHub, Cloudflare, Vercel, maintainer bearer hashes, or privileged Vault reads.
 */
export async function loadSocketRuntimeConfig(bootstrapEnv,open=openLedger) {
  const db=await open(bootstrapEnv);
  const settings=await db.rpc('atax_mcp_socket_config_v1',{});
  if(!obj(settings))throw Error('Restricted socket policy unavailable');
  const resolved={__ledgerDb:db};
  for(const [key,value] of Object.entries(settings)){
    if(!key.startsWith('SOCKET_')||!SETTINGS.has(key)||
       typeof value!=='string'||value.length>16384)
      throw Error('Invalid restricted socket policy');
    resolved[key]=value;
  }
  return resolved;
}
