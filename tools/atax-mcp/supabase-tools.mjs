import {resolveProviderAccount} from './provider-accounts.mjs';

const SUPABASE_API = 'https://api.supabase.com/v1';
const SLUG_OR_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_REF = /^[a-z]{20}$/;

const tool = (name, description, scope, inputSchema, invoke) => ({name, description, scope, inputSchema, invoke});
const schema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const accountArg = {
  type: 'string',
  maxLength: 48,
  description: 'Optional named Supabase account alias (SUPABASE_KEY_<ALIAS>); required when multiple accounts are configured',
};
const supaSchema = (other = {}, required = []) => schema({account: accountArg, ...other}, required);

function assertProjectRef(val) {
  const ref = String(val || '').trim();
  if (!PROJECT_REF.test(ref)) throw new Error('Valid 20-character lowercase Supabase project_ref is required');
  return ref;
}

function resolveOrgSlug(ctx, selected, requestedOrgSlug) {
  const configured = ctx.env['SUPABASE_ORG_SLUG_' + selected.alias];
  const slug = requestedOrgSlug ? String(requestedOrgSlug).trim() : configured;
  if (!slug) return null;
  if (!SLUG_OR_ID.test(slug)) throw new Error('Invalid Supabase organization slug');
  if (configured && requestedOrgSlug && slug !== configured) {
    throw new Error('Supabase organization slug differs from configured account binding');
  }
  return slug;
}

async function supabaseRequest(fetcher, path, token, {method = 'GET', body} = {}) {
  const res = await fetcher(`${SUPABASE_API}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': 'atax-mcp-control-plane',
      ...(body === undefined ? {} : {'content-type': 'application/json'}),
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  let parsed = null;
  try {
    if (res.status !== 204) parsed = await res.json();
  } catch {
    if (res.ok) throw new Error('Supabase API returned invalid JSON');
  }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
    throw new Error(`Supabase API request failed (HTTP ${res.status}: ${String(msg).slice(0, 200)})`);
  }
  return parsed;
}

async function supabaseAccountGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'supabase', a.account);
  const orgs = await supabaseRequest(ctx.fetcher, '/organizations', selected.token);
  return {
    operation: 'supabase_account_get',
    account: selected.alias,
    configured_org_slug: ctx.env['SUPABASE_ORG_SLUG_' + selected.alias] || null,
    organizations: Array.isArray(orgs)
      ? orgs.slice(0, 50).map(o => ({id: o.id ?? null, slug: o.slug ?? null, name: o.name ?? null}))
      : [],
  };
}

async function supabaseProjectsList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'supabase', a.account);
  const orgSlug = resolveOrgSlug(ctx, selected, a.org_slug);
  const projects = await supabaseRequest(ctx.fetcher, '/projects', selected.token);
  const list = Array.isArray(projects) ? projects : [];
  const filtered = orgSlug ? list.filter(pr => pr.organization_slug === orgSlug || pr.organization_id === orgSlug) : list;
  return {
    operation: 'supabase_projects_list',
    account: selected.alias,
    org_slug: orgSlug,
    projects: filtered.slice(0, a.limit ?? 50).map(pr => ({
      ref: pr.id ?? pr.ref ?? null,
      name: pr.name ?? null,
      organization_slug: pr.organization_slug ?? null,
      organization_id: pr.organization_id ?? null,
      region: pr.region ?? null,
      status: pr.status ?? null,
      created_at: pr.created_at ?? null,
    })),
  };
}

async function supabaseProjectGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'supabase', a.account);
  const ref = assertProjectRef(a.project_ref);
  const pr = await supabaseRequest(ctx.fetcher, `/projects/${encodeURIComponent(ref)}`, selected.token);
  return {
    operation: 'supabase_project_get',
    account: selected.alias,
    project: {
      ref: pr?.id ?? ref,
      name: pr?.name ?? null,
      organization_slug: pr?.organization_slug ?? null,
      organization_id: pr?.organization_id ?? null,
      region: pr?.region ?? null,
      status: pr?.status ?? null,
      database: pr?.database ? {host: pr.database.host ?? null, version: pr.database.version ?? null} : null,
      created_at: pr?.created_at ?? null,
    },
  };
}

async function supabaseProjectCreate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'supabase', a.account);
  const orgSlug = resolveOrgSlug(ctx, selected, a.org_slug);
  if (!orgSlug) throw new Error('org_slug (or SUPABASE_ORG_SLUG_<ALIAS>) is required');
  const name = String(a.name || '').trim();
  const region = String(a.region || '').trim();
  const dbPass = String(a.db_pass || '');
  if (!name || !region || !dbPass) throw new Error('name, region, and db_pass are required');
  const pr = await supabaseRequest(ctx.fetcher, '/projects', selected.token, {
    method: 'POST',
    body: {name, organization_id: orgSlug, region, db_pass: dbPass},
  });
  return {
    operation: 'supabase_project_create',
    account: selected.alias,
    project: {
      ref: pr?.id ?? null,
      name: pr?.name ?? name,
      organization_slug: pr?.organization_slug ?? orgSlug,
      region: pr?.region ?? region,
      status: pr?.status ?? null,
      created_at: pr?.created_at ?? null,
    },
  };
}

async function supabaseApiKeysList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'supabase', a.account);
  const ref = assertProjectRef(a.project_ref);
  const keys = await supabaseRequest(ctx.fetcher, `/projects/${encodeURIComponent(ref)}/api-keys`, selected.token);
  return {
    operation: 'supabase_api_keys_list',
    account: selected.alias,
    project_ref: ref,
    keys: Array.isArray(keys)
      ? keys.slice(0, 50).map(k => ({
          id: k.id ?? null,
          name: k.name ?? null,
          type: k.type ?? null,
          prefix: k.prefix ?? null,
          disabled: Boolean(k.disabled),
        }))
      : [],
  };
}

async function supabaseQuerySql(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'supabase', a.account);
  const ref = assertProjectRef(a.project_ref);
  const query = String(a.query || '').trim();
  if (!query) throw new Error('query is required');
  const endpoint = a.read_only ? 'database/query/read-only' : 'database/query';
  const rows = await supabaseRequest(ctx.fetcher, `/projects/${encodeURIComponent(ref)}/${endpoint}`, selected.token, {
    method: 'POST',
    body: {query},
  });
  return {
    operation: a.read_only ? 'supabase_sql_read_only' : 'supabase_sql_query',
    account: selected.alias,
    project_ref: ref,
    rows: Array.isArray(rows) ? rows.slice(0, a.max_rows ?? 200) : rows,
  };
}

async function supabaseFunctionsList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'supabase', a.account);
  const ref = assertProjectRef(a.project_ref);
  const fns = await supabaseRequest(ctx.fetcher, `/projects/${encodeURIComponent(ref)}/functions`, selected.token);
  return {
    operation: 'supabase_functions_list',
    account: selected.alias,
    project_ref: ref,
    functions: Array.isArray(fns)
      ? fns.slice(0, 100).map(fn => ({
          id: fn.id ?? null,
          slug: fn.slug ?? null,
          name: fn.name ?? null,
          status: fn.status ?? null,
          version: fn.version ?? null,
          verify_jwt: fn.verify_jwt ?? null,
        }))
      : [],
  };
}

async function supabaseAdvisorsGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'supabase', a.account);
  const ref = assertProjectRef(a.project_ref);
  const kind = a.kind === 'performance' ? 'performance' : 'security';
  const items = await supabaseRequest(ctx.fetcher, `/projects/${encodeURIComponent(ref)}/advisors/${kind}`, selected.token);
  return {
    operation: `supabase_advisors_${kind}`,
    account: selected.alias,
    project_ref: ref,
    advisors: Array.isArray(items) ? items.slice(0, 100) : items,
  };
}

export const supabaseTools = [
  tool('atax_supabase_account_get', 'Inspect accessible Supabase organizations for a selected owner token.', 'atax:supabase:read', supaSchema(), supabaseAccountGet),
  tool('atax_supabase_projects_list', 'List Supabase projects accessible to a selected owner token.', 'atax:supabase:read', supaSchema({org_slug: {type: 'string', maxLength: 128}, limit: {type: 'integer', minimum: 1, maximum: 100}}), supabaseProjectsList),
  tool('atax_supabase_project_get', 'Inspect a Supabase project by 20-character project_ref.', 'atax:supabase:read', supaSchema({project_ref: {type: 'string', minLength: 20, maxLength: 20}}, ['project_ref']), supabaseProjectGet),
  tool('atax_supabase_project_create', 'Create a new Supabase project under an organization.', 'atax:supabase:write', supaSchema({name: {type: 'string', maxLength: 128}, org_slug: {type: 'string', maxLength: 128}, region: {type: 'string', maxLength: 64}, db_pass: {type: 'string', minLength: 8, maxLength: 128}}, ['name', 'region', 'db_pass']), supabaseProjectCreate),
  tool('atax_supabase_api_keys_list', 'List API key metadata for a Supabase project.', 'atax:supabase:read', supaSchema({project_ref: {type: 'string', minLength: 20, maxLength: 20}}, ['project_ref']), supabaseApiKeysList),
  tool('atax_supabase_sql_query', 'Execute SQL against a Supabase project via the Management API (supports read_only mode).', 'atax:supabase:write', supaSchema({project_ref: {type: 'string', minLength: 20, maxLength: 20}, query: {type: 'string', minLength: 1, maxLength: 16384}, read_only: {type: 'boolean'}, max_rows: {type: 'integer', minimum: 1, maximum: 500}}, ['project_ref', 'query']), supabaseQuerySql),
  tool('atax_supabase_functions_list', 'List Edge Functions deployed to a Supabase project.', 'atax:supabase:read', supaSchema({project_ref: {type: 'string', minLength: 20, maxLength: 20}}, ['project_ref']), supabaseFunctionsList),
  tool('atax_supabase_advisors_get', 'Fetch security or performance advisors for a Supabase project.', 'atax:supabase:read', supaSchema({project_ref: {type: 'string', minLength: 20, maxLength: 20}, kind: {type: 'string', enum: ['security', 'performance']}}, ['project_ref']), supabaseAdvisorsGet),
];
