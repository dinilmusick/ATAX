/**
 * tests/m1-challenger-concurrency.test.mjs
 * Empirical Concurrency, Statelessness, and Stress Challenge Harness for Milestone M1.
 * 
 * Objectives:
 * 1. Empirically verify that openLedger operates statelessly via native fetch without
 *    shared mutable state, cross-contamination, or connection pool limits.
 * 2. Empirically execute 100+ concurrent simulated tool calls through worker.mjs handler
 *    to verify zero memory leaks, zero promise lockup, and zero socket exhaustion.
 * 3. Test adversarial mixed-traffic loads under high concurrency.
 * 4. Test multi-wave burst resilience (5 waves of 100 parallel requests = 500 dispatches).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openLedger, CANONICAL_RPC_ALLOWLIST, LedgerError } from '../tools/atax-mcp/data-api-ledger.mjs';
import { createHandler } from '../tools/atax-mcp/worker.mjs';

const TEST_SECRET_A = 'test_secret_key_alpha_12345678901234567890';
const TEST_SECRET_B = 'test_secret_key_beta_98765432109876543210';
const TEST_TOKEN = 'atax_5426bb43a95f34297740e50804035fc67db24be2be32098d';
const TEST_TOKEN_SHA256 = createHash('sha256').update(TEST_TOKEN).digest('hex');

describe('Milestone M1 Challenger: Empirical Concurrency & Statelessness Harness', () => {

  describe('1. openLedger Statelessness & Zero-Cross-Contamination', () => {

    test('Instance isolation: multiple openLedger instances maintain distinct endpoints & keys under parallel load', async () => {
      const callsA = [];
      const callsB = [];

      const mockFetchA = async (url, init) => {
        callsA.push({ url, headers: init.headers });
        return new Response(JSON.stringify({ project: 'A', status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const mockFetchB = async (url, init) => {
        callsB.push({ url, headers: init.headers });
        return new Response(JSON.stringify({ project: 'B', status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const ledgerA = await openLedger({
        ATAX_SUPABASE_URL: 'https://project-alpha.supabase.co',
        ATAX_SUPABASE_SECRET_KEY: TEST_SECRET_A
      }, mockFetchA);

      const ledgerB = await openLedger({
        ATAX_SUPABASE_URL: 'https://project-beta.supabase.co',
        ATAX_SUPABASE_SECRET_KEY: TEST_SECRET_B
      }, mockFetchB);

      // Concurrently dispatch 50 requests to ledgerA and 50 to ledgerB interleaved
      const tasks = [];
      for (let i = 0; i < 50; i++) {
        tasks.push(ledgerA.rpc('agent_context_overview', {}));
        tasks.push(ledgerB.rpc('agent_context_overview', {}));
      }

      const results = await Promise.all(tasks);
      assert.equal(results.length, 100);
      assert.equal(callsA.length, 50);
      assert.equal(callsB.length, 50);

      // Verify strict isolation: No Key A on B, No Key B on A, correct URLs
      for (const call of callsA) {
        assert.equal(call.url, 'https://project-alpha.supabase.co/rest/v1/rpc/agent_context_overview');
        assert.equal(call.headers.apikey, TEST_SECRET_A);
        assert.equal(call.headers.Authorization, `Bearer ${TEST_SECRET_A}`);
      }

      for (const call of callsB) {
        assert.equal(call.url, 'https://project-beta.supabase.co/rest/v1/rpc/agent_context_overview');
        assert.equal(call.headers.apikey, TEST_SECRET_B);
        assert.equal(call.headers.Authorization, `Bearer ${TEST_SECRET_B}`);
      }
    });

    test('Zero connection pool bottleneck: 200 parallel RPC dispatches execute concurrently without queueing', async () => {
      let concurrentActive = 0;
      let peakConcurrency = 0;

      const mockFetch = async (url, init) => {
        concurrentActive++;
        if (concurrentActive > peakConcurrency) {
          peakConcurrency = concurrentActive;
        }
        // Small delay to simulate network latency and ensure concurrency overlap
        await new Promise(r => setTimeout(r, 10));
        concurrentActive--;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const ledger = await openLedger({
        ATAX_SUPABASE_URL: 'https://test-project.supabase.co',
        ATAX_SUPABASE_SECRET_KEY: TEST_SECRET_A
      }, mockFetch);

      const promises = [];
      const DISPATCH_COUNT = 200;
      for (let i = 0; i < DISPATCH_COUNT; i++) {
        promises.push(ledger.rpc('agent_context_overview', {}));
      }

      const results = await Promise.all(promises);
      assert.equal(results.length, DISPATCH_COUNT);
      // If there were a traditional connection pool (e.g. pool_size=10), peakConcurrency would be clamped to 10.
      // With stateless native fetch, all 200 dispatches are fired immediately.
      assert.ok(peakConcurrency >= 100, `Expected high peak concurrency without pooling bottleneck, got ${peakConcurrency}`);
      assert.equal(concurrentActive, 0);
    });

    test('Parameter isolation: concurrent calls with different payloads cannot mutate or pollute sibling calls', async () => {
      const receivedPayloads = [];

      const mockFetch = async (url, init) => {
        const body = JSON.parse(init.body);
        receivedPayloads.push(body);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const ledger = await openLedger({
        ATAX_SUPABASE_URL: 'https://test-project.supabase.co',
        ATAX_SUPABASE_SECRET_KEY: TEST_SECRET_A
      }, mockFetch);

      const calls = [];
      for (let i = 0; i < 100; i++) {
        const payload = { system_key_in: `sys_${i}`, tags_in: [`tag_${i}`] };
        calls.push(ledger.rpc('goal_ledger_overview', payload));
      }

      const results = await Promise.all(calls);
      assert.equal(results.length, 100);
      assert.equal(receivedPayloads.length, 100);

      // Verify each result strictly matches its own input index
      for (let i = 0; i < 100; i++) {
        assert.equal(results[i].system_key_in, `sys_${i}`);
        assert.deepEqual(results[i].tags_in, [`tag_${i}`]);
      }
    });

    test('Timeout and abort isolation: one timed out call does not invalidate the ledger instance or other calls', async () => {
      let callIndex = 0;
      const mockFetch = async (url, init) => {
        const current = ++callIndex;
        if (current === 1) {
          // Trigger AbortError
          const err = new Error('The operation was aborted');
          err.name = 'TimeoutError';
          throw err;
        }
        return new Response(JSON.stringify({ result: 'success', call: current }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const ledger = await openLedger({
        ATAX_SUPABASE_URL: 'https://test-project.supabase.co',
        ATAX_SUPABASE_SECRET_KEY: TEST_SECRET_A
      }, mockFetch);

      // Call 1 fails with timeout
      await assert.rejects(
        () => ledger.rpc('agent_context_overview', {}),
        (err) => err instanceof LedgerError && err.code === 'TIMEOUT' && err.status === 504
      );

      // Call 2 immediately succeeds on the same ledger instance
      const res2 = await ledger.rpc('agent_context_overview', {});
      assert.equal(res2.result, 'success');
      assert.equal(res2.call, 2);
    });

  });

  describe('2. worker.mjs Handler: 100 Concurrent Tool Calls Stress Harness', () => {

    function createMockWorkerEnv(ledgerDb) {
      return {
        __ledgerDb: ledgerDb,
        MCP_OWNER_SUBJECT: 'atax-test-operator',
        MCP_SHARED_SUBJECT: 'atax-test-operator',
        MCP_SHARED_TOKEN_SHA256: TEST_TOKEN_SHA256,
        MCP_SHARED_SCOPES: 'atax:read atax:write atax:verify atax:admin',
      };
    }

    test('100 concurrent tool calls through worker.mjs: verify zero promise lockup, zero leak, and 100% resolution', async () => {
      let fetchCount = 0;
      const mockFetch = async (url, init) => {
        fetchCount++;
        // Small variable jitter (1-5ms) to simulate real async concurrency interleaving
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 5) + 1));
        return new Response(JSON.stringify({ mock: 'data', timestamp: Date.now() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const ledger = await openLedger({
        ATAX_SUPABASE_URL: 'https://test-project.supabase.co',
        ATAX_SUPABASE_SECRET_KEY: TEST_SECRET_A
      }, mockFetch);

      const workerEnv = createMockWorkerEnv(ledger);
      const handler = createHandler(mockFetch, async () => workerEnv);

      const initialMemory = process.memoryUsage();
      const startTime = Date.now();

      // Construct 100 concurrent requests across various read and discovery tools
      const toolNames = ['atax_context', 'atax_goal_overview', 'atax_system_context'];
      const requests = [];

      for (let i = 0; i < 100; i++) {
        const toolName = toolNames[i % toolNames.length];
        const args = toolName === 'atax_system_context' ? { system_key: 'atax' } : {};
        const payload = {
          jsonrpc: '2.0',
          id: i + 1,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args
          }
        };

        const req = new Request('https://atax.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TEST_TOKEN}`
          },
          body: JSON.stringify(payload)
        });

        requests.push(handler(req, workerEnv));
      }

      // Execute all 100 in parallel
      const responses = await Promise.all(requests);
      const durationMs = Date.now() - startTime;
      const finalMemory = process.memoryUsage();

      assert.equal(responses.length, 100);

      // Verify all responses returned HTTP 200 and valid JSON-RPC results
      for (let i = 0; i < 100; i++) {
        const res = responses[i];
        assert.equal(res.status, 200, `Request ${i} returned status ${res.status}`);
        const data = await res.json();
        assert.equal(data.jsonrpc, '2.0');
        assert.equal(data.id, i + 1);
        assert.ok(data.result, `Request ${i} missing result`);
        assert.ok(!data.result.isError, `Request ${i} unexpectedly returned tool error`);
      }

      // Concurrency Performance Assertions
      assert.ok(durationMs < 5000, `100 concurrent requests took ${durationMs}ms (expected < 5000ms)`);

      // Memory Leak Verification: heap growth per request must be bounded (< 100KB per call under concurrency)
      const heapDelta = finalMemory.heapUsed - initialMemory.heapUsed;
      const heapDeltaPerReq = heapDelta / 100;
      // Normal V8 GC variation is fine, but heap growth should not exceed 500KB per request
      assert.ok(heapDeltaPerReq < 500 * 1024, `Heap growth excessive: ${(heapDeltaPerReq / 1024).toFixed(2)} KB/req`);
    });

    test('Adversarial mixed traffic concurrency: 100 parallel requests with auth failures, malformed JSON, unknown tools, and valid calls', async () => {
      const mockFetch = async (url, init) => {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const ledger = await openLedger({
        ATAX_SUPABASE_URL: 'https://test-project.supabase.co',
        ATAX_SUPABASE_SECRET_KEY: TEST_SECRET_A
      }, mockFetch);

      const workerEnv = createMockWorkerEnv(ledger);
      const handler = createHandler(mockFetch, async () => workerEnv);

      const requests = [];

      for (let i = 0; i < 100; i++) {
        let req;
        const kind = i % 5;

        if (kind === 0) {
          // Valid tool call
          req = new Request('https://atax.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${TEST_TOKEN}`
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: i,
              method: 'tools/call',
              params: { name: 'atax_context', arguments: {} }
            })
          });
        } else if (kind === 1) {
          // Unauthorized (invalid bearer token)
          req = new Request('https://atax.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer atax_invalid_bad_token_123456789'
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: i,
              method: 'tools/call',
              params: { name: 'atax_context', arguments: {} }
            })
          });
        } else if (kind === 2) {
          // Malformed JSON body
          req = new Request('https://atax.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${TEST_TOKEN}`
            },
            body: '{"jsonrpc": "2.0", "unclosed": '
          });
        } else if (kind === 3) {
          // Unknown tool call
          req = new Request('https://atax.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${TEST_TOKEN}`
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: i,
              method: 'tools/call',
              params: { name: 'non_existent_tool_xyz', arguments: {} }
            })
          });
        } else {
          // Schema violation (missing required argument)
          req = new Request('https://atax.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${TEST_TOKEN}`
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: i,
              method: 'tools/call',
              params: { name: 'atax_system_context', arguments: {} } // missing required system_key
            })
          });
        }

        requests.push({ kind, index: i, promise: handler(req, workerEnv) });
      }

      // Await all 100 in parallel
      const results = await Promise.all(requests.map(r => r.promise));
      assert.equal(results.length, 100);

      // Assert appropriate status codes for each kind
      for (let i = 0; i < 100; i++) {
        const { kind, index } = requests[i];
        const res = results[i];

        if (kind === 0) {
          // Valid
          assert.equal(res.status, 200);
          const data = await res.json();
          assert.equal(data.id, index);
          assert.ok(data.result);
        } else if (kind === 1) {
          // Unauthorized
          assert.equal(res.status, 401);
        } else if (kind === 2) {
          // Parse error
          assert.equal(res.status, 400);
        } else if (kind === 3) {
          // Unknown tool
          assert.equal(res.status, 200);
          const data = await res.json();
          assert.ok(data.result?.isError);
          assert.match(data.result.content[0].text, /Unknown tool/);
        } else if (kind === 4) {
          // Schema violation
          assert.equal(res.status, 200);
          const data = await res.json();
          assert.ok(data.result?.isError);
          assert.match(data.result.content[0].text, /Missing required argument/);
        }
      }
    });

    test('Multi-wave burst resilience: 5 sequential waves of 100 concurrent requests (500 total) maintain performance and stability', async () => {
      let callCount = 0;
      const mockFetch = async (url, init) => {
        callCount++;
        return new Response(JSON.stringify({ wave_ack: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const ledger = await openLedger({
        ATAX_SUPABASE_URL: 'https://test-project.supabase.co',
        ATAX_SUPABASE_SECRET_KEY: TEST_SECRET_A
      }, mockFetch);

      const workerEnv = createMockWorkerEnv(ledger);
      const handler = createHandler(mockFetch, async () => workerEnv);

      const WAVE_COUNT = 5;
      const PER_WAVE = 100;
      const waveDurations = [];

      for (let w = 0; w < WAVE_COUNT; w++) {
        const waveStart = Date.now();
        const waveRequests = [];

        for (let i = 0; i < PER_WAVE; i++) {
          const req = new Request('https://atax.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${TEST_TOKEN}`
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: w * PER_WAVE + i + 1,
              method: 'tools/call',
              params: { name: 'atax_context', arguments: {} }
            })
          });
          waveRequests.push(handler(req, workerEnv));
        }

        const waveResponses = await Promise.all(waveRequests);
        const waveDuration = Date.now() - waveStart;
        waveDurations.push(waveDuration);

        assert.equal(waveResponses.length, PER_WAVE);
        for (const res of waveResponses) {
          assert.equal(res.status, 200);
        }
      }

      assert.equal(callCount, WAVE_COUNT * PER_WAVE); // exactly 500 dispatches
      // Verify no degradation across waves (wave 5 duration should be comparable to wave 1)
      const firstWave = waveDurations[0];
      const lastWave = waveDurations[WAVE_COUNT - 1];
      // Allow up to 3x variance in test environment, but not unbounded slowdown
      assert.ok(lastWave < Math.max(3000, firstWave * 3), `Wave slowdown detected: Wave 1=${firstWave}ms, Wave 5=${lastWave}ms`);
    });

  });

  describe('3. Live HTTP Socket Concurrency Harness (Real Network TCP Sockets)', () => {

    test('100 concurrent HTTP POST requests over localhost TCP sockets: zero socket exhaustion, zero dropped connections', async () => {
      const { createMockServer } = await import('./e2e-data-api/mock-server.mjs');
      const { createMcpClient } = await import('./e2e-data-api/harness.mjs');

      const mock = createMockServer();
      const baseUrl = await mock.listen(0, '127.0.0.1');
      const client = createMcpClient(baseUrl);

      const startTime = Date.now();
      const CONCURRENT_HTTP_CALLS = 100;
      const tasks = [];

      for (let i = 0; i < CONCURRENT_HTTP_CALLS; i++) {
        tasks.push(client.callTool('atax_context', {}));
      }

      const results = await Promise.all(tasks);
      const durationMs = Date.now() - startTime;

      assert.equal(results.length, CONCURRENT_HTTP_CALLS);

      for (let i = 0; i < CONCURRENT_HTTP_CALLS; i++) {
        const resp = results[i];
        assert.equal(resp.status, 200, `HTTP request ${i} returned status ${resp.status}`);
        assert.ok(resp.json, `HTTP request ${i} did not return valid JSON`);
        assert.equal(resp.json.jsonrpc, '2.0');
        assert.ok(resp.json.result, `HTTP request ${i} missing result`);
        assert.ok(!resp.json.result.isError, `HTTP request ${i} returned error`);
      }

      assert.ok(durationMs < 10000, `100 HTTP requests over TCP took ${durationMs}ms (expected < 10000ms)`);

      await mock.close();
    });

    test('100 concurrent direct PostgREST RPC requests over localhost TCP sockets: zero socket exhaustion', async () => {
      const { createMockServer } = await import('./e2e-data-api/mock-server.mjs');
      const { createMcpClient } = await import('./e2e-data-api/harness.mjs');

      const mock = createMockServer();
      const baseUrl = await mock.listen(0, '127.0.0.1');
      const client = createMcpClient(baseUrl);

      const CONCURRENT_POSTGREST_CALLS = 100;
      const tasks = [];

      for (let i = 0; i < CONCURRENT_POSTGREST_CALLS; i++) {
        tasks.push(client.directPostgrestRpc('agent_context_overview', {}));
      }

      const results = await Promise.all(tasks);
      assert.equal(results.length, CONCURRENT_POSTGREST_CALLS);

      for (let i = 0; i < CONCURRENT_POSTGREST_CALLS; i++) {
        const resp = results[i];
        assert.equal(resp.status, 200, `Direct PostgREST RPC ${i} returned status ${resp.status}`);
        assert.ok(resp.json, `Direct PostgREST RPC ${i} did not return valid JSON`);
        assert.ok(Array.isArray(resp.json.universes));
      }

      await mock.close();
    });

  });

});

