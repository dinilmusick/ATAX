/** Named provider credentials for one ATAX Worker. Tokens never leave this module. */
const PREFIX = Object.freeze({github:['GH_KEY_','GH_TOKEN_'],cloudflare:['CF_KEY_','CLOUDFLARE_TOKEN_']});
const ALIAS = /^[A-Z][A-Z0-9_]{0,47}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const tool = (name,description,scope,inputSchema,invoke)=>({name,description,scope,inputSchema,invoke});
const schema = (properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const accountArg = {type:'string',maxLength:48,description:'Optional named account alias (GH_KEY_<ALIAS> or CF_KEY_<ALIAS>); required when multiple accounts are configured'};
const accountSchema = (other={},required=[])=>schema({account:accountArg,...other},required);

/** A single configured owner may use provider credentials; OAuth subjects are verified by the gateway. */
export function isOwnerPrincipal(env,principal) {
  if (!env || !principal) return false;
  if (principal.authMethod==='shared')
    return !!env.MCP_SHARED_TOKEN_SHA256 && principal.id===String(env.MCP_SHARED_SUBJECT||'atax-mcp-operator');
  const owner=String(env.MCP_ATAX_OWNER_JWT_SUBJECT||'').trim();
  return principal.authMethod==='jwt' && owner.length>=3 && principal.ownerSubject===owner;
}
function configuredAccounts(env,provider) {
  const prefixes=PREFIX[provider];
  if (!prefixes) throw new Error('Unknown provider');
  const found=new Map();
  for(const prefix of prefixes) for(const key of Object.keys(env||{})) {
    if(!key.startsWith(prefix))continue;
    const alias=key.slice(prefix.length);
    if(!ALIAS.test(alias) || typeof env[key]!=='string' || !env[key].trim())continue;
    // Multiple credentials for one alias are ambiguous: never silently choose one.
    if(found.has(alias))throw new Error('Duplicate provider account alias: '+alias);
    found.set(alias,{alias,token:env[key]});
  }
  return found;
}
export function availableAccounts(env,principal,provider) {
  if(!PREFIX[provider])throw new Error('Unknown provider');
  if(!isOwnerPrincipal(env,principal))return [];
  return [...configuredAccounts(env,provider).keys()].sort();
}
export function resolveProviderAccount(env,principal,provider,requested) {
  if(!isOwnerPrincipal(env,principal))throw new Error('Provider account unavailable or not authorized');
  const accounts=configuredAccounts(env,provider);
  if(requested!==undefined && (typeof requested!=='string'||!ALIAS.test(requested.toUpperCase())))
    throw new Error('Invalid account alias');
  const names=[...accounts.keys()];
  const alias=requested===undefined?(names.length===1?names[0]:null):requested.toUpperCase();
  if(alias && accounts.has(alias))return accounts.get(alias);
  if(!alias && names.length>1)throw new Error('Specify an account alias when multiple accounts are configured');
  throw new Error('Provider account unavailable or not authorized');
}
function safeAccounts(env,principal){
  return {accounts:Object.keys(PREFIX).map(provider=>({
    provider,aliases:availableAccounts(env,principal,provider)
  }))};
}
async function providerGet(fetcher,url,token) {
  const res=await fetcher(url,{method:'GET',redirect:'error',headers:{
    authorization:'Bearer '+token,accept:'application/json','user-agent':'atax-mcp-control-plane'
  }});
  if(!res.ok)throw new Error('Provider request failed (HTTP '+res.status+')');
  let body;
  try{body=await res.json();}catch{throw new Error('Provider returned invalid JSON');}
  return body;
}
const limited = (items,count=50)=>Array.isArray(items)?items.slice(0,count):[];
async function cloudflareAccounts(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
  const payload=await providerGet(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50',selected.token);
  if(payload.success!==true)throw new Error('Cloudflare accounts query failed');
  return {account:selected.alias,accounts:limited(payload.result).map(x=>({id:x.id,name:x.name})),truncated:!!payload.result_info && payload.result_info.total_count>50};
}
async function cloudflareWorkers(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
  const configured=ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias];
  const id=a.account_id||configured;
  if(!id||!ID.test(id))throw new Error('Cloudflare account ID required; use atax_cloudflare_accounts_list to discover it');
  if(configured && id!==configured)throw new Error('Cloudflare account ID differs from configured account binding');
  const payload=await providerGet(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(id)+'/workers/scripts',selected.token);
  if(payload.success!==true)throw new Error('Cloudflare Workers query failed');
  return {account:selected.alias,cloudflare_account_id:id,scripts:limited(payload.result).map(x=>({id:x.id,modified_on:x.modified_on}))};
}
export const providerTools=[
  tool('atax_provider_accounts_list','List configured owner-only GitHub and Cloudflare aliases, never credentials.','atax:read',schema(),(_a,_db,p,ctx)=>safeAccounts(ctx.env,p)),
  tool('atax_cloudflare_accounts_list','Read Cloudflare accounts accessible to a selected owner secret.','atax:cloudflare:read',accountSchema(),cloudflareAccounts),
  tool('atax_cloudflare_workers_list','List Cloudflare Worker scripts with selected owner secret and account ID.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:128}}),cloudflareWorkers)
];
