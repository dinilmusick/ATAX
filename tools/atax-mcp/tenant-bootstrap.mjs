/** Tenant-owned Supabase schema bootstrap. Never accept database credentials as
 * MCP tool arguments. The owner configures GitHub Actions secrets directly.
 */
import {resolveProviderAccount} from './provider-accounts.mjs';
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH=/^[A-Za-z0-9._/-]{1,100}$/;
const SCHEMA_SHA='d182e89a590a088bebd3aa18add8891ad3001fb2';
const SETUP_SHA='689adcfb80d947100a1eab127289b97d1fb07b13';
const VERSION='3.2.0';
const workflow=[
 'name: ATAX tenant database bootstrap',
 'on:',
 '  workflow_dispatch:',
 'permissions:',
 '  contents: read',
 'jobs:',
 '  initialize:',
 '    runs-on: ubuntu-latest',
 '    timeout-minutes: 45',
 '    steps:',
 '      - name: Checkout immutable ATAX schema',
 '        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
 '        with:',
 '          repository: dinilmusick/ATAX',
 '          ref: '+SCHEMA_SHA,
 '          persist-credentials: false',
 '      - name: Install pinned Supabase CLI',
 '        uses: supabase/setup-cli@'+SETUP_SHA,
 '        with:',
 '          version: '+VERSION,
 '      - name: Apply canonical ATAX migrations to the selected database',
 '        shell: bash',
 '        env:',
 '          ATAX_BOOTSTRAP_DATABASE_URL: $'+'{{ secrets.ATAX_BOOTSTRAP_DATABASE_URL }}',
 '        run: |',
 '          set -euo pipefail',
 '          test -n "$ATAX_BOOTSTRAP_DATABASE_URL" || { echo "Missing ATAX database GitHub secret" >&2; exit 1; }',
 '          echo "::add-mask::$ATAX_BOOTSTRAP_DATABASE_URL"',
 '          case "$ATAX_BOOTSTRAP_DATABASE_URL" in',
 '            postgresql://*|postgres://*) ;;',
 '            *) echo "Invalid PostgreSQL connection URL" >&2; exit 1 ;;',
 '          esac',
 '          supabase db push --remote="$ATAX_BOOTSTRAP_DATABASE_URL" --yes',
 '      - name: Verify canonical ledger RPC and migration history',
 '        shell: bash',
 '        env:',
 '          ATAX_BOOTSTRAP_DATABASE_URL: $'+'{{ secrets.ATAX_BOOTSTRAP_DATABASE_URL }}',
 '        run: |',
 '          set -euo pipefail',
 '          echo "::add-mask::$ATAX_BOOTSTRAP_DATABASE_URL"',
 '          psql "$ATAX_BOOTSTRAP_DATABASE_URL" -X -A -t -c "SELECT count(*) FROM public.systems" >/dev/null',
 '          count="$(psql "$ATAX_BOOTSTRAP_DATABASE_URL" -X -A -t -c "SELECT count(*) FROM supabase_migrations.schema_migrations")"',
 '          test "$count" -ge 101 || { echo "ATAX migrations incomplete" >&2; exit 1; }',
 '          echo "ATAX tenant schema migration verified; no secret values printed"'
].join('\n')+'\n';
async function git(fetcher,token,path,method='GET',body){
 const response=await fetcher('https://api.github.com'+path,{method,redirect:'error',headers:{
  authorization:'Bearer '+token,accept:'application/vnd.github+json','user-agent':'atax-mcp',
  ...(body?{'content-type':'application/json'}:{})
 },...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw Error('GitHub bootstrap request denied (HTTP '+response.status+')');
 try{return await response.json()}catch{throw Error('GitHub returned invalid JSON');}
}
const encode=v=>btoa(String.fromCharCode(...new TextEncoder().encode(v)));
export async function createBootstrap(a,_db,p,ctx){
 if(a.confirm!==true)throw Error('Explicit confirmation required to install bootstrap workflow');
 if(!REPO.test(String(a.repository||''))||a.repository.includes('..'))throw Error('Invalid repository');
 if(!BRANCH.test(String(a.branch||''))||a.branch.includes('..')||a.branch.includes('//'))throw Error('Invalid branch');
 const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
 const repo=await git(ctx.fetcher,selected.token,'/repos/'+a.repository);
 if(repo.full_name.toLowerCase()!==a.repository.toLowerCase()||repo.archived||repo.disabled)throw Error('Repository identity mismatch');
 if(repo.default_branch!==a.branch)throw Error('Bootstrap must target the repository default branch');
 if(repo.permissions?.push===false&&repo.permissions?.admin!==true)throw Error('Repository write permission required');
 const path='.github/workflows/atax-tenant-bootstrap.yml';
 const created=await git(ctx.fetcher,selected.token,'/repos/'+a.repository+'/contents/'+path,'PUT',{
  message:'ci: install immutable ATAX Supabase bootstrap',branch:a.branch,content:encode(workflow)
 });
 if(!/^[a-f0-9]{40}$/.test(String(created.commit?.sha||'')))throw Error('Unverified workflow commit');
 return {repository:a.repository,workflow:path,commit_sha:created.commit.sha,schema_sha:SCHEMA_SHA,
  required_secret:'ATAX_BOOTSTRAP_DATABASE_URL',state:'installed_not_executed',verified:false,
  instructions:'Configure ATAX_BOOTSTRAP_DATABASE_URL in YOUR GitHub repository Actions secrets (never in chat). Manually dispatch the workflow; use atax_github_actions_run_status to inspect its exact terminal result before authorizing ATAX OAuth.'};
}

/** Dispatch ONLY the independently byte-verified fixed migration workflow.
 * This is available to bootstrap-only tenants without general Actions dispatch.
 */
export async function dispatchBootstrap(a,_db,p,ctx){
 if(a.confirm!==true)throw Error('Explicit confirmation required to run database bootstrap');
 if(!REPO.test(String(a.repository||''))||a.repository.includes('..'))throw Error('Invalid repository');
 if(!BRANCH.test(String(a.branch||''))||a.branch.includes('..')||a.branch.includes('//'))
  throw Error('Invalid branch');
 const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
 const info=await git(ctx.fetcher,selected.token,'/repos/'+a.repository);
 if(info.full_name.toLowerCase()!==a.repository.toLowerCase()||info.archived||info.disabled)
  throw Error('Repository identity mismatch');
 if(info.default_branch!==a.branch)throw Error('Bootstrap must run only from the reviewed default branch');
 const path='/repos/'+a.repository+'/contents/.github/workflows/atax-tenant-bootstrap.yml?ref='+encodeURIComponent(a.branch);
 const file=await git(ctx.fetcher,selected.token,path);
 if(file.encoding!=='base64'||typeof file.content!=='string')
  throw Error('Bootstrap workflow source cannot be verified');
 let actual;
 try{actual=atob(file.content.replace(/\s/g,''));}catch{throw Error('Bootstrap workflow content invalid');}
 if(actual!==workflow)throw Error('Bootstrap workflow has changed since review; refusing dispatch');
 const response=await ctx.fetcher('https://api.github.com/repos/'+a.repository+'/actions/workflows/atax-tenant-bootstrap.yml/dispatches',{
  method:'POST',redirect:'error',headers:{authorization:'Bearer '+selected.token,
   accept:'application/vnd.github+json','content-type':'application/json','user-agent':'atax-mcp'},
  body:JSON.stringify({ref:a.branch})
 });
 if(response.status!==204)throw Error('GitHub bootstrap dispatch not accepted (HTTP '+response.status+')');
 return {repository:a.repository,workflow:'atax-tenant-bootstrap.yml',
  state:'dispatch_accepted_not_executed',verified:false,
  next:'Use atax_github_actions_run_status for the actual terminal run and check migration subgates. Re-authorize ATAX OAuth after successful schema initialization.'};
}

export const tenantBootstrapTools=[{
 name:'atax_supabase_bootstrap_workflow_create',
 description:'Create a pinned ATAX schema migration workflow in a user-owned GitHub repository. Database URL is provided later only as a GitHub Actions secret.',
 scope:'atax:github:workflow:write',
 inputSchema:{type:'object',additionalProperties:false,
  properties:{repository:{type:'string',minLength:3,maxLength:205},branch:{type:'string',minLength:1,maxLength:100},
   account:{type:'string',maxLength:48},confirm:{type:'boolean'}},
  required:['repository','branch','confirm']},
 invoke:createBootstrap
},{
 name:'atax_supabase_bootstrap_dispatch',
 description:'Dispatch only the unchanged fixed tenant ATAX database bootstrap Actions workflow; no SQL, database credentials, or other workflows accepted.',
 scope:'atax:github:workflow:write',
 inputSchema:{type:'object',additionalProperties:false,
  properties:{repository:{type:'string',minLength:3,maxLength:205},branch:{type:'string',minLength:1,maxLength:100},
   account:{type:'string',maxLength:48},confirm:{type:'boolean'}},required:['repository','branch','confirm']},
 invoke:dispatchBootstrap
}];
