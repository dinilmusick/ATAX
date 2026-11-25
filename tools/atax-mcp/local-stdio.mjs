#!/usr/bin/env node
/**
 * ATAX Local MCP Stdio Server
 * Runs the unified ATAX Model Context Protocol (MCP) server locally over stdio.
 * For use with Antigravity, Claude Desktop, Cursor, and any MCP client using stdio.
 */
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadMcpRuntimeConfig } from './ledger-config.mjs';
import { routeRpc } from './worker.mjs';

// Auto-load environment from candidate .env files if not already in process.env
export function loadLocalEnv() {
  const toolDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(toolDir, '../..');
  const candidateEnvPaths = [
    resolve(repoRoot, '.env'),
    resolve(repoRoot, 'supabase/.env'),
    resolve(toolDir, '.env')
  ];

  for (const envPath of candidateEnvPaths) {
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim();
          let val = trimmed.slice(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }

  // Canonical alias resolution for Supabase Data API
  if (!process.env.ATAX_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.ATAX_SUPABASE_URL = process.env.SUPABASE_URL;
  }
  if (!process.env.ATAX_SUPABASE_SECRET_KEY) {
    process.env.ATAX_SUPABASE_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  }
}

loadLocalEnv();

async function startStdio() {
  console.error('[atax-stdio] Initializing canonical ATAX MCP runtime configuration...');
  let runtimeConfig;
  try {
    runtimeConfig = await loadMcpRuntimeConfig(process.env);
    console.error('[atax-stdio] Canonical substrate configuration loaded successfully.');
  } catch (err) {
    console.error('[atax-stdio] Fatal: failed to load runtime config from substrate:', err.message);
    process.exit(1);
  }

  const subject = String(runtimeConfig.MCP_OWNER_SUBJECT || runtimeConfig.MCP_SHARED_SUBJECT || 'atax-operator');
  const scopesList = String(runtimeConfig.MCP_SHARED_SCOPES || 'atax:read atax:write atax:verify atax:github:read atax:github:create atax:cloudflare:read atax:fmrl:execute').split(' ').filter(Boolean);

  const principal = {
    id: subject,
    authMethod: 'shared',
    scopes: new Set(scopesList)
  };

  console.error(`[atax-stdio] Authenticated local operator '${subject}' with ${scopesList.length} scopes.`);
  console.error('[atax-stdio] Ready for MCP stdio messages.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let lastConfigLoad = Date.now();
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      const errReply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
      process.stdout.write(JSON.stringify(errReply) + '\n');
      return;
    }

    if (Date.now() - lastConfigLoad > 5000) {
      try {
        runtimeConfig = await loadMcpRuntimeConfig(process.env);
        lastConfigLoad = Date.now();
        const curSubject = String(runtimeConfig.MCP_OWNER_SUBJECT || runtimeConfig.MCP_SHARED_SUBJECT || 'atax-operator');
        principal.id = curSubject;
      } catch {
        // preserve current on transient error
      }
    }

    try {
      const reply = await routeRpc(msg, principal, runtimeConfig, fetch);
      if (reply !== undefined) {
        process.stdout.write(JSON.stringify(reply) + '\n');
      }
    } catch (err) {
      console.error('[atax-stdio] Error handling RPC:', err);
      const errReply = {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: -32603, message: 'Internal error: ' + err.message }
      };
      process.stdout.write(JSON.stringify(errReply) + '\n');
    }
  });

  rl.on('close', () => {
    console.error('[atax-stdio] stdin closed. Exiting.');
    process.exit(0);
  });
}

startStdio().catch((err) => {
  console.error('[atax-stdio] Unhandled exception:', err);
  process.exit(1);
});
