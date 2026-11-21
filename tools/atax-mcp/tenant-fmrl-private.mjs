/** Private FMRL controller is installed in the user's PRIVATE target repo.
 * It uses the existing reviewed ATAX FMRL scripts at an immutable public SHA.
 * All source credentials are GitHub Actions secrets owned by the user.
 */
import {resolveProviderAccount} from './provider-accounts.mjs';
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH=/^[A-Za-z0-9._/-]{1,100}$/;
const PIN='d182e89a590a088bebd3aa18add8891ad3001fb2';
const requiredSecrets=['ATAX_FMRL_REPO_WRITE_TOKEN','ATAX_FMRL_SOURCE_READ_TOKEN',
 'ATAX_FMRL_ACTIONS_SECRET_TOKEN','ATAX_FMRL_ACTIONS_DISPATCH_TOKEN'];
const secret=name=>'$'+'{{ secrets.'+name+' }}';
const input=name=>'$'+'{{ inputs.'+name+' }}';
const workflow=[
 'name: ATAX tenant-owned private FMRL',
 'run-name: Tenant FMRL private verification',
 'on:',
 '  workflow_dispatch:',
 '    inputs:',
 '      target_sha:',
 '        description: Exact private target 40-character commit SHA',
 '        required: true',
 '        type: string',
 '      mode:',
 '        required: true',
 '        type: choice',
 '        options: [direct, act]',
 'permissions:',
 '  contents: read',
 'concurrency:',
 '  group: atax-private-fmrl-'+input('target_sha'),
 '  cancel-in-progress: false',
 'jobs:',
 '  verify:',
 '    runs-on: ubuntu-latest',
 '    timeout-minutes: 60',
 '    steps:',
 '      - name: Checkout immutable public ATAX FMRL scripts only',
 '        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
 '        with:',
 '          repository: dinilmusick/ATAX',
 '          ref: '+PIN,
 '          persist-credentials: false',
 '      - name: Check exact revision and private GitHub credentials',
 '        shell: bash',
 '        env:',
 '          TARGET_SHA: '+input('target_sha'),
 '          FMRL_MODE: '+input('mode'),
 '          CODING_REPO_TOKEN: '+secret('ATAX_FMRL_REPO_WRITE_TOKEN'),
 '          PRIVATE_REPO_TOKEN: '+secret('ATAX_FMRL_SOURCE_READ_TOKEN'),
 '          FMRL_SECRETS_TOKEN: '+secret('ATAX_FMRL_ACTIONS_SECRET_TOKEN'),
 '          FMRL_DISPATCH_TOKEN: '+secret('ATAX_FMRL_ACTIONS_DISPATCH_TOKEN'),
 '        run: |',
 '          set -euo pipefail',
 '          [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Exact SHA required" >&2; exit 1; }',
 '          [[ "$FMRL_MODE" == direct || "$FMRL_MODE" == act ]] || exit 1',
 '          test -n "$CODING_REPO_TOKEN" || exit 1',
 '          test -n "$PRIVATE_REPO_TOKEN" || exit 1',
 '          test -n "$FMRL_SECRETS_TOKEN" || exit 1',
 '          test -n "$FMRL_DISPATCH_TOKEN" || exit 1',
 '      - name: Provision disposable user-owned PUBLIC FMRL bridge',
 '        id: bridge',
 '        shell: bash',
 '        env:',
 '          CODING_REPO_TOKEN: '+secret('ATAX_FMRL_REPO_WRITE_TOKEN'),
 '          PRIVATE_REPO_TOKEN: '+secret('ATAX_FMRL_SOURCE_READ_TOKEN'),
 '          FMRL_SECRETS_TOKEN: '+secret('ATAX_FMRL_ACTIONS_SECRET_TOKEN'),
 '          TARGET_SHA: '+input('target_sha'),
 '          FMRL_MODE: '+input('mode'),
 '        run: |',
 '          set -euo pipefail',
 '          python3 tools/github/disposable_workspace.py --source "$GITHUB_REPOSITORY" --ref "$TARGET_SHA" --target "FMRL-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --mode "$FMRL_MODE" >/tmp/atax-fmrl.json',
 '          bridge="$(python3 -c "import json;print(json.load(open('+"'"+'/tmp/atax-fmrl.json'+"'"+'))['+"'"+'disposable_repository'+"'"+'])")"',
 '          [[ "$bridge" =~ ^[A-Za-z0-9_.-]+/FMRL-[A-Za-z0-9-]+$ ]] || exit 1',
 '          echo "repository=$bridge" >> "$GITHUB_OUTPUT"',
 '          echo "Disposable public bridge created; no private source committed" >> "$GITHUB_STEP_SUMMARY"',
 '      - name: Dispatch FMRL runner and inspect actual terminal conclusion',
 '        shell: bash',
 '        env:',
 '          GH_TOKEN: '+secret('ATAX_FMRL_ACTIONS_DISPATCH_TOKEN'),
 '          BRIDGE: $'+'{{ steps.bridge.outputs.repository }}',
 '        run: |',
 '          set -euo pipefail',
 '          gh api -X POST "repos/$BRIDGE/actions/workflows/atax-private-ci.yml/dispatches" -f ref=main >/dev/null',
 '          found=0',
 '          for attempt in $(seq 1 75); do',
 '            response="$(gh api "repos/$BRIDGE/actions/workflows/atax-private-ci.yml/runs?event=workflow_dispatch&per_page=5")"',
 '            status="$(printf "%s" "$response" | jq -r ".workflow_runs[0].status // empty")"',
 '            conclusion="$(printf "%s" "$response" | jq -r ".workflow_runs[0].conclusion // empty")"',
 '            if [[ "$status" == completed ]]; then',
 '              found=1',
 '              echo "FMRL terminal conclusion: $conclusion" >> "$GITHUB_STEP_SUMMARY"',
 '              test "$conclusion" = success || exit 1',
 '              break',
 '            fi',
 '            sleep 30',
 '          done',
 '          test "$found" = 1 || { echo "FMRL run not terminal" >&2; exit 1; }',
 '      - name: ALWAYS delete public bridge and independently verify 404',
 "        if: always() && steps.bridge.outputs.repository != ''",
 '        shell: bash',
 '        env:',
 '          GITHUB_TOKEN: '+secret('ATAX_FMRL_REPO_WRITE_TOKEN'),
 '          GITHUB_INDEPENDENT_READ_TOKEN: '+secret('ATAX_FMRL_SOURCE_READ_TOKEN'),
 '          BRIDGE: $'+'{{ steps.bridge.outputs.repository }}',
 '        run: |',
 '          set -euo pipefail',
 '          python3 tools/github/repository_lifecycle.py delete --repository "$BRIDGE"',
 '          echo "Disposable bridge deletion independently verified" >> "$GITHUB_STEP_SUMMARY"'
].join('\n')+'\n';
const b64=v=>btoa(String.fromCharCode(...new TextEncoder().encode(v)));
async function github(fetcher,token,path,method='GET',body){
 const r=await fetcher('https://api.github.com'+path,{method,redirect:'error',headers:{
  authorization:'Bearer '+token,accept:'application/vnd.github+json','user-agent':'atax-mcp',
  ...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 if(!r.ok)throw Error('Private FMRL setup rejected (HTTP '+r.status+')');
 try{return await r.json()}catch{throw Error('GitHub FMRL setup returned invalid JSON');}
}
export async function createPrivateFmrl(a,_db,p,ctx){
 if(a.confirm!==true)throw Error('Explicit confirmation required before private FMRL setup');
 if(!REPO.test(String(a.repository||''))||a.repository.includes('..'))throw Error('Invalid repository');
 if(!BRANCH.test(String(a.branch||''))||a.branch.includes('..')||a.branch.includes('//'))throw Error('Invalid branch');
 const selected=resolveProviderAccount(ctx.env,p,'github',a.account);
 const info=await github(ctx.fetcher,selected.token,'/repos/'+a.repository);
 if(info.full_name.toLowerCase()!==a.repository.toLowerCase()||info.private!==true||info.archived||info.disabled)
  throw Error('Private FMRL workflow requires the authenticated user private repository');
 if(info.default_branch!==a.branch)throw Error('FMRL workflow must be installed on the target default branch');
 if(info.permissions?.push===false&&info.permissions?.admin!==true)throw Error('GitHub repository write permission required');
 const path='.github/workflows/atax-tenant-private-fmrl.yml';
 const made=await github(ctx.fetcher,selected.token,'/repos/'+a.repository+'/contents/'+path,'PUT',{
  message:'ci: install tenant-owned private FMRL controller',branch:a.branch,content:b64(workflow)
 });
 if(!/^[0-9a-f]{40}$/.test(String(made.commit?.sha||'')))throw Error('GitHub workflow commit unverified');
 return {repository:a.repository,path,commit_sha:made.commit.sha,atax_script_sha:PIN,
  required_github_secrets:requiredSecrets,state:'installed_not_executed',verified:false,
  instructions:'Configure four PAT secrets in YOUR private target repository Actions settings; dispatch this workflow with exact target_sha and direct/act mode using the existing atax_github_actions_dispatch tool. Verify terminal success, job conclusions and mandatory public bridge deletion via atax_github_actions_run_status.'};
}
export const tenantPrivateFmrlTools=[{
 name:'atax_fmrl_private_workflow_create',
 description:'Install a private-target GitHub Actions FMRL controller under the tenant private repository, using encrypted secrets and disposable tenant-owned public CI.',
 scope:'atax:github:workflow:write',
 inputSchema:{type:'object',additionalProperties:false,
  properties:{repository:{type:'string',minLength:3,maxLength:205},branch:{type:'string',minLength:1,maxLength:100},
   account:{type:'string',maxLength:48},confirm:{type:'boolean'}},
  required:['repository','branch','confirm']},
 invoke:createPrivateFmrl
}];
