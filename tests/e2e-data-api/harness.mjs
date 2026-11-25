/**
 * E2E Test Harness & Lightweight MCP Client
 * Works identically against:
 * 1. The in-memory local mock server (tests/e2e-data-api/mock-server.mjs)
 * 2. The live deployed Cloudflare Worker (via ATAX_MCP_URL)
 */
import { createMockServer, TEST_OPERATOR_TOKEN, TEST_SUPABASE_SERVICE_KEY } from './mock-server.mjs';

export function createMcpClient(baseUrl, token = TEST_OPERATOR_TOKEN) {
  let rpcId = 1;

  return {
    baseUrl,
    token,

    async health() {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json().catch(() => null);
      return { status: res.status, headers: res.headers, body };
    },

    async rawPost(path, body, customHeaders = {}) {
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...customHeaders
      };
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, headers: res.headers, text, json };
    },

    async rawGet(path, customHeaders = {}) {
      const headers = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...customHeaders
      };
      const res = await fetch(`${baseUrl}${path}`, { method: 'GET', headers });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, headers: res.headers, text, json };
    },

    async rawHttpRequest(options = {}) {
      const http = await import('node:http');
      const u = new URL(`${baseUrl}${options.path || '/mcp'}`);
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: options.method || 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(options.headers || {})
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(data); } catch {}
            resolve({ status: res.statusCode, headers: new Headers(res.headers), text: data, json });
          });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
      });
    },

    async callRpc(method, params = {}, customId) {
      const id = customId !== undefined ? customId : rpcId++;
      const payload = { jsonrpc: '2.0', id, method, params };
      const resp = await this.rawPost('/mcp', payload);
      return resp;
    },

    async callTool(name, args = {}) {
      const resp = await this.callRpc('tools/call', { name, arguments: args });
      return resp;
    },

    async initialize(protocolVersion = '2025-06-18', clientInfo = { name: 'e2e-test-suite', version: '1.0.0' }) {
      const params = {};
      if (protocolVersion !== undefined) params.protocolVersion = protocolVersion;
      if (clientInfo !== undefined) params.clientInfo = clientInfo;
      return this.callRpc('initialize', params);
    },

    async toolsList() {
      return this.callRpc('tools/list', {});
    },

    async directPostgrestRpc(name, params = {}, serviceKey = TEST_SUPABASE_SERVICE_KEY) {
      const res = await fetch(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(params)
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return { status: res.status, headers: res.headers, json, text };
    }
  };
}

export async function setupTestEnvironment() {
  const liveUrl = process.env.ATAX_MCP_URL;
  const liveToken = process.env.ATAX_MCP_TOKEN || TEST_OPERATOR_TOKEN;

  if (liveUrl) {
    const client = createMcpClient(liveUrl.replace(/\/$/, ''), liveToken);
    return {
      baseUrl: liveUrl,
      client,
      isMock: false,
      state: null,
      async cleanup() {}
    };
  }

  const mock = createMockServer();
  const baseUrl = await mock.listen(0, '127.0.0.1');
  const client = createMcpClient(baseUrl, TEST_OPERATOR_TOKEN);

  return {
    baseUrl,
    client,
    isMock: true,
    state: mock.state,
    async cleanup() {
      await mock.close();
    }
  };
}
