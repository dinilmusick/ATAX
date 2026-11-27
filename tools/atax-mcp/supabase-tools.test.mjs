import test from 'node:test';
import assert from 'node:assert/strict';
import {supabaseTools} from './supabase-tools.mjs';

const owner = {id: 'owner', authMethod: 'shared'};
const outsider = {id: 'outsider', authMethod: 'jwt'};
const env = {
  MCP_SHARED_SUBJECT: 'owner',
  MCP_SHARED_TOKEN_SHA256: 'test-digest',
  SUPABASE_KEY_PERSONAL: 'supa-personal-secret',
  SUPABASE_KEY_WORK: 'supa-work-secret',
  SUPABASE_ORG_SLUG_WORK: 'work-org',
};
const REF = 'abcdefghijklmnopqrst';

const find = name => supabaseTools.find(t => t.name === name);
const invoke = (name, args = {}, principal = owner, config = env, fetcher = async () => Response.json([])) =>
  find(name).invoke(args, null, principal, {env: config, fetcher});

test('multi-account Supabase selection uses requested token and rejects missing alias when ambiguous', async () => {
  const seen = [];
  const fetcher = async (url, opts) => {
    seen.push({url, opts});
    if (url.endsWith('/organizations')) {
      return Response.json([{id: 'org-1', slug: 'work-org', name: 'Work Org'}]);
    }
    if (url.endsWith('/projects')) {
      return Response.json([
        {id: REF, name: 'atax-prod', organization_slug: 'work-org', organization_id: 'org-1', region: 'us-east-1', status: 'ACTIVE_HEALTHY'},
        {id: 'zzzzzzzzzzzzzzzzzzzz', name: 'other-proj', organization_slug: 'other-org', organization_id: 'org-2', region: 'eu-west-1', status: 'ACTIVE_HEALTHY'},
      ]);
    }
    throw new Error('Unexpected URL ' + url);
  };

  const acct = await invoke('atax_supabase_account_get', {account: 'work'}, owner, env, fetcher);
  assert.equal(acct.account, 'WORK');
  assert.equal(acct.configured_org_slug, 'work-org');
  assert.equal(acct.organizations[0].slug, 'work-org');

  const projs = await invoke('atax_supabase_projects_list', {account: 'WORK'}, owner, env, fetcher);
  assert.equal(projs.account, 'WORK');
  assert.equal(projs.org_slug, 'work-org');
  assert.equal(projs.projects.length, 1);
  assert.equal(projs.projects[0].ref, REF);
  assert.ok(seen.every(x => x.opts.headers.authorization === 'Bearer supa-work-secret'));
  assert.ok(!JSON.stringify({acct, projs}).includes('supa-work-secret'));

  await assert.rejects(invoke('atax_supabase_account_get', {}, owner, env, fetcher), /Specify an account alias/);
  await assert.rejects(invoke('atax_supabase_projects_list', {account: 'WORK', org_slug: 'wrong-org'}, owner, env, fetcher), /differs/);
});

test('single-account Supabase config works without explicit alias and outsiders are rejected', async () => {
  const singleEnv = {...env, SUPABASE_KEY_WORK: undefined, SUPABASE_ORG_SLUG_WORK: undefined};
  const fetcher = async () => Response.json([{id: 'org-p', slug: 'personal-org', name: 'Personal'}]);
  const res = await invoke('atax_supabase_account_get', {}, owner, singleEnv, fetcher);
  assert.equal(res.account, 'PERSONAL');
  assert.equal(res.configured_org_slug, null);

  await assert.rejects(invoke('atax_supabase_account_get', {account: 'WORK'}, outsider, env, fetcher), /not authorized/);
  await assert.rejects(invoke('atax_supabase_projects_list', {account: 'PERSONAL'}, outsider, env, fetcher), /not authorized/);
});

test('Supabase project, API keys, SQL, functions, advisors and HTTP 403/500 error handling', async () => {
  const seen = [];
  const fetcher = async (url, opts) => {
    seen.push({url, opts});
    if (url.endsWith(`/projects/${REF}`)) {
      return Response.json({id: REF, name: 'atax', organization_slug: 'work-org', region: 'us-east-1', status: 'ACTIVE_HEALTHY', database: {host: 'db.example.supabase.co', version: '15'}});
    }
    if (url.endsWith('/projects') && opts.method === 'POST') {
      return Response.json({id: REF, name: 'new-db', organization_slug: 'work-org', region: 'us-east-1', status: 'COMING_UP'});
    }
    if (url.endsWith(`/projects/${REF}/api-keys`)) {
      return Response.json([{id: 'k1', name: 'anon', type: 'legacy', prefix: 'eyJ', disabled: false}]);
    }
    if (url.endsWith(`/projects/${REF}/database/query/read-only`)) {
      return Response.json([{ok: 1}]);
    }
    if (url.endsWith(`/projects/${REF}/functions`)) {
      return Response.json([{id: 'fn1', slug: 'hello', name: 'hello', status: 'ACTIVE', version: 2, verify_jwt: true}]);
    }
    if (url.endsWith(`/projects/${REF}/advisors/security`)) {
      return Response.json([{name: 'rls_disabled', level: 'WARN'}]);
    }
    throw new Error('Unexpected URL ' + url);
  };

  const proj = await invoke('atax_supabase_project_get', {account: 'WORK', project_ref: REF}, owner, env, fetcher);
  assert.equal(proj.project.database.version, '15');

  const created = await invoke('atax_supabase_project_create', {account: 'WORK', name: 'new-db', region: 'us-east-1', db_pass: 'super-secret-pass'}, owner, env, fetcher);
  assert.equal(created.project.ref, REF);

  const keys = await invoke('atax_supabase_api_keys_list', {account: 'WORK', project_ref: REF}, owner, env, fetcher);
  assert.equal(keys.keys[0].name, 'anon');

  const sql = await invoke('atax_supabase_sql_query', {account: 'WORK', project_ref: REF, query: 'select 1 as ok', read_only: true}, owner, env, fetcher);
  assert.equal(sql.operation, 'supabase_sql_read_only');
  assert.deepEqual(sql.rows, [{ok: 1}]);

  const fns = await invoke('atax_supabase_functions_list', {account: 'WORK', project_ref: REF}, owner, env, fetcher);
  assert.equal(fns.functions[0].slug, 'hello');

  const adv = await invoke('atax_supabase_advisors_get', {account: 'WORK', project_ref: REF, kind: 'security'}, owner, env, fetcher);
  assert.equal(adv.advisors[0].name, 'rls_disabled');

  await assert.rejects(invoke('atax_supabase_project_get', {account: 'WORK', project_ref: 'bad'}, owner, env, fetcher), /20-character/);
  await assert.rejects(invoke('atax_supabase_account_get', {account: 'WORK'}, owner, env, async () => Response.json({message: 'Forbidden'}, {status: 403})), /HTTP 403/);
  await assert.rejects(invoke('atax_supabase_account_get', {account: 'WORK'}, owner, env, async () => Response.json({error: 'Internal Server Error'}, {status: 500})), /HTTP 500/);
  await assert.rejects(invoke('atax_supabase_account_get', {account: 'WORK'}, owner, env, async () => new Response('not-json', {status: 200})), /invalid JSON/);
});
