/**
 * OAuth 2.1 Consent UI and server-side Supabase Auth proxy for `/oauth/consent`
 * and `/api/oauth/consent`. Allows MCP clients (Claude, Gemini) using Supabase's
 * OAuth 2.1 server to authenticate users via Google and obtain authorization codes
 * without exposing any Supabase secret keys in the browser.
 */

const AUTH_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;

function resolveSupabaseConfig(env: Record<string, unknown>) {
  const url = String(env.ATAX_SUPABASE_URL || env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const secretKey = String(
    env.ATAX_SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || ''
  ).trim();
  return { url, secretKey };
}

export function renderConsentPage(env: Record<string, unknown>): Response {
  const { url: supabaseUrl } = resolveSupabaseConfig(env);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ATAX — Authorize MCP Client</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b0d12; color: #e6e9ef;
    }
    .card {
      width: 100%; max-width: 440px; padding: 28px; border-radius: 14px;
      background: #141821; border: 1px solid #262c3a; box-shadow: 0 20px 50px rgba(0,0,0,0.45);
    }
    h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
    p { margin: 0 0 18px; font-size: 14px; line-height: 1.5; color: #9aa4b8; }
    .meta {
      padding: 14px; border-radius: 10px; background: #0e1118; border: 1px solid #222836;
      margin-bottom: 20px; font-size: 13px;
    }
    .meta div { margin-bottom: 6px; word-break: break-all; }
    .meta div:last-child { margin-bottom: 0; }
    .label { color: #7e889b; display: inline-block; min-width: 90px; }
    .actions { display: flex; gap: 10px; }
    button {
      flex: 1; padding: 11px 16px; border-radius: 9px; border: 1px solid transparent;
      font-size: 14px; font-weight: 600; cursor: pointer;
    }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .primary { background: #3b82f6; color: #fff; }
    .primary:hover:not(:disabled) { background: #2563eb; }
    .secondary { background: #1e2430; color: #d6dce8; border-color: #2f3749; }
    .secondary:hover:not(:disabled) { background: #272f3f; }
    .link-btn {
      background: none; border: none; color: #7e889b; font-size: 12px;
      padding: 10px 0 0; cursor: pointer; text-decoration: underline; width: 100%;
    }
    .error {
      padding: 12px; border-radius: 9px; background: rgba(239,68,68,0.12);
      border: 1px solid rgba(239,68,68,0.35); color: #fca5a5; font-size: 13px; margin-bottom: 16px;
    }
    .hidden { display: none; }
  </style>
</head>
<body>
  <main class="card">
    <h1>ATAX OAuth Authorization</h1>
    <p id="subtitle">Checking authorization request…</p>
    <div id="errorBox" class="error hidden"></div>
    <div id="loginView" class="hidden">
      <p>Sign in with your Google account to review and authorize this MCP client.</p>
      <div class="actions">
        <button id="googleBtn" class="primary" type="button">Continue with Google</button>
      </div>
    </div>
    <div id="consentView" class="hidden">
      <div class="meta">
        <div><span class="label">Client:</span> <strong id="clientName">MCP Client</strong></div>
        <div><span class="label">Scopes:</span> <span id="clientScopes">openid profile email</span></div>
        <div><span class="label">Redirect:</span> <span id="clientRedirect">—</span></div>
      </div>
      <div class="actions">
        <button id="denyBtn" class="secondary" type="button">Deny</button>
        <button id="approveBtn" class="primary" type="button">Authorize</button>
      </div>
      <button id="switchBtn" class="link-btn" type="button">Use a different Google account</button>
    </div>
  </main>
  <script>
    const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
    const AUTH_ID_KEY = 'atax_oauth_authorization_id';
    const TOKEN_KEY = 'atax_oauth_access_token';
    const $ = id => document.getElementById(id);

    function showError(msg) {
      $('errorBox').textContent = msg;
      $('errorBox').classList.remove('hidden');
    }

    function readAuthId() {
      const q = new URLSearchParams(window.location.search).get('authorization_id');
      if (q) { sessionStorage.setItem(AUTH_ID_KEY, q); return q; }
      return sessionStorage.getItem(AUTH_ID_KEY) || '';
    }

    function readToken() {
      const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
      if (hash) {
        const hp = new URLSearchParams(hash);
        const err = hp.get('error_description') || hp.get('error');
        if (err) showError(err);
        const tok = hp.get('access_token');
        if (tok) {
          sessionStorage.setItem(TOKEN_KEY, tok);
          const cleanUrl = window.location.pathname + window.location.search;
          history.replaceState(null, '', cleanUrl);
          return tok;
        }
      }
      const qp = new URLSearchParams(window.location.search);
      const qErr = qp.get('error_description') || qp.get('error');
      if (qErr) showError(qErr);
      return sessionStorage.getItem(TOKEN_KEY) || '';
    }

    async function callConsent(action, authId, token) {
      const res = await fetch('/api/oauth/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ action, authorization_id: authId })
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    }

    function startGoogleLogin() {
      if (!SUPABASE_URL) { showError('Supabase URL is not configured on this server.'); return; }
      const redirectTo = window.location.origin + '/oauth/consent';
      window.location.href = SUPABASE_URL + '/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(redirectTo);
    }

    async function init() {
      const authId = readAuthId();
      if (!authId) {
        $('subtitle').textContent = 'Missing authorization_id in URL.';
        showError('Start the connection from Claude or Gemini Connectors so Supabase provides an authorization_id.');
        return;
      }
      const token = readToken();
      if (!token) {
        $('subtitle').textContent = 'Sign in required to authorize access to ATAX.';
        $('loginView').classList.remove('hidden');
        $('googleBtn').onclick = startGoogleLogin;
        return;
      }

      $('subtitle').textContent = 'Loading client details…';
      const { ok, status, data } = await callConsent('details', authId, token);
      if (!ok) {
        if (status === 401 || status === 403) {
          sessionStorage.removeItem(TOKEN_KEY);
          $('subtitle').textContent = 'Session expired. Please sign in again.';
          $('loginView').classList.remove('hidden');
          $('googleBtn').onclick = startGoogleLogin;
          return;
        }
        $('subtitle').textContent = 'Could not load authorization request.';
        showError(data.msg || data.error_description || data.error || ('Request failed (' + status + ')'));
        return;
      }

      if (data.redirect_url) {
        $('subtitle').textContent = 'Already authorized. Redirecting back…';
        sessionStorage.removeItem(AUTH_ID_KEY);
        window.location.href = data.redirect_url;
        return;
      }

      $('subtitle').textContent = 'Review the application requesting access to your ATAX server.';
      $('clientName').textContent = (data.client && data.client.name) || data.client_name || 'MCP Client';
      $('clientScopes').textContent = data.scope || (Array.isArray(data.scopes) ? data.scopes.join(' ') : 'openid profile email');
      $('clientRedirect').textContent = data.redirect_uri || '—';
      $('consentView').classList.remove('hidden');

      async function decide(action) {
        $('approveBtn').disabled = true;
        $('denyBtn').disabled = true;
        const r = await callConsent(action, authId, token);
        if (r.ok && r.data && r.data.redirect_url) {
          sessionStorage.removeItem(AUTH_ID_KEY);
          window.location.href = r.data.redirect_url;
          return;
        }
        $('approveBtn').disabled = false;
        $('denyBtn').disabled = false;
        showError((r.data && (r.data.msg || r.data.error_description || r.data.error)) || 'Failed to submit decision.');
      }

      $('approveBtn').onclick = () => decide('approve');
      $('denyBtn').onclick = () => decide('deny');
      $('switchBtn').onclick = () => {
        sessionStorage.removeItem(TOKEN_KEY);
        startGoogleLogin();
      };
    }

    init();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function handleConsentApi(
  request: Request,
  env: Record<string, unknown>,
  fetcher: typeof fetch = fetch
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (request.method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed' } };
  }

  const { url: supabaseUrl, secretKey } = resolveSupabaseConfig(env);
  if (!supabaseUrl || !secretKey) {
    return { status: 503, body: { error: 'Supabase backend unavailable.' } };
  }

  const authHeader = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!match) {
    return { status: 401, body: { error: 'Missing bearer token' } };
  }
  const userToken = match[1];

  let payload: { action?: unknown; authorization_id?: unknown };
  try {
    payload = (await request.json()) as { action?: unknown; authorization_id?: unknown };
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body' } };
  }

  const action = String(payload.action || '');
  const authorizationId = String(payload.authorization_id || '');
  if (!['details', 'approve', 'deny'].includes(action)) {
    return { status: 400, body: { error: 'Unsupported action' } };
  }
  if (!AUTH_ID_RE.test(authorizationId)) {
    return { status: 400, body: { error: 'Invalid authorization_id' } };
  }

  const headers: Record<string, string> = {
    apikey: secretKey,
    Authorization: `Bearer ${userToken}`,
    Accept: 'application/json',
  };

  const endpoint =
    action === 'details'
      ? `${supabaseUrl}/auth/v1/oauth/authorizations/${authorizationId}`
      : `${supabaseUrl}/auth/v1/oauth/authorizations/${authorizationId}/consent`;

  const upstream = await fetcher(endpoint, {
    method: action === 'details' ? 'GET' : 'POST',
    headers: action === 'details' ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: action === 'details' ? undefined : JSON.stringify({ action }),
  });

  const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: upstream.status, body };
}
