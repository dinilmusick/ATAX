/** Named provider credentials for one ATAX Worker. Tokens never leave this module. */
const PREFIX = Object.freeze({github:'GH_TOKEN_',cloudflare:'CLOUDFLARE_TOKEN_',vercel:'VERCEL_TOKEN_'});
const ALIAS = /^[A-Z][A-Z0-9_]{0,47}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const tool = (name,description,scope,inputSchema,invoke)=>({name,description,scope,inputSchema,invoke});
const schema = (properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const accountArg = {type:'string',maxLength:48,description:'Optional account alias suffix from a configured secret; required when more than one account is available'};
const accountSchema = (other={},required=[])=>schema({account:accountArg,...other},required);

function grantsFor(env, principal, provider) {
  const owner=String(env.MCP_SHARED_SUBJECT||'atax-mcp-operator');
  if (principal?.authMethod==='shared' && principal.id===owner && env.MCP_SHARED_TOKEN_SHA256) return '*';
  // Non-owner JWT identities must have an explicit grant. The mapping is non-secret.
  let grants;
  try { grants=JSON.parse(String(env.MCP_PROVIDER_ACCOUNT_GRANTS||'{}')); }
  catch { throw new Error('Invalid MCP_PROVIDER_ACCOUNT_GRANTS configuration'); }
  if (!grants || typeof grants!=='object' || Array.isArray(grants)) throw new Error('Invalid provider grants');
  const aliases=Object.prototype.hasOwnProperty.call(grants,principal?.id) ? grants[principal.id]?.[provider] : undefined;
  return Array.isArray(aliases) ? aliases.filter(x=>typeof x==='string' && ALIAS.test(x)) : [];
}
export function availableAccounts(env,principal,provider) {
  if (!Object.prototype.hasOwnProperty.call(PREFIX,provider)) throw new Error('Unknown provider');
  const grants=grantsFor(env,principal,provider);
  const prefix=PREFIX[provider];
  return Object.keys(env).filter(k=>k.startsWith(prefix))
    .map(k=>k.slice(prefix.length)).filter(a=>ALIAS.test(a) && typeof env[prefix+a]==='string' && env[prefix+a].trim() && (grants==='*'||grants.includes(a)))
    .sort();
}
export function resolveProviderAccount(env,principal,provider,requested,{legacyKey}={}) {
  const names=availableAccounts(env,principal,provider);
  if(requested!==undefined && (typeof requested!=='string'||!ALIAS.test(requested.toUpperCase())))throw new Error('Invalid account alias');
  const alias=requested===undefined?(names.length===1?names[0]:null):requested.toUpperCase();
  if(alias && names.includes(alias))return {alias,token:env[PREFIX[provider]+alias],legacy:false};
  if (!names.length && provider==='github' && (!requested||requested==='DEFAULT') && legacyKey && env[legacyKey] &&
      principal?.authMethod==='shared' && principal.id===String(env.MCP_SHARED_SUBJECT||'atax-mcp-operator'))
    return {alias:'DEFAULT',token:String(env[legacyKey]),legacy:true};
  if (!alias && names.length>1)throw new Error('Specify an account alias when multiple accounts are configured');
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
async function vercelProjects(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'vercel',a.account);
  const team=ctx.env['VERCEL_TEAM_ID_'+selected.alias];
  if(team && !ID.test(team))throw new Error('Invalid Vercel team ID binding');
  const url='https://api.vercel.com/v9/projects?limit=20'+(team?'&teamId='+encodeURIComponent(team):'');
  const payload=await providerGet(ctx.fetcher,url,selected.token);
  return {account:selected.alias,projects:limited(payload.projects,20).map(x=>({id:x.id,name:x.name,framework:x.framework})),pagination:payload.pagination?{next:payload.pagination.next}:null};
}
async function vercelDeployments(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'vercel',a.account);
  const team=ctx.env['VERCEL_TEAM_ID_'+selected.alias];
  if(team && !ID.test(team))throw new Error('Invalid Vercel team ID binding');
  if(a.project_id!==undefined && (!ID.test(a.project_id)))throw new Error('Invalid Vercel project ID');
  const query='?limit=20'+(team?'&teamId='+encodeURIComponent(team):'')+(a.project_id?'&projectId='+encodeURIComponent(a.project_id):'');
  const payload=await providerGet(ctx.fetcher,'https://api.vercel.com/v6/deployments'+query,selected.token);
  return {account:selected.alias,deployments:limited(payload.deployments,20).map(x=>({uid:x.uid,name:x.name,state:x.state,readyState:x.readyState,url:x.url,created:x.created}))};
}
export const providerTools=[
  tool('atax_provider_accounts_list','List permitted provider account aliases only. Tokens never appear.','atax:read',schema(),(_a,_db,p,ctx)=>safeAccounts(ctx.env,p)),
  tool('atax_cloudflare_accounts_list','Read Cloudflare accounts available to the selected owner-managed token.','atax:cloudflare:read',accountSchema(),cloudflareAccounts),
  tool('atax_cloudflare_workers_list','List Cloudflare Worker scripts using the selected token and Cloudflare account ID.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:128}}),cloudflareWorkers),
  tool('atax_vercel_projects_list','List Vercel projects available to the selected token, optionally bounded to a configured team.','atax:vercel:read',accountSchema(),vercelProjects),
  tool('atax_vercel_deployments_list','Inspect recent Vercel deployment states by authorized account.','atax:vercel:read',accountSchema({project_id:{type:'string',maxLength:128}}),vercelDeployments)
];
