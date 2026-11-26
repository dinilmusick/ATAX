/** Named provider credentials for one ATAX Worker. Tokens never leave this module. */
const PREFIX = Object.freeze({github:['GH_KEY_','GH_TOKEN_'],cloudflare:['CF_KEY_','CLOUDFLARE_TOKEN_']});
const COMPUTE_PREFIX='FRNES_KEY_';
const COMPUTE_JSON='FRNES_COMPUTE_ACCOUNTS_JSON';
const PROVIDER_ID=/^[a-z][a-z0-9_-]{1,63}$/;
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
  return principal.authMethod==='jwt' && owner.length>=3 && principal.id===owner;
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
export function availableComputeAccounts(env,principal,provider) {
  if(!PROVIDER_ID.test(provider)||!isOwnerPrincipal(env,principal))return [];
  const prefix=COMPUTE_PREFIX+provider.replace(/-/g,'_')+'__';
  return Object.keys(env||{}).filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length))
    .filter(x=>ALIAS.test(x)&&typeof env[prefix+x]==='string').sort();
}
export function resolveComputeAccount(env,principal,provider,requested) {
  if(!PROVIDER_ID.test(provider)||!isOwnerPrincipal(env,principal))throw new Error('Compute account unavailable or not authorized');
  const prefix=COMPUTE_PREFIX+provider.replace(/-/g,'_')+'__';
  const accounts=new Map();
  if(typeof env[COMPUTE_JSON]==='string'&&env[COMPUTE_JSON].trim()){
    let parsed;try{parsed=JSON.parse(env[COMPUTE_JSON]);}catch{throw new Error('Invalid FRNES compute account configuration');}
    if(!Array.isArray(parsed))throw new Error('Invalid FRNES compute account configuration');
    for(const item of parsed){
      if(!item||typeof item!=='object'||item.providerId!==provider||typeof item.alias!=='string'||typeof item.token!=='string')continue;
      const alias=item.alias.toUpperCase();
      if(!ALIAS.test(alias)||!item.token.trim())continue;
      if(accounts.has(alias))throw new Error('Duplicate compute provider account alias: '+alias);
      accounts.set(alias,{alias,token:item.token});
    }
  }
  for(const key of Object.keys(env||{})) if(key.startsWith(prefix)) {
    const alias=key.slice(prefix.length);
    if(ALIAS.test(alias)&&typeof env[key]==='string'&&env[key].trim()) {
      if(accounts.has(alias))throw new Error('Duplicate compute provider account alias: '+alias);
      accounts.set(alias,{alias,token:env[key]});
    }
  }
  const names=[...accounts.keys()];
  const alias=requested===undefined?(names.length===1?names[0]:null):String(requested).toUpperCase();
  if(alias&&accounts.has(alias))return accounts.get(alias);
  if(!alias&&names.length>1)throw new Error('Specify a compute account alias when multiple accounts are configured');
  throw new Error('Compute account unavailable or not authorized');
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
  const standard=Object.keys(PREFIX).map(provider=>({provider,aliases:availableAccounts(env,principal,provider),kind:'provider'}));
  const computeProviders=new Set();
  for(const key of Object.keys(env||{})) if(key.startsWith(COMPUTE_PREFIX)) {
    const rest=key.slice(COMPUTE_PREFIX.length);
    const provider=rest.split('__')[0].replace(/_/g,'-');
    if(PROVIDER_ID.test(provider)) computeProviders.add(provider);
  }
  return {accounts:[...standard,{provider:'compute',kind:'compute',providers:[...computeProviders].sort().map(provider=>({provider,aliases:availableComputeAccounts(env,principal,provider)}))}]};
}
async function providerGet(fetcher,url,token) {
  const res=await fetcher(url,{method:'GET',redirect:'manual',headers:{
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
