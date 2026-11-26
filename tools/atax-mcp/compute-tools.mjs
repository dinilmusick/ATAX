// FRNES compute adapter gateway contract.
/** ATAX compute control-plane adapter. FRNES owns provider accounts and execution; ATAX owns policy and routing. */
import {listAllComputeAccounts,resolveComputeAccount} from './provider-accounts.mjs';
import {rankWeightedAccounts,recordAccountUsage,selectWeightedAccount} from './weighted-rotation.mjs';

const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const tool=(name,description,scope,inputSchema,invoke)=>({name,description,scope,inputSchema,invoke});

function frnesConfig(env){
  const rawUrl=String(env?.FRNES_URL||'').trim().replace(/\/+$/,'');
  const token=String(env?.FRNES_SERVICE_TOKEN||'').trim();
  if(!rawUrl.startsWith('https://')||token.length<16||/[\r\n]/.test(token)){
    throw new Error('FRNES compute gateway is not configured');
  }
  let parsed;
  try{parsed=new URL(rawUrl);}catch{throw new Error('FRNES compute gateway is not configured');}
  if(parsed.protocol!=='https:'||!parsed.hostname||parsed.username||parsed.password||parsed.search||parsed.hash){
    throw new Error('FRNES compute gateway is not configured');
  }
  return {url:rawUrl,token};
}

function assertEnvironmentMatchesAccount(environmentId,providerId,alias){
  const parts=String(environmentId||'').split('/');
  if(parts.length<3)throw new Error('Invalid compute environmentId');
  if(parts[0]!==providerId||parts[1].toUpperCase()!==alias.toUpperCase()){
    throw new Error('Compute environmentId does not belong to selected provider account');
  }
}

async function callFrnes(path,body,env,fetcher){
  const c=frnesConfig(env);
  const response=await fetcher(c.url+path,{
    method:'POST',
    redirect:'manual',
    signal:AbortSignal.timeout(30000),
    headers:{
      authorization:'Bearer '+c.token,
      'content-type':'application/json',
      accept:'application/json',
      'x-atax-compute':'1',
    },
    body:JSON.stringify(body),
  });
  if(response.status>=300&&response.status<400){
    throw new Error('FRNES compute redirect rejected');
  }
  let payload=null;
  try{payload=await response.json();}catch{}
  if(!response.ok)throw Object.assign(new Error('FRNES compute request rejected'),{status:response.status});
  return payload;
}

function orderWeightedComputeAccounts(candidates){
  if(!Array.isArray(candidates)||candidates.length<=1)return candidates||[];
  const primary=selectWeightedAccount(candidates);
  const ranked=rankWeightedAccounts(candidates)
    .map(x=>x.candidate)
    .filter(c=>!(c.providerId===primary.providerId&&c.alias===primary.alias));
  return [primary,...ranked];
}

export const computeTools=[
  tool(
    'atax_compute_capabilities',
    'Discover FRNES compute providers and currently executable environment capabilities without exposing credentials.',
    'atax:read',
    schema({workspaceId:{type:'string',minLength:1,maxLength:120}},['workspaceId']),
    async(a,_db,p,ctx)=>callFrnes('/api/frnes/compute/capabilities',{workspaceId:a.workspaceId,ownerUserId:p.id},ctx.env,ctx.fetcher)
  ),
  tool(
    'atax_compute_execute',
    'Execute a bounded repository command in a FRNES-selected provider environment using usage-based weighted account rotation.',
    'atax:write',
    schema({
      workspaceId:{type:'string',minLength:1,maxLength:120},
      repository:{type:'string',minLength:1,maxLength:205},
      ref:{type:'string',minLength:1,maxLength:256},
      command:{type:'string',minLength:1,maxLength:8192},
      requirement:{type:'object'},
      providerIds:{type:'array',items:{type:'string',minLength:1,maxLength:128},maxItems:20},
      accountIds:{type:'array',items:{type:'string',minLength:1,maxLength:128},maxItems:50},
      accounts:{
        type:'array',
        items:{
          type:'object',
          properties:{
            providerId:{type:'string',minLength:1,maxLength:64},
            alias:{type:'string',minLength:1,maxLength:48},
          },
          required:['providerId','alias'],
          additionalProperties:false,
        },
        maxItems:50,
      },
      environmentId:{type:'string',minLength:1,maxLength:128},
      timeoutSeconds:{type:'integer',minimum:1,maximum:7200},
    },['workspaceId','repository','ref','command','requirement']),
    async(a,_db,p,ctx)=>{
      const resolved=Array.isArray(a.accounts)&&a.accounts.length>0
        ?a.accounts.map(item=>{
          const selected=resolveComputeAccount(ctx.env,p,item.providerId,item.alias);
          return {
            providerId:item.providerId,
            alias:selected.alias,
            token:selected.token,
            weight:selected.weight,
            remainingFraction:selected.remainingFraction,
          };
        })
        :listAllComputeAccounts(ctx.env,p,a.providerIds);
      const ordered=orderWeightedComputeAccounts(resolved);
      const wireAccounts=ordered.map(({providerId,alias,token})=>({providerId,alias,token}));
      try{
        const result=await callFrnes('/api/frnes/compute/execute',{...a,accounts:wireAccounts,ownerUserId:p.id},ctx.env,ctx.fetcher);
        const parts=String(result?.environmentId||'').split('/');
        const chosenProvider=result?.provider||parts[0]||ordered[0]?.providerId;
        const chosenAlias=parts[1]||ordered[0]?.alias;
        if(chosenProvider&&chosenAlias){
          recordAccountUsage(chosenProvider,chosenAlias,{ok:true});
        }
        return result;
      }catch(err){
        if(ordered[0]){
          recordAccountUsage(ordered[0].providerId,ordered[0].alias,{ok:false,rateLimited:err?.status===429});
        }
        throw err;
      }
    }
  ),
  tool(
    'atax_compute_status',
    'Poll a FRNES compute environment without exposing provider credentials.',
    'atax:read',
    schema({
      workspaceId:{type:'string',minLength:1,maxLength:120},
      environmentId:{type:'string',minLength:1,maxLength:256},
      account:{
        type:'object',
        properties:{
          providerId:{type:'string',minLength:1,maxLength:64},
          alias:{type:'string',minLength:1,maxLength:48},
        },
        required:['providerId','alias'],
        additionalProperties:false,
      },
    },['workspaceId','environmentId','account']),
    async(a,_db,p,ctx)=>{
      const selected=resolveComputeAccount(ctx.env,p,a.account.providerId,a.account.alias);
      assertEnvironmentMatchesAccount(a.environmentId,a.account.providerId,selected.alias);
      return callFrnes('/api/frnes/compute/status',{
        workspaceId:a.workspaceId,
        environmentId:a.environmentId,
        ownerUserId:p.id,
        accounts:[{providerId:a.account.providerId,alias:selected.alias,token:selected.token}],
      },ctx.env,ctx.fetcher);
    }
  ),
  tool(
    'atax_compute_destroy',
    'Destroy a FRNES compute environment after execution. Destruction is explicit and idempotent.',
    'atax:write',
    schema({
      workspaceId:{type:'string',minLength:1,maxLength:120},
      environmentId:{type:'string',minLength:1,maxLength:128},
      account:{
        type:'object',
        properties:{
          providerId:{type:'string',minLength:1,maxLength:64},
          alias:{type:'string',minLength:1,maxLength:48},
        },
        required:['providerId','alias'],
        additionalProperties:false,
      },
    },['workspaceId','environmentId','account']),
    async(a,_db,p,ctx)=>{
      const selected=resolveComputeAccount(ctx.env,p,a.account.providerId,a.account.alias);
      assertEnvironmentMatchesAccount(a.environmentId,a.account.providerId,selected.alias);
      return callFrnes('/api/frnes/compute/destroy',{
        workspaceId:a.workspaceId,
        environmentId:a.environmentId,
        ownerUserId:p.id,
        accounts:[{providerId:a.account.providerId,alias:selected.alias,token:selected.token}],
      },ctx.env,ctx.fetcher);
    }
  ),
];
