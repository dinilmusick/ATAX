import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsControlPlane, dispatchSettingsRequest } from './server/settingsControlPlane.ts';
import { createSubstrateService } from './server/supabaseSubstrate.ts';
import { inspectSupabaseConnection } from './server/supabaseVault.ts';

const rootDir = dirname(fileURLToPath(import.meta.url));

const DATA_API_ENV_KEYS = new Set([
  'ATAX_SUPABASE_URL',
  'ATAX_SUPABASE_SECRET_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
]);

function hydrateEnvFromDotEnv() {
  for (const candidate of [resolve(rootDir, '.env'), resolve(rootDir, 'supabase/.env')]) {
    if (!existsSync(candidate)) continue;
    try {
      for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (DATA_API_ENV_KEYS.has(key) && val && !process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch {
      // Ignore unreadable env file
    }
  }

  if (!process.env.ATAX_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.ATAX_SUPABASE_URL = process.env.SUPABASE_URL;
  }
  if (!process.env.ATAX_SUPABASE_SECRET_KEY) {
    process.env.ATAX_SUPABASE_SECRET_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  }
}

hydrateEnvFromDotEnv();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

async function handleSettings(req: express.Request, res: express.Response) {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol === 'https' ? 'https' : 'http';
  const url = `${protocol}://${host}${req.originalUrl}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (typeof value === 'string') headers.set(key, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length > 0;
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body) : undefined,
  });

  const controller = createSettingsControlPlane(process.env);
  try {
    const result = await dispatchSettingsRequest(request, controller);
    if (!result) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(result.status);
    result.headers?.forEach((v, k) => res.setHeader(k, v));
    res.json(result.body);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Settings request failed.' });
  }
}

app.use('/api/settings', (req, res) => {
  void handleSettings(req, res);
});

const substrateService = createSubstrateService(process.env);

async function handleSubstrate(
  res: express.Response,
  load: () => Promise<unknown>,
  fallbackMessage: string
) {
  const conn = inspectSupabaseConnection(process.env);
  if (!conn.configured) {
    res.status(503).json({ error: conn.error || 'Supabase backend is not connected.' });
    return;
  }
  try {
    res.json(await load());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : fallbackMessage });
  }
}

app.get('/api/substrate/systems', (_req, res) => {
  void handleSubstrate(res, () => substrateService.getSystemsGraph(), 'Unable to query systems from Supabase.');
});

app.get('/api/substrate/visions-goals', (_req, res) => {
  void handleSubstrate(
    res,
    () => substrateService.getVisionsGoalsGraph(),
    'Unable to query visions and goals from Supabase.'
  );
});

app.get('/api/substrate/skills', (_req, res) => {
  void handleSubstrate(
    res,
    () => substrateService.getSkillsCatalog(),
    'Unable to query skills catalog from Supabase.'
  );
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
