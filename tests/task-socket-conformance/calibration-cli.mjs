import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { determineCeiling, deriveReliableCeiling } from './calibration.mjs';
const dir = dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(readFileSync(join(dir, 'model-profiles.json'), 'utf8'));
const source = process.argv[2];
let evidence;
if (source) evidence = JSON.parse(readFileSync(source, 'utf8'));
const rows = catalogue.profiles.map(p => {
  let observed = null;
  if (evidence && evidence.provenance?.provider === p.provider && evidence.provenance?.model === p.model) {
    observed = deriveReliableCeiling(evidence, catalogue.policy.minReliabilityPassRate);
  }
  return { key: p.key, contextTokens: p.contextTokens, maxOutputTokens: p.maxOutputTokens,
    status: observed === null ? 'NOT_CALIBRATED' : 'CALIBRATED',
    ...determineCeiling(p, catalogue.policy, observed) };
});
console.log(JSON.stringify({ schemaVersion: 1, reviewedAt: catalogue.reviewedAt, rows }, null, 2));