/** ATAX compute control-plane adapter. FRNES owns provider accounts and execution; ATAX owns policy and routing. */
import {resolveComputeAccount} from './provider-accounts.mjs';
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const tool=(name,description,scope,inputSchema,invoke)=>({name,description,scope,inputSchema,invoke});
function frnesConfig(env){const url=String(env.FRNES_URL||'').trim().replace(/\/+$/,'');const token=String(env.FRNES_SERVICE_TOKEN||'').trim();if(!url.startsWith('https://')||token.length<16)throw new Error('FRNES compute gateway is not configured');return {url,token};}
async function callFrnes(path,body,env,fetcher){const c=frnesConfig(env);const response=await fetcher(c.url+path,{method:'POST',redirect:'manual',headers:{authorization:'Bearer '+c.token,'content-type':'application/json','accept':'application/json','x-atax-compute':'1'},body:JSON.stringify(body)});let payload=null;try{payload=await response.json();}catch{}if(!response.ok)throw new Error('FRNES compute request rejected');return payload;}
export const computeTools=[
 tool('atax_compute_capabilities','Discover FRNES compute providers and currently executable environment capabilities without exposing credentials.','atax:read',schema({workspaceId:{type:'string',minLength:1,maxLength:120}}),async(a,_db,p,ctx)=>callFrnes('/api/frnes/compute/capabilities',{workspaceId:a.workspaceId,ownerUserId:p.id},ctx.env,ctx.fetcher)),
 tool('atax_compute_execute','Execute a bounded repository command in a FRNES-selected provider environment. FRNES performs account ownership, quota and capability checks.','atax:write',schema({workspaceId:{type:'string',minLength:1,maxLength:120},repository:{type:'string',minLength:1,maxLength:205},ref:{type:'string',minLength:1,maxLength:256},command:{type:'string',minLength:1,maxLength:8192},requirement:{type:'object'},providerIds:{type:'array',items:{type:'string',minLength:1,maxLength:128},maxItems:20},accountIds:{type:'array',items:{type:'string',minLength:1,maxLength:128},maxItems:50},accounts:{type:'array',items:{type:'object',properties:{providerId:{type:'string',minLength:1,maxLength:64},alias:{type:'string',minLength:1,maxLength:48}},required:['providerId','alias'],additionalProperties:false},maxItems:50},environmentId:{type:'string',minLength:1,maxLength:128},timeoutSeconds:{type:'integer',minimum:1,maximum:7200}},['workspaceId','repository','ref','command','requirement']),async(a,_db,p,ctx)=>{
   const accounts=Array.isArray(a.accounts)?a.accounts.map(item=>{
     const selected=resolveComputeAccount(ctx.env,p,item.providerId,item.alias);
     return {providerId:item.providerId,alias:selected.alias,token:selected.token};
   }):[];
   return callFrnes('/api/frnes/compute/execute',{...a,accounts,ownerUserId:p.id},ctx.env,ctx.fetcher);
 }),
 tool('atax_compute_status','Poll a FRNES compute environment without exposing provider credentials.','atax:read',schema({workspaceId:{type:'string',minLength:1,maxLength:120},environmentId:{type:'string',minLength:1,maxLength:256},account:{type:'object',properties:{providerId:{type:'string',minLength:1,maxLength:64},alias:{type:'string',minLength:1,maxLength:48}},required:['providerId','alias'],additionalProperties:false}},['workspaceId','environmentId','account']),async(a,_db,p,ctx)=>{
   const selected=resolveComputeAccount(ctx.env,p,a.account.providerId,a.account.alias);
   return callFrnes('/api/frnes/compute/status',{workspaceId:a.workspaceId,environmentId:a.environmentId,ownerUserId:p.id,
     accounts:[{providerId:a.account.providerId,alias:selected.alias,token:selected.token}]},ctx.env,ctx.fetcher);
 }),
 tool('atax_compute_destroy','Destroy a FRNES compute environment after execution. Destruction is explicit and idempotent.','atax:write',schema({workspaceId:{type:'string',minLength:1,maxLength:120},environmentId:{type:'string',minLength:1,maxLength:128},account:{type:'object',properties:{providerId:{type:'string',minLength:1,maxLength:64},alias:{type:'string',minLength:1,maxLength:48}},required:['providerId','alias'],additionalProperties:false}},['workspaceId','environmentId','account']),async(a,_db,p,ctx)=>{
   const selected=resolveComputeAccount(ctx.env,p,a.account.providerId,a.account.alias);
   return callFrnes('/api/frnes/compute/destroy',{workspaceId:a.workspaceId,environmentId:a.environmentId,ownerUserId:p.id,
     accounts:[{providerId:a.account.providerId,alias:selected.alias,token:selected.token}]},ctx.env,ctx.fetcher);
 }),
];
