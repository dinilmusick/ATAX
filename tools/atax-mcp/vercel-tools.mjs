import {resolveProviderAccount} from './provider-accounts.mjs';

/**
 * Multi-account Vercel control-plane tools for ATAX MCP.
 * Provides full management of Vercel accounts, teams, projects, deployments,
 * environment variables, domains, and aliases. Tokens never leave this module.
 */

const VERCEL_API = 'https://api.vercel.com';
const ID = /^[A-Za-z0-9_.-]{1,128}$/;
const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const tool = (name, description, scope, inputSchema, invoke) => ({name, description, scope, inputSchema, invoke});
const schema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const accountArg = {
  type: 'string',
  maxLength: 48,
  description: 'Optional named Vercel account alias (VERCEL_KEY_<ALIAS>); required when multiple accounts are configured',
};
const teamArg = {
  type: 'string',
  maxLength: 128,
  description: 'Optional Vercel team ID (defaults to VERCEL_TEAM_ID_<ALIAS> if configured)',
};
const vercelSchema = (other = {}, required = []) => schema({account: accountArg, team_id: teamArg, ...other}, required);

function assertId(val, label) {
  const s = String(val || '').trim();
  if (!s || !ID.test(s)) throw new Error(`Valid ${label} is required`);
  return s;
}

function resolveTeamId(ctx, selected, requestedTeamId) {
  const configured = ctx.env['VERCEL_TEAM_ID_' + selected.alias];
  const id = requestedTeamId ? String(requestedTeamId).trim() : configured;
  if (!id) return null;
  if (!TEAM_ID.test(id)) throw new Error('Invalid Vercel team ID');
  if (configured && requestedTeamId && id !== configured) {
    throw new Error('Vercel team ID differs from configured account binding');
  }
  return id;
}

function withTeam(path, teamId, extra = {}) {
  const qs = new URLSearchParams();
  if (teamId) qs.set('teamId', teamId);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const q = qs.toString();
  return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path;
}

async function vercelRequest(fetcher, path, token, {method = 'GET', body} = {}) {
  const url = `${VERCEL_API}${path}`;
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
    if (res.ok) throw new Error('Vercel API returned invalid JSON');
  }
  if (!res.ok) {
    const msg = parsed?.error?.message || parsed?.message || `HTTP ${res.status}`;
    throw new Error(`Vercel API request failed (HTTP ${res.status}: ${String(msg).slice(0, 200)})`);
  }
  return parsed;
}

async function vercelAccountGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const userPayload = await vercelRequest(ctx.fetcher, '/v2/user', selected.token);
  const teamsPayload = await vercelRequest(ctx.fetcher, '/v2/teams?limit=50', selected.token);
  const u = userPayload?.user || userPayload || {};
  const teams = Array.isArray(teamsPayload?.teams) ? teamsPayload.teams : [];
  return {
    operation: 'vercel_account_get',
    account: selected.alias,
    configured_team_id: ctx.env['VERCEL_TEAM_ID_' + selected.alias] || null,
    user: {
      id: u.id ?? null,
      username: u.username ?? null,
      email: u.email ?? null,
      name: u.name ?? null,
      defaultTeamId: u.defaultTeamId ?? null,
    },
    teams: teams.slice(0, 50).map(t => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      createdAt: t.createdAt ?? null,
    })),
  };
}

async function vercelProjectsList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const path = withTeam('/v10/projects', teamId, {limit: a.limit ?? 20, search: a.search});
  const data = await vercelRequest(ctx.fetcher, path, selected.token);
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  return {
    operation: 'vercel_projects_list',
    account: selected.alias,
    team_id: teamId,
    projects: projects.map(pr => ({
      id: pr.id,
      name: pr.name,
      framework: pr.framework ?? null,
      nodeVersion: pr.nodeVersion ?? null,
      paused: Boolean(pr.paused),
      updatedAt: pr.updatedAt ?? null,
      link: pr.link ? {type: pr.link.type, org: pr.link.org, repo: pr.link.repo} : null,
      latest_production_url: pr.targets?.production?.url ? `https://${pr.targets.production.url}` : null,
    })),
  };
}

async function vercelProjectGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const idOrName = assertId(a.project_id_or_name, 'project_id_or_name');
  const pr = await vercelRequest(ctx.fetcher, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}`, teamId), selected.token);
  return {
    operation: 'vercel_project_get',
    account: selected.alias,
    team_id: teamId,
    project: {
      id: pr.id,
      name: pr.name,
      framework: pr.framework ?? null,
      rootDirectory: pr.rootDirectory ?? null,
      buildCommand: pr.buildCommand ?? null,
      outputDirectory: pr.outputDirectory ?? null,
      installCommand: pr.installCommand ?? null,
      nodeVersion: pr.nodeVersion ?? null,
      paused: Boolean(pr.paused),
      link: pr.link ? {type: pr.link.type, org: pr.link.org, repo: pr.link.repo, productionBranch: pr.link.productionBranch} : null,
      latest_production_url: pr.targets?.production?.url ? `https://${pr.targets.production.url}` : null,
      createdAt: pr.createdAt ?? null,
      updatedAt: pr.updatedAt ?? null,
    },
  };
}

async function vercelProjectCreate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const name = assertId(a.name, 'name').toLowerCase();
  const body = {name};
  if (a.framework !== undefined) body.framework = a.framework;
  if (a.root_directory !== undefined) body.rootDirectory = a.root_directory;
  if (a.build_command !== undefined) body.buildCommand = a.build_command;
  if (a.output_directory !== undefined) body.outputDirectory = a.output_directory;
  if (a.install_command !== undefined) body.installCommand = a.install_command;
  if (a.git_repository !== undefined) body.gitRepository = a.git_repository;
  if (a.environment_variables !== undefined) body.environmentVariables = a.environment_variables;
  const pr = await vercelRequest(ctx.fetcher, withTeam('/v11/projects', teamId), selected.token, {
    method: 'POST',
    body,
  });
  return {
    operation: 'vercel_project_create',
    account: selected.alias,
    team_id: teamId,
    project: {
      id: pr.id,
      name: pr.name,
      framework: pr.framework ?? null,
      link: pr.link ?? null,
      createdAt: pr.createdAt ?? null,
    },
  };
}

async function vercelProjectUpdate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const idOrName = assertId(a.project_id_or_name, 'project_id_or_name');
  if (a.action === 'pause' || a.action === 'unpause') {
    await vercelRequest(ctx.fetcher, withTeam(`/v1/projects/${encodeURIComponent(idOrName)}/${a.action}`, teamId), selected.token, {method: 'POST'});
    return {operation: `vercel_project_${a.action}`, account: selected.alias, team_id: teamId, project: idOrName, ok: true};
  }
  const body = {};
  if (a.name !== undefined) body.name = a.name;
  if (a.framework !== undefined) body.framework = a.framework;
  if (a.root_directory !== undefined) body.rootDirectory = a.root_directory;
  if (a.build_command !== undefined) body.buildCommand = a.build_command;
  if (a.output_directory !== undefined) body.outputDirectory = a.output_directory;
  if (a.install_command !== undefined) body.installCommand = a.install_command;
  if (a.node_version !== undefined) body.nodeVersion = a.node_version;
  if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update or action pause/unpause');
  const pr = await vercelRequest(ctx.fetcher, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}`, teamId), selected.token, {
    method: 'PATCH',
    body,
  });
  return {
    operation: 'vercel_project_update',
    account: selected.alias,
    team_id: teamId,
    project: {id: pr.id, name: pr.name, framework: pr.framework ?? null, updatedAt: pr.updatedAt ?? null},
  };
}

async function vercelProjectDelete(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const idOrName = assertId(a.project_id_or_name, 'project_id_or_name');
  await vercelRequest(ctx.fetcher, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}`, teamId), selected.token, {method: 'DELETE'});
  return {operation: 'vercel_project_delete', account: selected.alias, team_id: teamId, project: idOrName, deleted: true};
}

async function vercelDeploymentsList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const path = withTeam('/v6/deployments', teamId, {
    projectId: a.project_id,
    target: a.target,
    state: a.state,
    limit: a.limit ?? 20,
  });
  const data = await vercelRequest(ctx.fetcher, path, selected.token);
  const deployments = Array.isArray(data?.deployments) ? data.deployments : [];
  return {
    operation: 'vercel_deployments_list',
    account: selected.alias,
    team_id: teamId,
    deployments: deployments.map(d => ({
      uid: d.uid,
      name: d.name,
      url: d.url ? `https://${d.url}` : null,
      state: d.state ?? d.readyState ?? null,
      target: d.target ?? null,
      createdAt: d.createdAt ?? d.created ?? null,
      meta: d.meta ? {githubCommitRef: d.meta.githubCommitRef ?? null, githubCommitSha: d.meta.githubCommitSha ?? null} : null,
    })),
  };
}

async function vercelDeploymentGet(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const id = assertId(a.deployment_id, 'deployment_id');
  const d = await vercelRequest(ctx.fetcher, withTeam(`/v13/deployments/${encodeURIComponent(id)}`, teamId), selected.token);
  let events = null;
  if (a.include_events) {
    const rawEvents = await vercelRequest(ctx.fetcher, withTeam(`/v3/deployments/${encodeURIComponent(d.id || id)}/events`, teamId, {limit: a.event_limit ?? 80}), selected.token);
    if (Array.isArray(rawEvents)) {
      events = rawEvents.slice(-80).map(ev => ({
        type: ev.type,
        created: ev.created ?? null,
        text: ev.payload?.text ?? ev.text ?? null,
      }));
    }
  }
  return {
    operation: 'vercel_deployment_get',
    account: selected.alias,
    team_id: teamId,
    deployment: {
      id: d.id,
      name: d.name,
      url: d.url ? `https://${d.url}` : null,
      readyState: d.readyState ?? d.status ?? null,
      target: d.target ?? null,
      alias: Array.isArray(d.alias) ? d.alias : [],
      createdAt: d.createdAt ?? null,
      ready: d.ready ?? null,
      errorMessage: d.errorMessage ?? null,
    },
    ...(events !== null ? {events} : {}),
  };
}

async function vercelDeploymentCreate(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const body = {name: assertId(a.name, 'name')};
  if (a.project) body.project = a.project;
  if (a.target) body.target = a.target;
  if (a.deployment_id) body.deploymentId = assertId(a.deployment_id, 'deployment_id');
  if (a.git_source) body.gitSource = a.git_source;
  if (a.project_settings) body.projectSettings = a.project_settings;
  const d = await vercelRequest(ctx.fetcher, withTeam('/v13/deployments', teamId, a.force_new ? {forceNew: 1} : {}), selected.token, {
    method: 'POST',
    body,
  });
  return {
    operation: 'vercel_deployment_create',
    account: selected.alias,
    team_id: teamId,
    deployment: {
      id: d.id,
      name: d.name,
      url: d.url ? `https://${d.url}` : null,
      readyState: d.readyState ?? d.status ?? null,
      target: d.target ?? null,
      inspectorUrl: d.inspectorUrl ?? null,
    },
  };
}

async function vercelDeploymentControl(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const deploymentId = assertId(a.deployment_id, 'deployment_id');
  if (a.action === 'cancel') {
    const d = await vercelRequest(ctx.fetcher, withTeam(`/v12/deployments/${encodeURIComponent(deploymentId)}/cancel`, teamId), selected.token, {method: 'PATCH'});
    return {operation: 'vercel_deployment_cancel', account: selected.alias, team_id: teamId, deployment_id: deploymentId, state: d?.status ?? d?.readyState ?? 'CANCELED'};
  }
  if (a.action === 'delete') {
    await vercelRequest(ctx.fetcher, withTeam(`/v13/deployments/${encodeURIComponent(deploymentId)}`, teamId), selected.token, {method: 'DELETE'});
    return {operation: 'vercel_deployment_delete', account: selected.alias, team_id: teamId, deployment_id: deploymentId, deleted: true};
  }
  if (a.action === 'promote') {
    const projectId = assertId(a.project_id, 'project_id');
    await vercelRequest(ctx.fetcher, withTeam(`/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`, teamId), selected.token, {method: 'POST'});
    return {operation: 'vercel_deployment_promote', account: selected.alias, team_id: teamId, project_id: projectId, deployment_id: deploymentId, promoted: true};
  }
  throw new Error('Unsupported deployment action (use cancel, delete, or promote)');
}

async function vercelEnvList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const idOrName = assertId(a.project_id_or_name, 'project_id_or_name');
  const data = await vercelRequest(ctx.fetcher, withTeam(`/v10/projects/${encodeURIComponent(idOrName)}/env`, teamId), selected.token);
  const envs = Array.isArray(data?.envs) ? data.envs : [];
  return {
    operation: 'vercel_env_list',
    account: selected.alias,
    team_id: teamId,
    project: idOrName,
    envs: envs.slice(0, 100).map(e => ({
      id: e.id,
      key: e.key,
      type: e.type,
      target: e.target,
      gitBranch: e.gitBranch ?? null,
      updatedAt: e.updatedAt ?? null,
    })),
  };
}

async function vercelEnvUpsert(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const idOrName = assertId(a.project_id_or_name, 'project_id_or_name');
  const body = {
    key: String(a.key || '').trim(),
    value: String(a.value ?? ''),
    type: a.type || 'encrypted',
    target: Array.isArray(a.target) && a.target.length > 0 ? a.target : ['production', 'preview', 'development'],
    ...(a.git_branch ? {gitBranch: a.git_branch} : {}),
  };
  if (!body.key) throw new Error('Environment variable key is required');
  if (a.env_id) {
    const envId = assertId(a.env_id, 'env_id');
    const updated = await vercelRequest(ctx.fetcher, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}/env/${encodeURIComponent(envId)}`, teamId), selected.token, {
      method: 'PATCH',
      body,
    });
    return {operation: 'vercel_env_update', account: selected.alias, team_id: teamId, project: idOrName, id: updated.id, key: updated.key, target: updated.target};
  }
  const created = await vercelRequest(ctx.fetcher, withTeam(`/v10/projects/${encodeURIComponent(idOrName)}/env`, teamId, {upsert: 'true'}), selected.token, {
    method: 'POST',
    body,
  });
  const entry = Array.isArray(created?.created) ? created.created[0] : created;
  return {operation: 'vercel_env_upsert', account: selected.alias, team_id: teamId, project: idOrName, id: entry?.id ?? null, key: body.key, target: body.target};
}

async function vercelEnvDelete(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  const idOrName = assertId(a.project_id_or_name, 'project_id_or_name');
  const envId = assertId(a.env_id, 'env_id');
  await vercelRequest(ctx.fetcher, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}/env/${encodeURIComponent(envId)}`, teamId), selected.token, {method: 'DELETE'});
  return {operation: 'vercel_env_delete', account: selected.alias, team_id: teamId, project: idOrName, env_id: envId, deleted: true};
}

async function vercelDomainsList(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  if (a.project_id_or_name) {
    const idOrName = assertId(a.project_id_or_name, 'project_id_or_name');
    const data = await vercelRequest(ctx.fetcher, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}/domains`, teamId, {limit: a.limit ?? 50}), selected.token);
    const domains = Array.isArray(data?.domains) ? data.domains : [];
    return {
      operation: 'vercel_project_domains_list',
      account: selected.alias,
      team_id: teamId,
      project: idOrName,
      domains: domains.map(d => ({name: d.name, apexName: d.apexName ?? null, verified: Boolean(d.verified), gitBranch: d.gitBranch ?? null})),
    };
  }
  const data = await vercelRequest(ctx.fetcher, withTeam('/v5/domains', teamId, {limit: a.limit ?? 50}), selected.token);
  const domains = Array.isArray(data?.domains) ? data.domains : [];
  return {
    operation: 'vercel_domains_list',
    account: selected.alias,
    team_id: teamId,
    domains: domains.map(d => ({id: d.id, name: d.name, verified: Boolean(d.verified), createdAt: d.createdAt ?? null})),
  };
}

async function vercelDomainManage(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'vercel', a.account);
  const teamId = resolveTeamId(ctx, selected, a.team_id);
  if (a.action === 'alias') {
    const deploymentId = assertId(a.deployment_id, 'deployment_id');
    const aliasName = String(a.domain || '').trim();
    if (!aliasName) throw new Error('Domain/alias hostname is required');
    const res = await vercelRequest(ctx.fetcher, withTeam(`/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, teamId), selected.token, {
      method: 'POST',
      body: {alias: aliasName},
    });
    return {operation: 'vercel_deployment_alias', account: selected.alias, team_id: teamId, deployment_id: deploymentId, alias: res.alias ?? aliasName, uid: res.uid ?? null};
  }
  const idOrName = assertId(a.project_id_or_name, 'project_id_or_name');
  const domain = String(a.domain || '').trim();
  if (!domain) throw new Error('domain is required');
  if (a.action === 'add') {
    const res = await vercelRequest(ctx.fetcher, withTeam(`/v10/projects/${encodeURIComponent(idOrName)}/domains`, teamId), selected.token, {
      method: 'POST',
      body: {name: domain, ...(a.git_branch ? {gitBranch: a.git_branch} : {})},
    });
    return {operation: 'vercel_domain_add', account: selected.alias, team_id: teamId, project: idOrName, name: res.name, verified: Boolean(res.verified)};
  }
  if (a.action === 'verify') {
    const res = await vercelRequest(ctx.fetcher, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domain)}/verify`, teamId), selected.token, {method: 'POST'});
    return {operation: 'vercel_domain_verify', account: selected.alias, team_id: teamId, project: idOrName, name: res.name, verified: Boolean(res.verified)};
  }
  if (a.action === 'remove') {
    await vercelRequest(ctx.fetcher, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domain)}`, teamId), selected.token, {method: 'DELETE'});
    return {operation: 'vercel_domain_remove', account: selected.alias, team_id: teamId, project: idOrName, domain, removed: true};
  }
  throw new Error('Unsupported domain action (use add, verify, remove, or alias)');
}

export const vercelTools = [
  tool('atax_vercel_account_get', 'Inspect the authenticated Vercel user and accessible teams for a selected owner secret.', 'atax:vercel:read', vercelSchema(), vercelAccountGet),
  tool('atax_vercel_projects_list', 'List Vercel projects for the selected account or team.', 'atax:vercel:read', vercelSchema({search: {type: 'string', maxLength: 120}, limit: {type: 'integer', minimum: 1, maximum: 100}}), vercelProjectsList),
  tool('atax_vercel_project_get', 'Inspect a Vercel project by ID or name.', 'atax:vercel:read', vercelSchema({project_id_or_name: {type: 'string', maxLength: 128}}, ['project_id_or_name']), vercelProjectGet),
  tool('atax_vercel_project_create', 'Create a new Vercel project under the selected account or team.', 'atax:vercel:write', vercelSchema({name: {type: 'string', maxLength: 128}, framework: {type: 'string', maxLength: 64}, root_directory: {type: 'string', maxLength: 256}, build_command: {type: 'string', maxLength: 256}, output_directory: {type: 'string', maxLength: 256}, install_command: {type: 'string', maxLength: 256}, git_repository: {type: 'object'}, environment_variables: {type: 'array', maxItems: 50}}, ['name']), vercelProjectCreate),
  tool('atax_vercel_project_update', 'Update Vercel project settings or pause/unpause a project.', 'atax:vercel:write', vercelSchema({project_id_or_name: {type: 'string', maxLength: 128}, action: {type: 'string', enum: ['pause', 'unpause']}, name: {type: 'string', maxLength: 128}, framework: {type: 'string', maxLength: 64}, root_directory: {type: 'string', maxLength: 256}, build_command: {type: 'string', maxLength: 256}, output_directory: {type: 'string', maxLength: 256}, install_command: {type: 'string', maxLength: 256}, node_version: {type: 'string', maxLength: 32}}, ['project_id_or_name']), vercelProjectUpdate),
  tool('atax_vercel_project_delete', 'Delete a Vercel project by ID or name.', 'atax:vercel:write', vercelSchema({project_id_or_name: {type: 'string', maxLength: 128}}, ['project_id_or_name']), vercelProjectDelete),
  tool('atax_vercel_deployments_list', 'List Vercel deployments for an account, team, or project.', 'atax:vercel:read', vercelSchema({project_id: {type: 'string', maxLength: 128}, target: {type: 'string', maxLength: 64}, state: {type: 'string', maxLength: 64}, limit: {type: 'integer', minimum: 1, maximum: 100}}), vercelDeploymentsList),
  tool('atax_vercel_deployment_get', 'Inspect a Vercel deployment and optionally its bounded build/runtime events.', 'atax:vercel:read', vercelSchema({deployment_id: {type: 'string', maxLength: 128}, include_events: {type: 'boolean'}, event_limit: {type: 'integer', minimum: 1, maximum: 200}}, ['deployment_id']), vercelDeploymentGet),
  tool('atax_vercel_deployment_create', 'Create or redeploy a Vercel deployment.', 'atax:vercel:write', vercelSchema({name: {type: 'string', maxLength: 128}, project: {type: 'string', maxLength: 128}, target: {type: 'string', maxLength: 64}, deployment_id: {type: 'string', maxLength: 128}, git_source: {type: 'object'}, project_settings: {type: 'object'}, force_new: {type: 'boolean'}}, ['name']), vercelDeploymentCreate),
  tool('atax_vercel_deployment_control', 'Cancel, delete, or promote a Vercel deployment.', 'atax:vercel:write', vercelSchema({deployment_id: {type: 'string', maxLength: 128}, action: {type: 'string', enum: ['cancel', 'delete', 'promote']}, project_id: {type: 'string', maxLength: 128}}, ['deployment_id', 'action']), vercelDeploymentControl),
  tool('atax_vercel_env_list', 'List environment variable metadata (never raw secret values) for a Vercel project.', 'atax:vercel:read', vercelSchema({project_id_or_name: {type: 'string', maxLength: 128}}, ['project_id_or_name']), vercelEnvList),
  tool('atax_vercel_env_upsert', 'Create or update a Vercel project environment variable.', 'atax:vercel:write', vercelSchema({project_id_or_name: {type: 'string', maxLength: 128}, key: {type: 'string', maxLength: 256}, value: {type: 'string', maxLength: 8192}, type: {type: 'string', enum: ['plain', 'encrypted', 'secret', 'sensitive']}, target: {type: 'array', items: {type: 'string', maxLength: 32}, maxItems: 5}, git_branch: {type: 'string', maxLength: 128}, env_id: {type: 'string', maxLength: 128}}, ['project_id_or_name', 'key', 'value']), vercelEnvUpsert),
  tool('atax_vercel_env_delete', 'Delete a Vercel project environment variable.', 'atax:vercel:write', vercelSchema({project_id_or_name: {type: 'string', maxLength: 128}, env_id: {type: 'string', maxLength: 128}}, ['project_id_or_name', 'env_id']), vercelEnvDelete),
  tool('atax_vercel_domains_list', 'List Vercel account/team domains or domains attached to a project.', 'atax:vercel:read', vercelSchema({project_id_or_name: {type: 'string', maxLength: 128}, limit: {type: 'integer', minimum: 1, maximum: 100}}), vercelDomainsList),
  tool('atax_vercel_domain_manage', 'Add, verify, or remove a Vercel project domain, or assign a deployment alias.', 'atax:vercel:write', vercelSchema({action: {type: 'string', enum: ['add', 'verify', 'remove', 'alias']}, domain: {type: 'string', maxLength: 253}, project_id_or_name: {type: 'string', maxLength: 128}, deployment_id: {type: 'string', maxLength: 128}, git_branch: {type: 'string', maxLength: 128}}, ['action', 'domain']), vercelDomainManage),
];
