import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperatorAuthStore, isSameOriginRequest } from './server/operatorAuth.ts';
import { createSubstrateService } from './server/supabaseSubstrate.ts';
import { VaultError, createVaultService, inspectSupabaseConnection } from './server/supabaseVault.ts';

const rootDir = dirname(fileURLToPath(import.meta.url));

// Load optional .env file for ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY if not already set
function hydrateEnvFromDotEnv() {
  if (process.env.ATAX_SUPABASE_URL && process.env.ATAX_SUPABASE_SECRET_KEY) return;
  const envPath = resolve(rootDir, '.env');
  if (!existsSync(envPath)) return;
  try {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1).trim();
        }
        if (
          (key === 'ATAX_SUPABASE_URL' || key === 'ATAX_SUPABASE_SECRET_KEY') &&
          val &&
          !process.env[key]
        ) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // Ignore unreadable .env
  }
}

hydrateEnvFromDotEnv();

const authStore = new OperatorAuthStore();
const vaultService = createVaultService(process.env);
const substrateService = createSubstrateService(process.env);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

function requireOperator(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!isSameOriginRequest(req.headers)) {
      res.status(403).json({ error: 'Cross-origin mutation rejected.' });
      return;
    }
  }
  const claims = authStore.verifyBearer(req.headers.authorization);
  if (!claims) {
    res.status(401).json({ error: 'Operator authentication required.' });
    return;
  }
  res.locals.operatorSubject = claims.sub;
  next();
}

app.get('/api/settings/status', (req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  const claims = authStore.verifyBearer(req.headers.authorization);
  res.json({
    supabaseConfigured: conn.configured,
    supabaseHost: conn.hostLabel,
    supabaseError: conn.error,
    operatorClaimed: authStore.isClaimed(),
    authenticated: claims !== null,
    operatorSubject: claims ? claims.sub : authStore.getClaimedSubject(),
    requiredEnvVars: ['ATAX_SUPABASE_URL', 'ATAX_SUPABASE_SECRET_KEY'],
  });
});

app.post('/api/settings/auth/setup', (req, res) => {
  if (!isSameOriginRequest(req.headers)) {
    res.status(403).json({ error: 'Cross-origin request rejected.' });
    return;
  }
  const body = (req.body || {}) as { subject?: unknown; passphrase?: unknown };
  const result = authStore.claim(
    typeof body.subject === 'string' ? body.subject : 'atax-operator',
    typeof body.passphrase === 'string' ? body.passphrase : ''
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json({
    token: result.token,
    expiresAt: result.expiresAt,
    subject: result.subject,
  });
});

app.post('/api/settings/auth/login', (req, res) => {
  if (!isSameOriginRequest(req.headers)) {
    res.status(403).json({ error: 'Cross-origin request rejected.' });
    return;
  }
  const body = (req.body || {}) as { passphrase?: unknown };
  const result = authStore.login(typeof body.passphrase === 'string' ? body.passphrase : '');
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({
    token: result.token,
    expiresAt: result.expiresAt,
    subject: result.subject,
  });
});

app.post('/api/settings/auth/logout', (req, res) => {
  authStore.revokeBearer(req.headers.authorization);
  res.json({ ok: true });
});

app.get('/api/settings/providers', requireOperator, async (_req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.json({ accounts: [], supabaseConfigured: false });
    return;
  }
  try {
    const ownerSubject = String(res.locals.operatorSubject || 'atax-operator');
    const accounts = await vaultService.listAccounts(ownerSubject);
    res.json({ accounts, supabaseConfigured: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to query Supabase Vault.';
    res.status(502).json({ error: message });
  }
});

app.post('/api/settings/providers', requireOperator, async (req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.status(503).json({
      error:
        conn.error ||
        'Supabase backend is not connected. Configure ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY in your environment to save secrets to Supabase Vault.',
    });
    return;
  }

  const body = (req.body || {}) as {
    provider?: string;
    alias?: string;
    credential?: string;
    accountId?: string | null;
    enabled?: boolean;
  };
  const actorSubject = String(res.locals.operatorSubject || 'atax-operator');

  try {
    const saved = await vaultService.upsertSecret({
      ownerSubject: actorSubject,
      provider: body.provider || '',
      alias: body.alias || '',
      credential: body.credential || '',
      actorSubject,
      accountId: body.accountId ?? null,
      enabled: body.enabled !== false,
    });
    res.status(201).json({ account: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to store secret in Supabase Vault.';
    const status =
      err instanceof VaultError
        ? err.statusCode
        : message.includes('must ') || message.includes('Unsupported')
        ? 400
        : 502;
    res.status(status).json({ error: message });
  }
});

app.patch('/api/settings/providers/:provider/:alias/enabled', requireOperator, async (req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.status(503).json({
      error:
        conn.error ||
        'Supabase backend is not connected. Configure ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY in your environment.',
    });
    return;
  }
  const body = (req.body || {}) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: 'Boolean enabled field is required.' });
    return;
  }
  const actorSubject = String(res.locals.operatorSubject || 'atax-operator');
  try {
    await vaultService.setAccountEnabled(
      actorSubject,
      String(req.params.provider || ''),
      String(req.params.alias || ''),
      body.enabled,
      actorSubject
    );
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update provider state.';
    const status = err instanceof VaultError ? err.statusCode : 400;
    res.status(status).json({ error: message });
  }
});

app.delete('/api/settings/providers/:provider/:alias', requireOperator, async (req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.status(503).json({
      error:
        conn.error ||
        'Supabase backend is not connected. Configure ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY in your environment.',
    });
    return;
  }
  const actorSubject = String(res.locals.operatorSubject || 'atax-operator');
  try {
    await vaultService.deleteAccount(
      actorSubject,
      String(req.params.provider || ''),
      String(req.params.alias || ''),
      actorSubject
    );
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete provider secret.';
    const status = err instanceof VaultError ? err.statusCode : 400;
    res.status(status).json({ error: message });
  }
});

app.post('/api/settings/providers/:provider/:alias/test', requireOperator, async (req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.status(503).json({
      error:
        conn.error ||
        'Supabase backend is not connected. Configure ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY in your environment.',
    });
    return;
  }
  const actorSubject = String(res.locals.operatorSubject || 'atax-operator');
  try {
    const result = await vaultService.testAccountConnection(
      actorSubject,
      String(req.params.provider || ''),
      String(req.params.alias || '')
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection verification failed.';
    const status = err instanceof VaultError ? err.statusCode : 400;
    res.status(status).json({ error: message });
  }
});

app.get('/api/substrate/systems', async (_req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.status(503).json({
      error:
        conn.error ||
        'Supabase ledger is not connected. Configure ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY in your environment.',
    });
    return;
  }
  try {
    const data = await substrateService.getSystemsGraph();
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to query systems from Supabase.';
    res.status(502).json({ error: message });
  }
});

app.get('/api/substrate/visions-goals', async (_req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.status(503).json({
      error:
        conn.error ||
        'Supabase ledger is not connected. Configure ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY in your environment.',
    });
    return;
  }
  try {
    const data = await substrateService.getVisionsGoalsGraph();
    res.json(data);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unable to query visions and goals from Supabase.';
    res.status(502).json({ error: message });
  }
});

app.get('/api/substrate/skills', async (_req, res) => {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.status(503).json({
      error:
        conn.error ||
        'Supabase ledger is not connected. Configure ATAX_SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY in your environment.',
    });
    return;
  }
  try {
    const data = await substrateService.getSkillsCatalog();
    res.json(data);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unable to query skills catalog from Supabase.';
    res.status(502).json({ error: message });
  }
});

const PORT = 3000;

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    const distDir = resolve(rootDir, 'dist');
    app.use(express.static(distDir));
    app.use((_req, res) => {
      res.sendFile(resolve(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ATAX Substrate server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
