import {resolveProviderAccount} from './provider-accounts.mjs';

/**
 * Multi-account Neon control-plane tools for ATAX MCP.
 * Manages Neon projects, branches, databases, roles, compute endpoints, and connection URIs.
 * Neon is NEVER used as the ATAX backend (ATAX uses Supabase); tokens never leave this module.
 */

const NEON_API = 'https://console.neon.tech/api/v2';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const tool = (name, description, scope, inputSchema, invoke) => ({name, description, scope, inputSchema, invoke});
const schema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const accountArg = {
  type: 'string',
  maxLength: 48,
  description: 'Optional named Neon account alias (NEON_KEY_<ALIAS>); required when multiple accounts are configured',
};
const neonSchema = (other = {}, required = []) => schema({account: accountArg, ...other}, required);

function assertId(val, label) {
  const s = String(val || '').trim();
  if (!s || !ID.test(s)) throw new Error(`Valid ${label} is required`);
  return s;
}

function assertName(val, label) {
  const s = String(val || '').trim();
  if (!s || !NAME.test(s)) throw new Error(`Valid ${label} is required (1-64 alphanumeric, _, ., or - chars)`);
  return s;
}

function resolveOrgId(ctx, selected, requestedOrgId) {
  const configured = ctx.env['NEON_ORG_ID_' + selected.alias];
  const id = requestedOrgId ? String(requestedOrgId).trim() : configured;
  if (!id) return null;
  if (!ID.test(id)) throw new Error('Invalid Neon organization ID');
  if (configured && requestedOrgId && id !== configured) {
    throw new Error('Neon organization ID differs from configured account binding');
  }
  return id;
}

async function neonRequest(fetcher, path, token, {method = 'GET', body} = {}) {
  const url = `${NEON_API}${path}`;
  const res = await fetcher(url, {
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
    if (res.ok) throw new Error('Neon API returned invalid JSON');
  }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
    throw new Error(`Neon API request failed (HTTP ${res.status}: ${String(msg).slice(0, 200)})`);
  }
  return parsed;
}

async function neonAccountGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const me = await neonRequest(ctx.fetcher, '/users/me', selected.token);
  let orgs = [];
  try {
    const orgPayload = await neonRequest(ctx.fetcher, '/users/me/organizations', selected.token);
    orgs = Array.isArray(orgPayload?.organizations)
      ? orgPayload.organizations.slice(0, 50).map(o => ({id: o.id, name: o.name, handle: o.handle ?? null}))
      : [];
  } catch {
    orgs = [];
  }
  return {
    operation: 'neon_account_get',
    account: selected.alias,
    configured_org_id: ctx.env['NEON_ORG_ID_' + selected.alias] || null,
    user: me
      ? {
          id: me.id ?? null,
          email: me.email ?? null,
          name: me.name ?? null,
          login: me.login ?? null,
          plan: me.plan ?? null,
        }
      : null,
    organizations: orgs,
  };
}

async function neonProjectsList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const orgId = resolveOrgId(ctx, selected, a.org_id);
  const limit = a.limit ?? 20;
  const qs = new URLSearchParams({limit: String(limit)});
  if (orgId) qs.set('org_id', orgId);
  const data = await neonRequest(ctx.fetcher, `/projects?${qs.toString()}`, selected.token);
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  return {
    operation: 'neon_projects_list',
    account: selected.alias,
    org_id: orgId,
    projects: projects.map(pr => ({
      id: pr.id,
      name: pr.name,
      region_id: pr.region_id,
      pg_version: pr.pg_version,
      platform_id: pr.platform_id ?? null,
      org_id: pr.org_id ?? null,
      created_at: pr.created_at ?? null,
      updated_at: pr.updated_at ?? null,
    })),
  };
}

async function neonProjectGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}`, selected.token);
  const pr = data?.project || data || {};
  return {
    operation: 'neon_project_get',
    account: selected.alias,
    project: {
      id: pr.id,
      name: pr.name,
      region_id: pr.region_id,
      pg_version: pr.pg_version,
      org_id: pr.org_id ?? null,
      default_endpoint_settings: pr.default_endpoint_settings ?? null,
      created_at: pr.created_at ?? null,
      updated_at: pr.updated_at ?? null,
    },
  };
}

async function neonProjectCreate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const orgId = resolveOrgId(ctx, selected, a.org_id);
  const projectBody = {};
  if (a.name) projectBody.name = String(a.name).trim();
  if (a.region_id) projectBody.region_id = String(a.region_id).trim();
  if (a.pg_version !== undefined) projectBody.pg_version = a.pg_version;
  if (orgId) projectBody.org_id = orgId;
  const data = await neonRequest(ctx.fetcher, '/projects', selected.token, {
    method: 'POST',
    body: {project: projectBody},
  });
  const pr = data?.project || {};
  return {
    operation: 'neon_project_create',
    account: selected.alias,
    project: {
      id: pr.id,
      name: pr.name,
      region_id: pr.region_id,
      pg_version: pr.pg_version,
      org_id: pr.org_id ?? null,
      created_at: pr.created_at ?? null,
    },
    branch: data?.branch ? {id: data.branch.id, name: data.branch.name, primary: Boolean(data.branch.primary)} : null,
    databases: Array.isArray(data?.databases) ? data.databases.map(d => ({id: d.id, name: d.name, owner_name: d.owner_name})) : [],
    roles: Array.isArray(data?.roles) ? data.roles.map(r => ({name: r.name, protected: Boolean(r.protected)})) : [],
    endpoints: Array.isArray(data?.endpoints) ? data.endpoints.map(e => ({id: e.id, host: e.host, type: e.type, current_state: e.current_state})) : [],
  };
}

async function neonProjectUpdate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const project = {};
  if (a.name !== undefined) project.name = String(a.name).trim();
  if (Object.keys(project).length === 0) throw new Error('At least one project field (e.g. name) is required');
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}`, selected.token, {
    method: 'PATCH',
    body: {project},
  });
  const pr = data?.project || {};
  return {
    operation: 'neon_project_update',
    account: selected.alias,
    project: {id: pr.id, name: pr.name, region_id: pr.region_id, pg_version: pr.pg_version, updated_at: pr.updated_at ?? null},
  };
}

async function neonProjectDelete(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}`, selected.token, {method: 'DELETE'});
  return {operation: 'neon_project_delete', account: selected.alias, project_id: projectId, deleted: true};
}

async function neonBranchesList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches`, selected.token);
  const branches = Array.isArray(data?.branches) ? data.branches : [];
  return {
    operation: 'neon_branches_list',
    account: selected.alias,
    project_id: projectId,
    branches: branches.slice(0, 50).map(b => ({
      id: b.id,
      name: b.name,
      parent_id: b.parent_id ?? null,
      primary: Boolean(b.primary),
      default: Boolean(b.default),
      current_state: b.current_state ?? null,
      created_at: b.created_at ?? null,
    })),
  };
}

async function neonBranchCreate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const branch = {};
  if (a.name) branch.name = String(a.name).trim();
  if (a.parent_id) branch.parent_id = assertId(a.parent_id, 'parent_id');
  if (a.init_source) branch.init_source = a.init_source;
  const body = {branch};
  if (a.endpoints !== undefined) body.endpoints = a.endpoints;
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches`, selected.token, {
    method: 'POST',
    body,
  });
  const b = data?.branch || {};
  return {
    operation: 'neon_branch_create',
    account: selected.alias,
    project_id: projectId,
    branch: {id: b.id, name: b.name, parent_id: b.parent_id ?? null, current_state: b.current_state ?? null, created_at: b.created_at ?? null},
    endpoints: Array.isArray(data?.endpoints) ? data.endpoints.map(e => ({id: e.id, host: e.host, type: e.type, current_state: e.current_state})) : [],
  };
}

async function neonBranchDelete(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const branchId = assertId(a.branch_id, 'branch_id');
  await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`, selected.token, {method: 'DELETE'});
  return {operation: 'neon_branch_delete', account: selected.alias, project_id: projectId, branch_id: branchId, deleted: true};
}

async function neonDatabasesList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const branchId = assertId(a.branch_id, 'branch_id');
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`, selected.token);
  const databases = Array.isArray(data?.databases) ? data.databases : [];
  return {
    operation: 'neon_databases_list',
    account: selected.alias,
    project_id: projectId,
    branch_id: branchId,
    databases: databases.slice(0, 50).map(d => ({id: d.id, name: d.name, owner_name: d.owner_name, created_at: d.created_at ?? null})),
  };
}

async function neonDatabaseCreate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const branchId = assertId(a.branch_id, 'branch_id');
  const name = assertName(a.name, 'database name');
  const ownerName = assertName(a.owner_name, 'owner_name');
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`, selected.token, {
    method: 'POST',
    body: {database: {name, owner_name: ownerName}},
  });
  const d = data?.database || {};
  return {
    operation: 'neon_database_create',
    account: selected.alias,
    project_id: projectId,
    branch_id: branchId,
    database: {id: d.id, name: d.name, owner_name: d.owner_name, created_at: d.created_at ?? null},
  };
}

async function neonDatabaseDelete(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const branchId = assertId(a.branch_id, 'branch_id');
  const dbName = assertName(a.database_name, 'database_name');
  await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases/${encodeURIComponent(dbName)}`, selected.token, {method: 'DELETE'});
  return {operation: 'neon_database_delete', account: selected.alias, project_id: projectId, branch_id: branchId, database_name: dbName, deleted: true};
}

async function neonRolesList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const branchId = assertId(a.branch_id, 'branch_id');
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/roles`, selected.token);
  const roles = Array.isArray(data?.roles) ? data.roles : [];
  return {
    operation: 'neon_roles_list',
    account: selected.alias,
    project_id: projectId,
    branch_id: branchId,
    roles: roles.slice(0, 50).map(r => ({name: r.name, protected: Boolean(r.protected), created_at: r.created_at ?? null})),
  };
}

async function neonRoleCreate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const branchId = assertId(a.branch_id, 'branch_id');
  const name = assertName(a.name, 'role name');
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/roles`, selected.token, {
    method: 'POST',
    body: {role: {name}},
  });
  const r = data?.role || {};
  return {
    operation: 'neon_role_create',
    account: selected.alias,
    project_id: projectId,
    branch_id: branchId,
    role: {name: r.name, protected: Boolean(r.protected), created_at: r.created_at ?? null},
  };
}

async function neonRoleDelete(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const branchId = assertId(a.branch_id, 'branch_id');
  const roleName = assertName(a.role_name, 'role_name');
  await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/roles/${encodeURIComponent(roleName)}`, selected.token, {method: 'DELETE'});
  return {operation: 'neon_role_delete', account: selected.alias, project_id: projectId, branch_id: branchId, role_name: roleName, deleted: true};
}

async function neonEndpointsList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const path = a.branch_id
    ? `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(assertId(a.branch_id, 'branch_id'))}/endpoints`
    : `/projects/${encodeURIComponent(projectId)}/endpoints`;
  const data = await neonRequest(ctx.fetcher, path, selected.token);
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
  return {
    operation: 'neon_endpoints_list',
    account: selected.alias,
    project_id: projectId,
    endpoints: endpoints.slice(0, 50).map(e => ({
      id: e.id,
      branch_id: e.branch_id,
      host: e.host,
      type: e.type,
      current_state: e.current_state,
      autoscaling_limit_min_cu: e.autoscaling_limit_min_cu ?? null,
      autoscaling_limit_max_cu: e.autoscaling_limit_max_cu ?? null,
      pooler_enabled: Boolean(e.pooler_enabled),
    })),
  };
}

async function neonEndpointControl(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const action = String(a.action || '').trim();
  if (action === 'create') {
    const branchId = assertId(a.branch_id, 'branch_id');
    const endpoint = {branch_id: branchId, type: a.type || 'read_write'};
    if (a.pooler_enabled !== undefined) endpoint.pooler_enabled = Boolean(a.pooler_enabled);
    const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/endpoints`, selected.token, {
      method: 'POST',
      body: {endpoint},
    });
    const e = data?.endpoint || {};
    return {
      operation: 'neon_endpoint_create',
      account: selected.alias,
      project_id: projectId,
      endpoint: {id: e.id, branch_id: e.branch_id, host: e.host, type: e.type, current_state: e.current_state},
    };
  }
  const endpointId = assertId(a.endpoint_id, 'endpoint_id');
  if (action === 'delete') {
    await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`, selected.token, {method: 'DELETE'});
    return {operation: 'neon_endpoint_delete', account: selected.alias, project_id: projectId, endpoint_id: endpointId, deleted: true};
  }
  if (!['start', 'suspend', 'restart'].includes(action)) {
    throw new Error('Unsupported endpoint action (use create, start, suspend, restart, or delete)');
  }
  const data = await neonRequest(
    ctx.fetcher,
    `/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}/${action}`,
    selected.token,
    {method: 'POST'}
  );
  const e = data?.endpoint || {};
  return {
    operation: `neon_endpoint_${action}`,
    account: selected.alias,
    project_id: projectId,
    endpoint_id: endpointId,
    current_state: e.current_state ?? null,
  };
}

async function neonConnectionUriGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'neon', a.account);
  const projectId = assertId(a.project_id, 'project_id');
  const qs = new URLSearchParams({
    database_name: assertName(a.database_name, 'database_name'),
    role_name: assertName(a.role_name, 'role_name'),
  });
  if (a.branch_id) qs.set('branch_id', assertId(a.branch_id, 'branch_id'));
  if (a.pooled !== undefined) qs.set('pooled', String(Boolean(a.pooled)));
  const data = await neonRequest(ctx.fetcher, `/projects/${encodeURIComponent(projectId)}/connection_uri?${qs.toString()}`, selected.token);
  return {
    operation: 'neon_connection_uri_get',
    account: selected.alias,
    project_id: projectId,
    uri: data?.uri ?? null,
  };
}

export const neonTools = [
  tool('atax_neon_account_get', 'Inspect the authenticated Neon account user and organizations for a selected owner secret.', 'atax:neon:read', neonSchema(), neonAccountGet),
  tool('atax_neon_projects_list', 'List Neon projects accessible to a selected owner secret.', 'atax:neon:read', neonSchema({org_id: {type: 'string', maxLength: 128}, limit: {type: 'integer', minimum: 1, maximum: 100}}), neonProjectsList),
  tool('atax_neon_project_get', 'Inspect a Neon project by project_id.', 'atax:neon:read', neonSchema({project_id: {type: 'string', maxLength: 128}}, ['project_id']), neonProjectGet),
  tool('atax_neon_project_create', 'Create a new Neon project under the selected account.', 'atax:neon:write', neonSchema({name: {type: 'string', maxLength: 128}, region_id: {type: 'string', maxLength: 64}, pg_version: {type: 'integer', minimum: 14, maximum: 18}, org_id: {type: 'string', maxLength: 128}}), neonProjectCreate),
  tool('atax_neon_project_update', 'Update a Neon project (e.g. rename).', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}, name: {type: 'string', maxLength: 128}}, ['project_id']), neonProjectUpdate),
  tool('atax_neon_project_delete', 'Delete a Neon project by project_id.', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}}, ['project_id']), neonProjectDelete),
  tool('atax_neon_branches_list', 'List branches in a Neon project.', 'atax:neon:read', neonSchema({project_id: {type: 'string', maxLength: 128}}, ['project_id']), neonBranchesList),
  tool('atax_neon_branch_create', 'Create a branch in a Neon project.', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}, name: {type: 'string', maxLength: 128}, parent_id: {type: 'string', maxLength: 128}, init_source: {type: 'string', enum: ['parent-data', 'schema-only']}, endpoints: {type: 'array', maxItems: 4}}, ['project_id']), neonBranchCreate),
  tool('atax_neon_branch_delete', 'Delete a branch in a Neon project.', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}}, ['project_id', 'branch_id']), neonBranchDelete),
  tool('atax_neon_databases_list', 'List databases on a Neon branch.', 'atax:neon:read', neonSchema({project_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}}, ['project_id', 'branch_id']), neonDatabasesList),
  tool('atax_neon_database_create', 'Create a database on a Neon branch.', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}, name: {type: 'string', maxLength: 64}, owner_name: {type: 'string', maxLength: 64}}, ['project_id', 'branch_id', 'name', 'owner_name']), neonDatabaseCreate),
  tool('atax_neon_database_delete', 'Delete a database from a Neon branch.', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}, database_name: {type: 'string', maxLength: 64}}, ['project_id', 'branch_id', 'database_name']), neonDatabaseDelete),
  tool('atax_neon_roles_list', 'List Postgres roles on a Neon branch.', 'atax:neon:read', neonSchema({project_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}}, ['project_id', 'branch_id']), neonRolesList),
  tool('atax_neon_role_create', 'Create a Postgres role on a Neon branch.', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}, name: {type: 'string', maxLength: 64}}, ['project_id', 'branch_id', 'name']), neonRoleCreate),
  tool('atax_neon_role_delete', 'Delete a Postgres role from a Neon branch.', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}, role_name: {type: 'string', maxLength: 64}}, ['project_id', 'branch_id', 'role_name']), neonRoleDelete),
  tool('atax_neon_endpoints_list', 'List compute endpoints for a Neon project or branch.', 'atax:neon:read', neonSchema({project_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}}, ['project_id']), neonEndpointsList),
  tool('atax_neon_endpoint_control', 'Create, start, suspend, restart, or delete a Neon compute endpoint.', 'atax:neon:write', neonSchema({project_id: {type: 'string', maxLength: 128}, action: {type: 'string', enum: ['create', 'start', 'suspend', 'restart', 'delete']}, endpoint_id: {type: 'string', maxLength: 128}, branch_id: {type: 'string', maxLength: 128}, type: {type: 'string', enum: ['read_write', 'read_only']}, pooler_enabled: {type: 'boolean'}}, ['project_id', 'action']), neonEndpointControl),
  tool('atax_neon_connection_uri_get', 'Retrieve a Postgres connection URI for a Neon database and role.', 'atax:neon:read', neonSchema({project_id: {type: 'string', maxLength: 128}, database_name: {type: 'string', maxLength: 64}, role_name: {type: 'string', maxLength: 64}, branch_id: {type: 'string', maxLength: 128}, pooled: {type: 'boolean'}}, ['project_id', 'database_name', 'role_name']), neonConnectionUriGet),
];
