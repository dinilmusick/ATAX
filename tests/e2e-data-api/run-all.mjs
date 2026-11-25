#!/usr/bin/env node
/**
 * Master Test Runner for ATAX E2E Data API & MCP Test Suite
 * Executes Tiers 1-4 across feature coverage, boundaries, pairwise combinations,
 * and operational lifecycles.
 * 
 * Usage:
 *   node tests/e2e-data-api/run-all.mjs
 *   ATAX_MCP_URL=https://atax.todadjp.workers.dev node tests/e2e-data-api/run-all.mjs
 */
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const testFiles = [
  { tier: 'Tier 1: Feature Coverage (Isolation)', file: resolve(__dirname, 'tier1-feature-coverage.test.mjs') },
  { tier: 'Tier 2: Boundary & Corner Cases', file: resolve(__dirname, 'tier2-boundary-corner.test.mjs') },
  { tier: 'Tier 3: Cross-Feature Combinations', file: resolve(__dirname, 'tier3-cross-feature.test.mjs') },
  { tier: 'Tier 4: Real-World Scenarios', file: resolve(__dirname, 'tier4-application-scenarios.test.mjs') }
];

console.log('================================================================================');
console.log('              ATAX E2E DATA API & MCP TEST SUITE RUNNER                        ');
console.log('================================================================================');
console.log(`Target Mode: ${process.env.ATAX_MCP_URL ? `Live Remote (${process.env.ATAX_MCP_URL})` : 'In-Memory Local Mock Server'}`);
console.log(`Node Version: ${process.version}`);
console.log(`Test Files: ${testFiles.length} suites across 4 verification tiers\n`);

const startTime = Date.now();
const testStream = run({
  files: testFiles.map(t => t.file)
});

let totalPass = 0;
let totalFail = 0;
const tierStats = {
  'tier1-feature-coverage.test.mjs': { name: 'Tier 1: Feature Coverage (Isolation)', pass: 0, fail: 0 },
  'tier2-boundary-corner.test.mjs': { name: 'Tier 2: Boundary & Corner Cases', pass: 0, fail: 0 },
  'tier3-cross-feature.test.mjs': { name: 'Tier 3: Cross-Feature Combinations', pass: 0, fail: 0 },
  'tier4-application-scenarios.test.mjs': { name: 'Tier 4: Real-World Scenarios', pass: 0, fail: 0 }
};

testStream.on('test:pass', (t) => {
  if (t.nesting > 0) { // Only count leaf tests, not top-level suites
    totalPass++;
    for (const key of Object.keys(tierStats)) {
      if (t.file && t.file.includes(key)) {
        tierStats[key].pass++;
      }
    }
  }
});

testStream.on('test:fail', (t) => {
  if (t.nesting > 0) {
    totalFail++;
    for (const key of Object.keys(tierStats)) {
      if (t.file && t.file.includes(key)) {
        tierStats[key].fail++;
      }
    }
  }
});

testStream.compose(new spec()).pipe(process.stdout);

testStream.on('end', () => {
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n================================================================================');
  console.log('                           COVERAGE SUMMARY TABLE                               ');
  console.log('================================================================================');
  console.log('| Tier | Description                           | Passed | Failed | Total | Status |');
  console.log('|------|---------------------------------------|--------|--------|-------|--------|');
  
  let tierIdx = 1;
  for (const stats of Object.values(tierStats)) {
    const total = stats.pass + stats.fail;
    const status = stats.fail === 0 && total > 0 ? 'PASS' : 'FAIL';
    console.log(`| T${tierIdx}   | ${stats.name.padEnd(37)} | ${String(stats.pass).padStart(6)} | ${String(stats.fail).padStart(6)} | ${String(total).padStart(5)} | ${status.padEnd(6)} |`);
    tierIdx++;
  }

  console.log('|------|---------------------------------------|--------|--------|-------|--------|');
  const grandTotal = totalPass + totalFail;
  console.log(`| Total| All Verification Tiers                | ${String(totalPass).padStart(6)} | ${String(totalFail).padStart(6)} | ${String(grandTotal).padStart(5)} | ${(totalFail === 0 ? 'PASS' : 'FAIL').padEnd(6)} |`);
  console.log('================================================================================');
  console.log(`Total Duration: ${duration}s | Pass Rate: ${grandTotal > 0 ? ((totalPass / grandTotal) * 100).toFixed(1) : 0}%\n`);

  if (totalFail > 0) {
    console.error(`FAILED: ${totalFail} test(s) failed.`);
    process.exit(1);
  } else {
    console.log('SUCCESS: All tests passed with 100% success rate.');
    process.exit(0);
  }
});
