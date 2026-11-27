/** Named provider credentials for one ATAX Worker. Tokens never leave this module. */
const PREFIX = Object.freeze({github:['GH_KEY_','GH_TOKEN_'],cloudflare:['CF_KEY_','CLOUDFLARE_TOKEN_']});
const COMPUTE_PREFIX='FRNES_KEY_';
const COMPUTE_JSON='FRNES_COMPUTE_ACCOUNTS_JSON';
const AI_PREFIX='AI_KEY_';
const AI_JSON='AI_INFERENCE_ACCOUNTS_JSON';
const PROVIDER_ID=/^[a-z][a-z0-9_-]{1,63}$/;
const ALIAS = /^[A-Z][A-Z0-9_]{0,47}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PAGES_NAME = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/;
const REPO_FULL = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
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
function parseJsonEntries(env,jsonKey,errLabel) {
  if(typeof env?.[jsonKey]!=='string'||!env[jsonKey].trim())return [];
  let parsed;
  try{parsed=JSON.parse(env[jsonKey]);}catch{throw new Error(errLabel);}
  if(!Array.isArray(parsed))throw new Error(errLabel);
  return parsed;
}
function configuredComputeAccounts(env,provider) {
  if(!PROVIDER_ID.test(provider))throw new Error('Invalid compute provider identifier');
  const prefix=COMPUTE_PREFIX+provider.replace(/-/g,'_')+'__';
  const accounts=new Map();
  for(const item of parseJsonEntries(env,COMPUTE_JSON,'Invalid FRNES compute account configuration')) {
    if(!item||typeof item!=='object'||item.providerId!==provider||typeof item.alias!=='string'||typeof item.token!=='string')continue;
    const alias=item.alias.toUpperCase();
    if(!ALIAS.test(alias)||!item.token.trim())continue;
    if(accounts.has(alias))throw new Error('Duplicate compute provider account alias: '+alias);
    accounts.set(alias,{
      alias,
      token:item.token,
      weight:typeof item.weight==='number'&&Number.isFinite(item.weight)&&item.weight>0?item.weight:1,
      remainingFraction:typeof item.remainingFraction==='number'?item.remainingFraction:null,
    });
  }
  for(const key of Object.keys(env||{})) if(key.startsWith(prefix)) {
    const alias=key.slice(prefix.length);
    if(ALIAS.test(alias)&&typeof env[key]==='string'&&env[key].trim()) {
      if(accounts.has(alias))throw new Error('Duplicate compute provider account alias: '+alias);
      accounts.set(alias,{alias,token:env[key],weight:1,remainingFraction:null});
    }
  }
  return accounts;
}
export function availableAccounts(env,principal,provider) {
  if(!PREFIX[provider])throw new Error('Unknown provider');
  if(!isOwnerPrincipal(env,principal))return [];
  return [...configuredAccounts(env,provider).keys()].sort();
}
export function availableComputeAccounts(env,principal,provider) {
  if(!PROVIDER_ID.test(provider)||!isOwnerPrincipal(env,principal))return [];
  return [...configuredComputeAccounts(env,provider).keys()].sort();
}
export function listAllComputeAccounts(env,principal,providerIds=null) {
  if(!isOwnerPrincipal(env,principal))return [];
  const filter=Array.isArray(providerIds)&&providerIds.length>0?new Set(providerIds):null;
  const providers=new Set();
  for(const item of parseJsonEntries(env,COMPUTE_JSON,'Invalid FRNES compute account configuration')) {
    if(item&&typeof item==='object'&&typeof item.providerId==='string'&&PROVIDER_ID.test(item.providerId)) {
      providers.add(item.providerId);
    }
  }
  for(const key of Object.keys(env||{})) if(key.startsWith(COMPUTE_PREFIX)) {
    const rest=key.slice(COMPUTE_PREFIX.length);
    const provider=rest.split('__')[0].replace(/_/g,'-');
    if(PROVIDER_ID.test(provider)) providers.add(provider);
  }
  const results=[];
  for(const providerId of [...providers].sort()) {
    if(filter&&!filter.has(providerId))continue;
    for(const acc of configuredComputeAccounts(env,providerId).values()) {
      results.push({providerId,alias:acc.alias,token:acc.token,weight:acc.weight,remainingFraction:acc.remainingFraction});
    }
  }
  return results;
}
export function resolveComputeAccount(env,principal,provider,requested) {
  if(!PROVIDER_ID.test(provider)||!isOwnerPrincipal(env,principal))throw new Error('Compute account unavailable or not authorized');
  if(requested!==undefined && (typeof requested!=='string'||!ALIAS.test(requested.toUpperCase())))
    throw new Error('Invalid compute account alias');
  const accounts=configuredComputeAccounts(env,provider);
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
  const inferenceMap=new Map();
  if(isOwnerPrincipal(env,principal)) {
    for(const item of parseJsonEntries(env,COMPUTE_JSON,'Invalid FRNES compute account configuration')) {
      if(item&&typeof item==='object'&&typeof item.providerId==='string'&&PROVIDER_ID.test(item.providerId)&&typeof item.alias==='string'&&ALIAS.test(item.alias.toUpperCase())&&typeof item.token==='string'&&item.token.trim()) {
        computeProviders.add(item.providerId);
      }
    }
    for(const key of Object.keys(env||{})) if(key.startsWith(COMPUTE_PREFIX)) {
      const rest=key.slice(COMPUTE_PREFIX.length);
      const provider=rest.split('__')[0].replace(/_/g,'-');
      if(PROVIDER_ID.test(provider)) computeProviders.add(provider);
    }
    for(const item of parseJsonEntries(env,AI_JSON,'Invalid AI inference account configuration')) {
      if(item&&typeof item==='object'&&typeof item.providerId==='string'&&PROVIDER_ID.test(item.providerId)&&typeof item.alias==='string'&&ALIAS.test(item.alias.toUpperCase())&&typeof item.token==='string'&&item.token.trim()) {
        if(!inferenceMap.has(item.providerId)) inferenceMap.set(item.providerId,new Set());
        inferenceMap.get(item.providerId).add(item.alias.toUpperCase());
      }
    }
    for(const key of Object.keys(env||{})) if(key.startsWith(AI_PREFIX)) {
      const rest=key.slice(AI_PREFIX.length);
      const parts=rest.split('__');
      const provider=parts[0].replace(/_/g,'-');
      const alias=parts[1]||'';
      if(PROVIDER_ID.test(provider)&&ALIAS.test(alias)&&typeof env[key]==='string'&&env[key].trim()) {
        if(!inferenceMap.has(provider)) inferenceMap.set(provider,new Set());
        inferenceMap.get(provider).add(alias);
      }
    }
  }
  const inference=[...inferenceMap.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([provider,set])=>({
    provider,
    aliases:[...set].sort(),
  }));
  return {
    accounts:[...standard,{provider:'compute',kind:'compute',providers:[...computeProviders].sort().map(provider=>({provider,aliases:availableComputeAccounts(env,principal,provider)}))}],
    inference,
  };
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
async function providerRequest(fetcher,url,token,{method='GET',body}={}) {
  const res=await fetcher(url,{method,redirect:'manual',headers:{
    authorization:'Bearer '+token,accept:'application/json','user-agent':'atax-mcp-control-plane',
    ...(body===undefined?{}:{'content-type':'application/json'}),
  },...(body===undefined?{}:{body:JSON.stringify(body)})});
  let parsed=null;
  try{parsed=await res.json();}catch{}
  return {status:res.status,ok:res.ok,data:parsed};
}
async function providerGetTextOrJson(fetcher,url,token) {
  const res=await fetcher(url,{method:'GET',redirect:'manual',headers:{
    authorization:'Bearer '+token,accept:'application/json, text/plain;q=0.9','user-agent':'atax-mcp-control-plane'
  }});
  if(!res.ok)throw new Error('Provider request failed (HTTP '+res.status+')');
  const raw=await res.text();
  try{return {kind:'json',data:JSON.parse(raw)};}catch{return {kind:'text',data:raw};}
}
const limited = (items,count=50)=>Array.isArray(items)?items.slice(0,count):[];
function resolveCloudflareAccountId(ctx,selected,requestedAccountId) {
  const configured=ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias];
  const id=requestedAccountId||configured;
  if(!id||!ID.test(id))throw new Error('Cloudflare account ID required; use atax_cloudflare_accounts_list to discover it');
  if(configured && id!==configured)throw new Error('Cloudflare account ID differs from configured account binding');
  return id;
}
async function resolveOrDiscoverCloudflareAccountId(ctx,selected,requestedAccountId) {
  const configured=ctx.env['CLOUDFLARE_ACCOUNT_ID_'+selected.alias];
  if(requestedAccountId||configured) return resolveCloudflareAccountId(ctx,selected,requestedAccountId);
  const payload=await providerGet(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts?page=1&per_page=5',selected.token);
  if(payload.success!==true||!Array.isArray(payload.result)||payload.result.length===0)
    throw new Error('Cloudflare account ID required; use atax_cloudflare_accounts_list to discover it');
  return payload.result[0].id;
}
async function cloudflareAccounts(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
  const payload=await providerGet(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50',selected.token);
  if(payload.success!==true)throw new Error('Cloudflare accounts query failed');
  return {account:selected.alias,accounts:limited(payload.result).map(x=>({id:x.id,name:x.name})),truncated:!!payload.result_info && payload.result_info.total_count>50};
}
async function cloudflareWorkers(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
  const id=resolveCloudflareAccountId(ctx,selected,a.account_id);
  const payload=await providerGet(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(id)+'/workers/scripts',selected.token);
  if(payload.success!==true)throw new Error('Cloudflare Workers query failed');
  return {account:selected.alias,cloudflare_account_id:id,scripts:limited(payload.result).map(x=>({id:x.id,tag:x.tag??null,modified_on:x.modified_on}))};
}
async function cloudflareWorkerBuilds(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
  const id=resolveCloudflareAccountId(ctx,selected,a.account_id);
  let workerTag=a.worker_tag;
  if(!workerTag) {
    if(!a.script_id||!ID.test(a.script_id))throw new Error('Provide worker_tag or script_id');
    const scriptsPayload=await providerGet(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(id)+'/workers/scripts',selected.token);
    if(scriptsPayload.success!==true||!Array.isArray(scriptsPayload.result))throw new Error('Cloudflare Workers query failed');
    const found=scriptsPayload.result.find(x=>x&&x.id===a.script_id);
    if(!found||!found.tag||!ID.test(found.tag))throw new Error('Cloudflare Worker script tag not found');
    workerTag=found.tag;
  } else if(!ID.test(workerTag)) {
    throw new Error('Invalid worker_tag');
  }
  const limit=a.limit??20;
  const payload=await providerGet(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(id)+'/builds/workers/'+encodeURIComponent(workerTag)+'/builds',selected.token);
  if(payload.success!==true)throw new Error('Cloudflare Workers Builds query failed');
  return {
    account:selected.alias,
    cloudflare_account_id:id,
    worker_tag:workerTag,
    builds:limited(payload.result,limit).map(b=>({
      build_uuid:b.build_uuid,
      status:b.status,
      build_outcome:b.build_outcome??null,
      branch:b.build_trigger_metadata?.branch??null,
      commit_hash:b.build_trigger_metadata?.commit_hash??null,
      created_on:b.created_on??null,
      stopped_on:b.stopped_on??null,
    })),
  };
}
async function cloudflareBuildLogs(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
  const id=resolveCloudflareAccountId(ctx,selected,a.account_id);
  if(!a.build_uuid||!ID.test(a.build_uuid))throw new Error('Valid build_uuid required');
  const tailLines=a.tail_lines??200;
  const raw=await providerGetTextOrJson(ctx.fetcher,'https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(id)+'/builds/builds/'+encodeURIComponent(a.build_uuid)+'/logs',selected.token);
  let lines=[];
  if(raw.kind==='json') {
    const payload=raw.data;
    if(payload.success===false)throw new Error('Cloudflare build logs query failed');
    const candidate=payload.result?.lines??payload.result?.logs??payload.result;
    if(Array.isArray(candidate)) {
      lines=candidate.map(entry=>typeof entry==='string'?entry:Array.isArray(entry)?entry.join(' '):JSON.stringify(entry));
    } else if(typeof candidate==='string') {
      lines=candidate.split(/\r?\n/);
    }
  } else {
    lines=String(raw.data).split(/\r?\n/);
  }
  const nonEmpty=lines.filter(l=>l!==undefined&&l!==null&&l!=='');
  const truncated=nonEmpty.length>tailLines;
  const sliced=nonEmpty.slice(-tailLines);
  const bounded=[];
  let totalBytes=0;
  for(let i=sliced.length-1;i>=0;i--) {
    const line=String(sliced[i]).slice(0,2000);
    if(totalBytes+line.length>32768)break;
    bounded.unshift(line);
    totalBytes+=line.length+1;
  }
  return {
    account:selected.alias,
    cloudflare_account_id:id,
    build_uuid:a.build_uuid,
    truncated:truncated||bounded.length<sliced.length,
    line_count:bounded.length,
    lines:bounded,
  };
}
async function cloudflarePagesDeploy(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
  const id=await resolveOrDiscoverCloudflareAccountId(ctx,selected,a.account_id);
  const projectName=String(a.project_name||'').trim().toLowerCase();
  if(!PAGES_NAME.test(projectName))throw new Error('Invalid Cloudflare Pages project_name (lowercase alphanumeric and hyphens, 2-58 chars)');
  const repoMatch=String(a.repository||'').match(REPO_FULL);
  if(!repoMatch)throw new Error('Valid GitHub owner/name repository is required');
  const productionBranch=String(a.production_branch||'main').trim();
  const buildCommand=String(a.build_command??'npm run build');
  const destinationDir=String(a.destination_dir??'dist');
  const baseUrl='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(id)+'/pages/projects';
  const existing=await providerRequest(ctx.fetcher,baseUrl+'/'+encodeURIComponent(projectName),selected.token);
  let project=existing.ok&&existing.data?.success?existing.data.result:null;
  let created=false;
  if(!project) {
    if(existing.status!==404) {
      const msg=existing.data?.errors?.[0]?.message||'Cloudflare Pages lookup failed';
      throw new Error('Cloudflare Pages lookup failed (HTTP '+existing.status+': '+msg+')');
    }
    const createRes=await providerRequest(ctx.fetcher,baseUrl,selected.token,{
      method:'POST',
      body:{
        name:projectName,
        production_branch:productionBranch,
        source:{
          type:'github',
          config:{
            owner:repoMatch[1],
            repo_name:repoMatch[2],
            production_branch:productionBranch,
            deployments_enabled:true,
          },
        },
        build_config:{
          build_command:buildCommand,
          destination_dir:destinationDir,
        },
      },
    });
    if(!createRes.ok||createRes.data?.success!==true) {
      const msg=createRes.data?.errors?.[0]?.message||'Cloudflare Pages project creation failed';
      throw new Error('Cloudflare Pages project creation failed (HTTP '+createRes.status+': '+msg+')');
    }
    project=createRes.data.result;
    created=true;
  }
  const deployRes=await providerRequest(ctx.fetcher,baseUrl+'/'+encodeURIComponent(projectName)+'/deployments',selected.token,{method:'POST'});
  if(!deployRes.ok||deployRes.data?.success!==true) {
    const msg=deployRes.data?.errors?.[0]?.message||'Cloudflare Pages deployment trigger failed';
    throw new Error('Cloudflare Pages deployment failed (HTTP '+deployRes.status+': '+msg+')');
  }
  const dep=deployRes.data.result||{};
  return {
    operation:'cloudflare_pages_deploy',
    account:selected.alias,
    cloudflare_account_id:id,
    project_name:projectName,
    created,
    url:dep.url||(project.subdomain?'https://'+project.subdomain:null),
    production_url:project.subdomain?'https://'+project.subdomain:null,
    deployment_id:dep.id??null,
    latest_stage:dep.latest_stage??null,
  };
}
async function cloudflarePagesGet(a,_db,p,ctx) {
  const selected=resolveProviderAccount(ctx.env,p,'cloudflare',a.account);
  const id=await resolveOrDiscoverCloudflareAccountId(ctx,selected,a.account_id);
  const projectName=String(a.project_name||'').trim().toLowerCase();
  if(!PAGES_NAME.test(projectName))throw new Error('Invalid Cloudflare Pages project_name');
  const baseUrl='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(id)+'/pages/projects/'+encodeURIComponent(projectName);
  const projRes=await providerRequest(ctx.fetcher,baseUrl,selected.token);
  if(!projRes.ok||projRes.data?.success!==true) {
    const msg=projRes.data?.errors?.[0]?.message||'Cloudflare Pages project lookup failed';
    throw new Error('Cloudflare Pages project lookup failed (HTTP '+projRes.status+': '+msg+')');
  }
  const project=projRes.data.result||{};
  const depUrl=a.deployment_id?baseUrl+'/deployments/'+encodeURIComponent(a.deployment_id):baseUrl+'/deployments?per_page=3';
  const depRes=await providerRequest(ctx.fetcher,depUrl,selected.token);
  const depData=depRes.ok&&depRes.data?.success?depRes.data.result:null;
  const latest=Array.isArray(depData)?depData[0]:depData;
  return {
    operation:'cloudflare_pages_get',
    account:selected.alias,
    cloudflare_account_id:id,
    project_name:projectName,
    production_url:project.subdomain?'https://'+project.subdomain:null,
    latest_deployment:latest?{
      id:latest.id,
      url:latest.url,
      environment:latest.environment,
      latest_stage:latest.latest_stage,
      stages:latest.stages,
      created_on:latest.created_on,
    }:null,
  };
}
export const providerTools=[
  tool('atax_provider_accounts_list','List configured owner-only GitHub, Cloudflare, compute, and AI inference aliases, never credentials.','atax:read',schema(),(_a,_db,p,ctx)=>safeAccounts(ctx.env,p)),
  tool('atax_cloudflare_accounts_list','Read Cloudflare accounts accessible to a selected owner secret.','atax:cloudflare:read',accountSchema(),cloudflareAccounts),
  tool('atax_cloudflare_workers_list','List Cloudflare Worker scripts with selected owner secret and account ID.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:128}}),cloudflareWorkers),
  tool('atax_cloudflare_worker_builds_list','List Cloudflare Workers Builds for a Worker tag or script_id.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:128},worker_tag:{type:'string',maxLength:128},script_id:{type:'string',maxLength:128},limit:{type:'integer',minimum:1,maximum:50}}),cloudflareWorkerBuilds),
  tool('atax_cloudflare_build_logs_get','Read bounded Cloudflare Workers Build logs for a build_uuid.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:128},build_uuid:{type:'string',maxLength:128},tail_lines:{type:'integer',minimum:1,maximum:500}},['build_uuid']),cloudflareBuildLogs),
  tool('atax_cloudflare_pages_deploy','Create (if missing) a GitHub-connected Cloudflare Pages project and trigger a production deployment.','atax:github:create',accountSchema({account_id:{type:'string',maxLength:128},project_name:{type:'string',minLength:2,maxLength:58},repository:{type:'string',minLength:3,maxLength:205},production_branch:{type:'string',minLength:1,maxLength:120},build_command:{type:'string',maxLength:256},destination_dir:{type:'string',maxLength:256}},['project_name','repository']),cloudflarePagesDeploy),
  tool('atax_cloudflare_pages_get','Inspect a Cloudflare Pages project and its latest deployment status and URL.','atax:cloudflare:read',accountSchema({account_id:{type:'string',maxLength:128},project_name:{type:'string',minLength:2,maxLength:58},deployment_id:{type:'string',maxLength:128}},['project_name']),cloudflarePagesGet)
];
