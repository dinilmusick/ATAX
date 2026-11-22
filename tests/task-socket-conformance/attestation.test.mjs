import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, verifyCalibrationAttestation, deriveAttestedReliableCeiling } from './attestation.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const blob = readFileSync(join(dir, 'fixtures/calibration-synthetic.json'));
const gitBlobHash = createHash('sha1').update('blob ' + blob.length + '\0').update(blob).digest('hex');
const synthetic = JSON.parse(blob);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyId = 'agent-k-test-key';
const trustedSigners = { [keyId]: publicKey.export({ format: 'pem', type: 'spki' }).toString() };
const profile = { provider: 'google', model: 'fixture-model', tier: 'test-api' };
const now = new Date('2026-11-22T17:00:00Z');
const hex = 'a'.repeat(64);

function record() {
  const trials = [100, 100, 100, 200, 200, 200].map((budgetTokens, i) => ({
    budgetTokens, inputTokens: budgetTokens - 4, outputTokens: 4,
    success: true, responseId: 'response-' + i, promptSha256: hex,
    evaluation: { verifier: 'independent-observer', pass: true, outputSha256: hex }
  }));
  return { schemaVersion: 1, kind: 'provider-observation',
    provenance: { ...profile, apiVersion: 'test-v1', tokenizer: 'test-exact', executor: 'agent-author',
      independentVerifier: 'independent-observer', observedAt: '2026-11-22T16:00:00Z',
      responseIds: trials.map(t => t.responseId) }, trials };
}
function signed(value) {
  const unsigned = structuredClone(value);
  delete unsigned.attestation;
  return { ...unsigned, attestation: { algorithm: 'Ed25519', keyId, signedBy: 'independent-observer',
    signatureBase64: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') } };
}
const validate = evidence => verifyCalibrationAttestation(evidence, { trustedSigners, profile, atTime: now });

test('source fixture Git blob integrity is pinned to PR #1731', () => {
  assert.equal(gitBlobHash, '4341d7e76c6e92710a303d5a9816672c24ba4bb9');
  assert.equal(synthetic.kind, 'synthetic-training-example-not-provider-observation');
});
test('synthetic, unsigned and forged provider observations do not calibrate', () => {
  assert.throws(() => validate(synthetic), /UNTRUSTED_CALIBRATION/);
  assert.throws(() => validate(record()), /UNTRUSTED_CALIBRATION/);
  const forged = { ...record(), attestation: { algorithm: 'Ed25519', keyId, signedBy: 'independent-observer', signatureBase64: Buffer.alloc(64).toString('base64') } };
  assert.throws(() => validate(forged), /UNTRUSTED_CALIBRATION/);
});
test('properly signed TEST-only observations pass with contiguous threshold', () => {
  const evidence = signed(record());
  assert.equal(validate(evidence), true);
  assert.equal(deriveAttestedReliableCeiling(evidence, { trustedSigners, profile, atTime: now }), 200);
});
test('canonical signed bytes are independent of object key insertion order', () => {
  assert.equal(canonicalJson({ b: 2, a: { z: 1, x: 3 } }), canonicalJson({ a: { x: 3, z: 1 }, b: 2 }));
});
test('tampering token counts, results and metadata invalidates attestation', () => {
  for (const mutation of [
    x => x.trials[0].budgetTokens = 999,
    x => x.trials[0].outputTokens = 99,
    x => x.trials[0].success = false,
    x => x.provenance.model = 'different-model',
    x => x.provenance.observedAt = '2026-11-25T00:00:00Z',
    x => x.attestation.signatureBase64 = Buffer.alloc(64).toString('base64')
  ]) {
    const evidence = signed(record()); mutation(evidence);
    assert.throws(() => validate(evidence), /UNTRUSTED_CALIBRATION/);
  }
});
test('trust anchoring, freshness, trial identities and independent review are mandatory', () => {
  const r = record();
  assert.throws(() => verifyCalibrationAttestation(signed(r), { trustedSigners: {}, profile, atTime: now }), /untrusted signer/);
  assert.throws(() => verifyCalibrationAttestation(signed(r), { trustedSigners, profile, atTime: new Date('2027-01-22') }), /stale/);
  for (const mutation of [
    x => x.provenance.executor = 'independent-observer',
    x => x.trials[1].responseId = x.trials[0].responseId,
    x => x.trials[0].evaluation.verifier = 'agent-author',
    x => x.trials[0].evaluation.outputSha256 = '',
    x => x.trials[0].outputTokens = undefined,
    x => x.provenance.responseIds.pop()
  ]) {
    const evidence = record(); mutation(evidence);
    assert.throws(() => validate(signed(evidence)), /UNTRUSTED_CALIBRATION/);
  }
});
