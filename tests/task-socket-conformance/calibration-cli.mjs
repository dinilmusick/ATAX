import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { determineCeiling } from './calibration.mjs';
import { deriveAttestedReliableCeiling } from './attestation.mjs';
const dir = dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(readFileSync(join(dir, 'model-profiles.json'), 'utf8'));
const source = process.argv[2];
let evidence;
let trustedSigners = {};
if (source) {
  const path = process.env.ATAX_SOCKET_TRUST_STORE;
  if (!path) throw new Error('UNTRUSTED_CALIBRATION: ATAX_SOCKET_TRUST_STORE is required for observation input');
  trustedSigners = JSON.parse(readFileSync(path, 'utf8'));
  evidence = JSON.parse(readFileSync(source, 'utf8'));
  if (!catalogue.profiles.some(p => p.provider === evidence.provenance?.provider && p.model === evidence.provenance?.model && p.tier === evidence.provenance?.tier)) {
    throw new Error('UNTRUSTED_CALIBRATION: evidence not bound to a catalogued provider/model/tier');
  }
}
const rows = catalogue.profiles.map(p => {
  let observed = null;
  if (evidence && evidence.provenance?.provider === p.provider && evidence.provenance?.model === p.model) {
    observed = deriveAttestedReliableCeiling(evidence, { trustedSigners, profile: p }, catalogue.policy.minReliabilityPassRate);
  }
  return { key: p.key, contextTokens: p.contextTokens, maxOutputTokens: p.maxOutputTokens,
    status: observed === null ? 'NOT_CALIBRATED' : 'CALIBRATED',
    ...determineCeiling(p, catalogue.policy, observed) };
});
console.log(JSON.stringify({ schemaVersion: 1, reviewedAt: catalogue.reviewedAt, rows }, null, 2));