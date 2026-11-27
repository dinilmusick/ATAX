import {resolveProviderAccount} from './provider-accounts.mjs';

/**
 * Browser-environment testing & rendering tools for ATAX MCP.
 * - atax_browser_render: Loads an HTTPS URL into Cloudflare Browser Rendering (headless Chromium)
 *   to inspect rendered DOM, markdown, links, or CSS-selected elements.
 * - atax_browser_test_dispatch: Dispatches a Playwright headless Chromium probe workflow
 *   (.github/workflows/browser-probe.yml) to verify console errors, network failures, selectors,
 *   and text assertions, with results readable via atax_github_job_logs_get.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const GH_API = 'https://api.github.com';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FULL_NAME = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const tool = (name, description, scope, inputSchema, invoke) => ({name, description, scope, inputSchema, invoke});
const schema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});

function assertPublicHttpsUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('Valid HTTPS URL is required');
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) {
    throw new Error('Only public HTTPS URLs without embedded credentials are permitted');
  }
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
    host === '[::1]'
  ) {
    throw new Error('Private or loopback hostnames are not permitted');
  }
  return u.toString();
}

async function resolveCloudflareAccountId(ctx, selected, requestedAccountId) {
  const configured = ctx.env['CLOUDFLARE_ACCOUNT_ID_' + selected.alias];
  const id = requestedAccountId || configured;
  if (id) {
    if (!ID.test(id)) throw new Error('Invalid Cloudflare account ID');
    if (configured && requestedAccountId && id !== configured) {
      throw new Error('Cloudflare account ID differs from configured account binding');
    }
    return id;
  }
  const res = await ctx.fetcher(`${CF_API}/accounts?page=1&per_page=5`, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${selected.token}`,
      accept: 'application/json',
      'user-agent': 'atax-mcp-control-plane',
    },
  });
  if (!res.ok) throw new Error(`Cloudflare account discovery failed (HTTP ${res.status})`);
  const payload = await res.json();
  if (payload?.success !== true || !Array.isArray(payload.result) || payload.result.length === 0) {
    throw new Error('Cloudflare account ID required; pass account_id or configure CLOUDFLARE_ACCOUNT_ID_<ALIAS>');
  }
  return payload.result[0].id;
}

async function browserRender(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'cloudflare', a.account);
  const accountId = await resolveCloudflareAccountId(ctx, selected, a.account_id);
  const targetUrl = assertPublicHttpsUrl(a.url);
  const mode = a.mode || 'content';
  const endpoint = `${CF_API}/accounts/${encodeURIComponent(accountId)}/browser-rendering/${mode}`;
  const body = {url: targetUrl};
  if (a.wait_for_selector) {
    body.waitForSelector = {selector: String(a.wait_for_selector)};
  }
  if (mode === 'scrape') {
    const selectors = Array.isArray(a.selectors) && a.selectors.length > 0 ? a.selectors : ['title', 'h1', 'body'];
    body.elements = selectors.map(sel => ({selector: String(sel)}));
  }
  const res = await ctx.fetcher(endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${selected.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'atax-mcp-control-plane',
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`Cloudflare Browser Rendering returned invalid JSON (HTTP ${res.status})`);
  }
  if (!res.ok || payload?.success === false) {
    const msg = payload?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`Cloudflare Browser Rendering failed (HTTP ${res.status}: ${String(msg).slice(0, 200)})`);
  }
  let result = payload?.result ?? payload;
  if (typeof result === 'string' && result.length > 24576) {
    result = result.slice(0, 24576) + '\n...[TRUNCATED]';
  } else if (Array.isArray(result)) {
    result = result.slice(0, 100);
  }
  return {
    operation: 'browser_render',
    account: selected.alias,
    cloudflare_account_id: accountId,
    url: targetUrl,
    mode,
    result,
  };
}

async function browserTestDispatch(a, _db, p, ctx) {
  const selected = resolveProviderAccount(ctx.env, p, 'github', a.account);
  const targetUrl = assertPublicHttpsUrl(a.target_url);
  const owner = String(ctx.env.MCP_GITHUB_OWNER || 'dinilmusick').trim();
  const repo = a.repository ? String(a.repository).trim() : `${owner}/ATAX`;
  if (!FULL_NAME.test(repo)) throw new Error('Invalid GitHub owner/name repository');
  const ref = String(a.ref || 'main').trim();
  const requestId = crypto.randomUUID();
  const inputs = {
    target_url: targetUrl,
    wait_for_selector: a.wait_for_selector ? String(a.wait_for_selector) : '',
    assert_text: a.assert_text ? String(a.assert_text) : '',
    check_console_errors: String(a.check_console_errors !== false),
    viewport: a.viewport ? String(a.viewport) : '1280x720',
    request_id: requestId,
  };
  const url = `${GH_API}/repos/${repo}/actions/workflows/browser-probe.yml/dispatches`;
  const res = await ctx.fetcher(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'atax-mcp-control-plane',
      authorization: `Bearer ${selected.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ref, inputs}),
  });
  if (!res.ok) {
    let msg = '';
    try {
      const err = await res.json();
      if (err?.message) msg = `: ${err.message}`;
    } catch {}
    throw new Error(`Browser probe dispatch failed (HTTP ${res.status}${msg})`);
  }
  return {
    operation: 'browser_test_dispatch',
    request_id: requestId,
    account: selected.alias,
    repository: repo,
    workflow: 'browser-probe.yml',
    ref,
    target_url: targetUrl,
    status: 'dispatched',
    next_step: 'Poll atax_github_workflow_runs with workflow="browser-probe.yml" and inspect step logs with atax_github_job_logs_get.',
  };
}

export const browserTools = [
  tool(
    'atax_browser_render',
    'Load a public HTTPS URL into a headless Chromium browser via Cloudflare Browser Rendering to inspect rendered DOM HTML, markdown, links, or CSS-selected elements.',
    'atax:cloudflare:read',
    schema(
      {
        account: {type: 'string', maxLength: 48, description: 'Optional named Cloudflare account alias (CF_KEY_<ALIAS>)'},
        account_id: {type: 'string', maxLength: 128, description: 'Optional Cloudflare account ID'},
        url: {type: 'string', minLength: 10, maxLength: 2048, description: 'Public HTTPS URL to load in headless Chromium'},
        mode: {type: 'string', enum: ['content', 'markdown', 'links', 'scrape'], description: 'Extraction mode (default content)'},
        wait_for_selector: {type: 'string', maxLength: 256, description: 'Optional CSS selector to wait for before extracting'},
        selectors: {type: 'array', items: {type: 'string', maxLength: 256}, maxItems: 20, description: 'CSS selectors when mode=scrape'},
      },
      ['url']
    ),
    browserRender
  ),
  tool(
    'atax_browser_test_dispatch',
    'Dispatch a Playwright headless Chromium test run (.github/workflows/browser-probe.yml) against a public HTTPS URL to verify page load, console/page errors, failed network requests, selectors, and text assertions.',
    'atax:github:create',
    schema(
      {
        account: {type: 'string', maxLength: 48, description: 'Optional named GitHub account alias (GH_KEY_<ALIAS>)'},
        repository: {type: 'string', maxLength: 205, description: 'Optional GitHub owner/name repository (defaults to controller repo)'},
        ref: {type: 'string', maxLength: 120, description: 'Git branch or ref containing browser-probe.yml (default main)'},
        target_url: {type: 'string', minLength: 10, maxLength: 2048, description: 'Public HTTPS URL to load and test in Playwright Chromium'},
        wait_for_selector: {type: 'string', maxLength: 256, description: 'Optional CSS selector to assert visible'},
        assert_text: {type: 'string', maxLength: 500, description: 'Optional text substring expected in rendered page body'},
        check_console_errors: {type: 'boolean', description: 'Fail if uncaught pageerror or console.error occurs (default true)'},
        viewport: {type: 'string', maxLength: 32, description: 'Viewport WxH (default 1280x720)'},
      },
      ['target_url']
    ),
    browserTestDispatch
  ),
];
