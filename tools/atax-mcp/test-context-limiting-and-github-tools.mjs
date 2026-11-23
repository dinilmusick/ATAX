#!/usr/bin/env node
/**
 * Test Suite: Context Limiting, Socket Metering, and GitHub Coding/Building/Linting Tools
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveBudget,
  createSocketBudgetMeter,
  estimateTextTokens,
  UNKNOWN_CONTEXT_TOKENS,
  VERIFIED_MODELS
} from '../socket-budget/index.mjs';

// Auto-hydrate .env
const envPath = resolve(process.cwd(), '.env');
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

const MCP_URL = 'http://127.0.0.1:8787/mcp';
const TEST_TOKEN = process.env.ATAX_MCP_SHARED_TOKEN || 'atax_5426bb43a95f34297740e50804035fc67db24be2be32098d';

console.log('=== STARTING CONTEXT LIMITING & GITHUB TOOLS VERIFICATION ===\n');

// =========================================================================
// SECTION 1: CONTEXT LIMITING & TOKEN BUDGET VERIFICATION
// =========================================================================
console.log('--- SECTION 1: Context Limiting & Model Capacity Profiles ---');

// 1.1 Verify unknown model fallback
const fallbackBudget = resolveBudget('unknown-custom-model');
assert.equal(fallbackBudget.contextWindowTokens, UNKNOWN_CONTEXT_TOKENS, 'Unknown model must use 8192-token conservative fallback');
assert.equal(fallbackBudget.maxUsableTokens, Math.floor(8192 * 0.4), 'Max usable tokens must be strictly 40% of window');
assert.equal(fallbackBudget.inputLimit, Math.floor(fallbackBudget.maxUsableTokens * 0.75), 'Input limit is 75% of usable tokens');
assert.equal(fallbackBudget.overhead, 8, 'Message overhead must be 8 tokens');
console.log(`[PASS] Fallback profile: window=${fallbackBudget.contextWindowTokens}, usable=${fallbackBudget.maxUsableTokens}, inputLimit=${fallbackBudget.inputLimit}, outputLimit=${fallbackBudget.outputLimit}`);

// 1.2 Verify verified models
for (const [modelId, expected] of Object.entries(VERIFIED_MODELS)) {
  const b = resolveBudget(modelId);
  assert.equal(b.verified, true);
  assert.equal(b.contextWindowTokens, expected.contextWindowTokens);
  assert.equal(b.maxUsableTokens, Math.floor(expected.contextWindowTokens * 0.4));
  console.log(`[PASS] Verified model '${modelId}': window=${b.contextWindowTokens}, ceiling=${b.maxUsableTokens}`);
}

// 1.3 Meter state: normal transfer vs 80% threshold approach
console.log('\n--- SECTION 2: Metering Thresholds, Approach Warning & Rejection ---');
const socketId = 'test-socket-' + Date.now();
const meter = createSocketBudgetMeter(socketId, 'unknown', {
  maxUsableTokens: 1000,
  inputLimit: 750,
  outputLimit: 250,
  approachFraction: 0.8
});

// Normal input: small transfer
const initialSnap = meter.snapshot();
assert.equal(initialSnap.inputTokens, 0);
assert.equal(initialSnap.outputTokens, 0);

const d1 = meter.chargeInput('hello world from test container');
assert.equal(d1.accepted, true);
assert.equal(d1.status, 'allowed');
console.log(`[PASS] Normal input accepted: charged ${d1.chargedTokens} tokens (wire + 8 overhead)`);

// Approach warning (push input over 80% of 750 = 600 tokens)
const chunk600 = 'a'.repeat(600 - meter.snapshot().inputTokens);
const d2 = meter.chargeInput(chunk600);
assert.equal(d2.accepted, true);
assert.equal(d2.status, 'approaching_limit', 'Should trigger approaching_limit warning at >= 80%');
console.log(`[PASS] Approaching limit warning triggered: used=${meter.snapshot().inputTokens}/750, status=${d2.status}`);

// Input quota exceed rejection
const oversized = 'x'.repeat(200);
const d3 = meter.chargeInput(oversized);
assert.equal(d3.accepted, false);
assert.equal(d3.status, 'input_exceeded');
assert.ok(d3.reasons.includes('input_quota'));
console.log(`[PASS] Input quota exceeded rejection verified: status=${d3.status}, reasons=${JSON.stringify(d3.reasons)}`);

// Output quota exceed rejection
const meterOut = createSocketBudgetMeter('out-test', 'unknown', { maxUsableTokens: 100, inputLimit: 70, outputLimit: 30 });
const outReject = meterOut.chargeOutput('z'.repeat(50));
assert.equal(outReject.accepted, false);
assert.equal(outReject.status, 'output_exceeded');
assert.ok(outReject.reasons.includes('output_quota'));
console.log(`[PASS] Output quota exceeded rejection verified: status=${outReject.status}, reasons=${JSON.stringify(outReject.reasons)}`);

// Combined capacity rejection
const meterCombined = createSocketBudgetMeter('comb-test', 'unknown', { maxUsableTokens: 100, inputLimit: 90, outputLimit: 90 });
meterCombined.chargeInput('i'.repeat(50));
const combReject = meterCombined.chargeOutput('o'.repeat(50));
assert.equal(combReject.accepted, false);
assert.ok(combReject.reasons.includes('combined_capacity'));
console.log(`[PASS] Combined capacity rejection verified: reasons=${JSON.stringify(combReject.reasons)}`);

// Stale revision CAS rejection
assert.throws(() => {
  meter.chargeInput('concurrent race test', 'text', 999);
}, /STALE_BUDGET_REVISION/);
console.log('[PASS] Stale budget revision concurrent protection verified');


// =========================================================================
// SECTION 3: LIVE MCP GITHUB TOOLS FOR CODING, BUILDING & LINTING
// =========================================================================
console.log('\n--- SECTION 3: Live GitHub Tools (Coding, Building, Linting) ---');

async function callMcp(toolName, args = {}) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + TEST_TOKEN
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 100000),
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`MCP Error ${data.error.code}: ${data.error.message}`);
  return JSON.parse(data.result.content[0].text);
}

// 3.1 Inspect GitHub repository
const repoInfo = await callMcp('atax_github_repository_inspect', { repository: 'dinilmusick/ATAX' });
assert.equal(repoInfo.operation, 'inspect_repository');
assert.equal(repoInfo.repository, 'dinilmusick/ATAX');
assert.equal(repoInfo.default_branch, 'main');
console.log(`[PASS] atax_github_repository_inspect: repo=${repoInfo.repository}, default_branch=${repoInfo.default_branch}`);

// 3.2 Read file directly via GitHub API (Coding via GitHub)
const fileData = await callMcp('atax_github_file_get', { repository: 'dinilmusick/ATAX', path: 'package.json' });
assert.equal(fileData.operation, 'file_get');
assert.equal(fileData.path, 'package.json');
assert.ok(fileData.content.includes('atax-substrate-dashboard'));
console.log(`[PASS] atax_github_file_get: successfully read ${fileData.path} (${fileData.size} bytes) via GitHub API`);

// 3.3 Inspect check runs (Automated Lint & Test results on GitHub)
const checkRuns = await callMcp('atax_github_check_runs', { repository: 'dinilmusick/ATAX', ref: 'main' });
assert.equal(checkRuns.operation, 'check_runs');
assert.ok(Array.isArray(checkRuns.check_runs));
console.log(`[PASS] atax_github_check_runs: retrieved ${checkRuns.check_runs.length} check runs for main branch`);

// 3.4 Inspect GitHub Actions workflow runs (Building & CI via GitHub)
const runs = await callMcp('atax_github_workflow_runs', { repository: 'dinilmusick/ATAX' });
assert.equal(runs.operation, 'workflow_runs_list');
assert.ok(Array.isArray(runs.runs));
console.log(`[PASS] atax_github_workflow_runs: found ${runs.runs.length} recent workflow runs on GitHub`);
if (runs.runs.length > 0) {
  const latest = runs.runs[0];
  console.log(`       Latest run: ID=${latest.id}, name="${latest.name}", status=${latest.status}, conclusion=${latest.conclusion}`);
}

console.log('\n================================================================');
console.log('🎉 ALL CONTEXT LIMITING & GITHUB TOOLS VERIFIED SUCCESSFULLY!');
console.log('================================================================\n');
