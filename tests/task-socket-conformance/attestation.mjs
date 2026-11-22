// Agent K: fail-closed validation of OFFLINE evidence envelopes.
// A valid signature authenticates a trusted observer, not the truth of a provider claim.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { deriveReliableCeiling } from './calibration.mjs';

export const ATTESTATION_VERSION = 1;
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('non-JSON value in signed evidence');
  }
  return JSON.stringify(value);
}
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const integer = v => Number.isSafeInteger(v) && v > 0;
const reject = message => { throw new Error('UNTRUSTED_CALIBRATION: ' + message); };

export function verifyCalibrationAttestation(record, { trustedSigners, profile, atTime = new Date(), maxAgeDays = 30 } = {}) {
  if (!record || record.kind !== 'provider-observation' || record.schemaVersion !== ATTESTATION_VERSION) reject('unsupported record');
  const p = record.provenance;
  if (!p || !nonempty(p.provider) || !nonempty(p.model) || !nonempty(p.tier) ||
      !nonempty(p.apiVersion) || !nonempty(p.tokenizer) || !nonempty(p.executor) ||
      !nonempty(p.independentVerifier) || !nonempty(p.observedAt)) reject('incomplete provenance');
  if (p.executor === p.independentVerifier) reject('self-evaluation');
  if (!profile || p.provider !== profile.provider || p.model !== profile.model || p.tier !== profile.tier) reject('model/tier mismatch');
  const observed = Date.parse(p.observedAt);
  const current = new Date(atTime).getTime();
  if (!Number.isFinite(observed) || !Number.isFinite(current) || !(maxAgeDays > 0) ||
      observed > current || current - observed > maxAgeDays * 86400000) reject('stale or future observation');
  if (!Array.isArray(record.trials) || record.trials.length < 3 ||
      !Array.isArray(p.responseIds) || p.responseIds.length !== record.trials.length) reject('incomplete trials');
  const seen = new Set();
  for (const t of record.trials) {
    if (!integer(t.budgetTokens) || !integer(t.inputTokens) || !Number.isSafeInteger(t.outputTokens) ||
        t.outputTokens < 0 || typeof t.success !== 'boolean' || !nonempty(t.responseId) ||
        !/^[a-f0-9]{64}$/i.test(t.promptSha256 ?? '') || !t.evaluation ||
        t.evaluation.verifier !== p.independentVerifier ||
        typeof t.evaluation.pass !== 'boolean' || t.evaluation.pass !== t.success ||
        !/^[a-f0-9]{64}$/i.test(t.evaluation.outputSha256 ?? '')) reject('unmeasured or unevaluated trial');
    // A passing trial cannot claim correctness outside its own token budget.
    // Failed trials may exceed it (for example an explicit overflow probe).
    if (t.success && (t.outputTokens === 0 || t.inputTokens + t.outputTokens > t.budgetTokens)) {
      reject('passing trial exceeds token budget or has no evaluated output');
    }
    if (seen.has(t.responseId)) reject('duplicate response ID');
    seen.add(t.responseId);
  }
  if (new Set(p.responseIds).size !== p.responseIds.length ||
      p.responseIds.some(id => !seen.has(id))) reject('response provenance mismatch');
  const a = record.attestation;
  if (!a || a.algorithm !== 'Ed25519' || !nonempty(a.keyId) ||
      a.signedBy !== p.independentVerifier || !nonempty(a.signatureBase64)) reject('missing signer attestation');
  const key = trustedSigners?.[a.keyId];
  if (!nonempty(key)) reject('untrusted signer');
  let ok = false;
  try {
    const { attestation: _discard, ...unsigned } = record;
    const canonical = Buffer.from(canonicalJson(unsigned), 'utf8');
    const raw = Buffer.from(a.signatureBase64, 'base64');
    ok = raw.length === 64 && verifySignature(null, canonical, createPublicKey(key), raw);
  } catch { ok = false; }
  if (!ok) reject('invalid signature or altered evidence');
  return true;
}

export function deriveAttestedReliableCeiling(record, options = {}, minimumPassRate = 1) {
  verifyCalibrationAttestation(record, options);
  return deriveReliableCeiling(record, minimumPassRate);
}
