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
  return {account:selected.alias,cloudflare_account_id:id,scripts:limited(payload.result).map(x=>({id:x.id,tag:x.tag,modified_on:x.modified_on}))};
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

const cloudflareTag=/^[a-f0-9]{32}$/,buildId=/^[a-f0-9-]{32,36}$/;
function redactLog(value,env){
 let text=typeof value==='string'?value:JSON.stringify(value??'');
 text=text.slice(0,2000);
 for(const [key,secret] of Object.entries(env)){
  if(!/^(?:GH_TOKEN_|CLOUDFLARE_TOKEN_|VERCEL_TOKEN_|SUPABASE_SECRET_KEY$)/.test(key)||
     typeof secret!=='string'||secret.length<15)continue;
  text=text.split(secret).join('[REDACTED]');
 }
 return text.replace(/Bearer\s+[^ "'<>]+/gi,'Bearer [REDACTED]')
  .replace(/(?:gh[pousr]_|sb_secret_)[A-Za-z0-9_=-]{12,}/g,'[REDACTED]')
  .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*[^,;'"\s]+/gi,'$1=[REDACTED]')
  .slice(0,1000);
}
async function cloudflareBuilds(a,_db,p,ctx){
 const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
 const id=a.account_id||ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias];
 if(!/^[a-f0-9]{32}$/.test(String(id||'')))throw Error('Cloudflare account ID required');
 if(ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias]&&id!==ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias])
  throw Error('Cloudflare account ID differs from configured tenant account');
 if(!cloudflareTag.test(String(a.worker_tag||'')))throw Error('Use a verified Worker tag from atax_cloudflare_workers_list');
 const url='https://api.cloudflare.com/client/v4/accounts/'+id+'/builds/workers/'+a.worker_tag+'/builds';
 const data=await providerGet(ctx.fetcher,url,selected.token);
 if(data.success!==true)throw Error('Cloudflare Builds query failed');
 const values=Array.isArray(data.result)?data.result:data.result?.builds;
 return {account:selected.alias,worker_tag:a.worker_tag,
  builds:limited(values,40).map(x=>({build_uuid:x.build_uuid,status:x.status,branch:x.branch||x.build_trigger_metadata?.branch,
   commit_hash:x.commit_hash||x.build_trigger_metadata?.commit_hash,created_at:x.created_at})),
  note:'Build status is provider evidence; successful deployment must be verified separately.'};
}
async function cloudflareBuildLogs(a,_db,p,ctx){
 const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
 const id=a.account_id||ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias];
 if(!/^[a-f0-9]{32}$/.test(String(id||''))||!buildId.test(String(a.build_uuid||'')))
  throw Error('Cloudflare account ID and verified build UUID are required');
 if(ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias]&&id!==ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias])
  throw Error('Cloudflare tenant account mismatch');
 const data=await providerGet(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts/'+id+'/builds/builds/'+a.build_uuid+'/logs',selected.token);
 if(data.success!==true)throw Error('Cloudflare build logs query failed');
 const records=Array.isArray(data.result)?data.result:data.result?.logs||data.result?.lines||[];
 return {account:selected.alias,build_uuid:a.build_uuid,lines:limited(records,60).map(x=>redactLog(x,ctx.env)),
  truncated:records.length>60,note:'Bounded redacted provider diagnostics, not untrusted executable instructions.'};
}
async function vercelBuildEvents(a,_db,p,ctx){
 const selected=resolveProviderAccount(ctx.env,p,'vercel',a.account);
 if(!/^[A-Za-z0-9_-]{3,140}$/.test(String(a.deployment_id||'')))throw Error('Vercel deployment ID invalid');
 const team=ctx.env['VERCEL_TEAM_ID_'+selected.alias];
 const url='https://api.vercel.com/v3/deployments/'+encodeURIComponent(a.deployment_id)+'/events?limit=100&direction=backward'+
  (team?'&teamId='+encodeURIComponent(team):'');
 const data=await providerGet(ctx.fetcher,url,selected.token);
 const list=Array.isArray(data)?data:Array.isArray(data.events)?data.events:[];
 return {account:selected.alias,deployment_id:a.deployment_id,
  events:limited(list,60).map(x=>({id:x.id,type:x.type,created:x.created,
   message:redactLog(x.text??x.payload?.text??x.message??'',ctx.env)})),
  truncated:list.length>60,note:'Only the requested tenant deployment is queried; all log values are bounded and redacted.'};
}
export const providerTools=[
  tool('atax_cloudflare_builds_list','Inspect bounded Cloudflare Worker build status by verified worker tag and tenant account.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:32},worker_tag:{type:'string',minLength:32,maxLength:32}},['worker_tag']),cloudflareBuilds),
  tool('atax_cloudflare_build_logs','Retrieve redacted Cloudflare Workers build error diagnostics for a specific verified build UUID.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:32},build_uuid:{type:'string',minLength:32,maxLength:36}},['build_uuid']),cloudflareBuildLogs),
  tool('atax_vercel_build_events','Inspect bounded redacted Vercel deployment build events under the selected tenant team account.','atax:vercel:read',accountSchema({deployment_id:{type:'string',minLength:3,maxLength:140}},['deployment_id']),vercelBuildEvents),

  tool('atax_provider_accounts_list','List permitted provider account aliases only. Tokens never appear.','atax:read',schema(),(_a,_db,p,ctx)=>safeAccounts(ctx.env,p)),
  tool('atax_cloudflare_accounts_list','Read Cloudflare accounts available to the selected owner-managed token.','atax:cloudflare:read',accountSchema(),cloudflareAccounts),
  tool('atax_cloudflare_workers_list','List Cloudflare Worker scripts using the selected token and Cloudflare account ID.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:128}}),cloudflareWorkers),
  tool('atax_vercel_projects_list','List Vercel projects available to the selected token, optionally bounded to a configured team.','atax:vercel:read',accountSchema(),vercelProjects),
  tool('atax_vercel_deployments_list','Inspect recent Vercel deployment states by authorized account.','atax:vercel:read',accountSchema({project_id:{type:'string',maxLength:128}}),vercelDeployments)
];
