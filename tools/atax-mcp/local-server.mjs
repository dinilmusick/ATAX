#!/usr/bin/env node
/**
 * ATAX Local MCP HTTP Server
 * Runs the unified ATAX Model Context Protocol (MCP) server locally over HTTP.
 * Supports /mcp (JSON-RPC 2.0 / Streamable HTTP), /socket, and /health.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHandler } from './worker.mjs';

// Auto-load .env from repository root if not already in environment
if (!process.env.ATAX_SUPABASE_CONNECTION_URL) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const envPath = resolve(repoRoot, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

const PORT = parseInt(process.env.PORT || process.env.ATAX_MCP_PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';

const handler = createHandler();

export function createLocalServer(env = process.env) {
  return http.createServer(async (req, res) => {
    try {
      const url = `http://${req.headers.host || `${HOST}:${PORT}`}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) {
          if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
          else headers.set(k, v);
        }
      }

      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }

      const webReq = new Request(url, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? body : undefined,
        duplex: 'half'
      });

      const webRes = await handler(webReq, env);
      res.statusCode = webRes.status;
      for (const [k, v] of webRes.headers.entries()) {
        res.setHeader(k, v);
      }
      if (webRes.body) {
        const buf = Buffer.from(await webRes.arrayBuffer());
        res.end(buf);
      } else {
        res.end();
      }
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal server error', message: err.message }));
    }
  });
}

// Direct execution entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = createLocalServer();
  server.listen(PORT, HOST, () => {
    console.log(`[atax-mcp] Local unified server listening on http://${HOST}:${PORT}`);
    console.log(`[atax-mcp] MCP Endpoint:    http://${HOST}:${PORT}/mcp`);
    console.log(`[atax-mcp] Socket Endpoint: http://${HOST}:${PORT}/socket`);
    console.log(`[atax-mcp] Health Check:    http://${HOST}:${PORT}/health`);
  });

  const shutdown = () => {
    console.log('\n[atax-mcp] Shutting down local server...');
    server.close(() => {
      console.log('[atax-mcp] Stopped.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
