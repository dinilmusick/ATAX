/** Usage-based weighted account rotation for both cloud compute and AI inference. */

const usageState = new Map();
const COOLDOWN_MS = 60_000;

function keyFor(providerId, alias) {
  return `${String(providerId).toLowerCase()}:${String(alias).toUpperCase()}`;
}

export function getAccountUsage(providerId, alias) {
  const k = keyFor(providerId, alias);
  return usageState.get(k) || {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    consecutiveErrors: 0,
    remainingFraction: null,
    lastUsedAt: 0,
    cooldownUntil: 0,
  };
}

export function recordAccountUsage(providerId, alias, { ok = true, rateLimited = false, remainingFraction = null } = {}, now = Date.now()) {
  const k = keyFor(providerId, alias);
  const prev = getAccountUsage(providerId, alias);
  const next = {
    totalCalls: prev.totalCalls + 1,
    successfulCalls: prev.successfulCalls + (ok ? 1 : 0),
    failedCalls: prev.failedCalls + (ok ? 0 : 1),
    consecutiveErrors: ok ? 0 : prev.consecutiveErrors + 1,
    remainingFraction: typeof remainingFraction === 'number' && Number.isFinite(remainingFraction)
      ? Math.min(1, Math.max(0, remainingFraction))
      : prev.remainingFraction,
    lastUsedAt: now,
    cooldownUntil: rateLimited ? now + COOLDOWN_MS : (ok ? 0 : prev.cooldownUntil),
  };
  usageState.set(k, next);
  return next;
}

export function resetAccountUsage() {
  usageState.clear();
}

export function computeEffectiveWeight(candidate, now = Date.now()) {
  const stats = getAccountUsage(candidate.providerId, candidate.alias);
  if (stats.cooldownUntil > now) return 0;

  const baseWeight = typeof candidate.weight === 'number' && Number.isFinite(candidate.weight) && candidate.weight > 0
    ? candidate.weight
    : 1;

  const remaining = typeof candidate.remainingFraction === 'number' && Number.isFinite(candidate.remainingFraction)
    ? Math.min(1, Math.max(0.05, candidate.remainingFraction))
    : stats.remainingFraction !== null
      ? Math.max(0.05, stats.remainingFraction)
      : 1;

  const errorPenalty = 1 / (1 + stats.consecutiveErrors);
  // Gently spread traffic across accounts as totalCalls increases.
  const usageSpread = 1 / (1 + stats.totalCalls * 0.25);

  return baseWeight * remaining * errorPenalty * usageSpread;
}

export function rankWeightedAccounts(candidates, now = Date.now()) {
  const scored = candidates.map((c) => ({
    candidate: c,
    weight: computeEffectiveWeight(c, now),
  }));
  const positive = scored.filter((x) => x.weight > 0);
  if (positive.length > 0) {
    return positive.sort((a, b) => b.weight - a.weight);
  }
  // If all accounts are in cooldown, fall back to least-recently-used so caller gets a deterministic order.
  return scored.sort((a, b) =>
    getAccountUsage(a.candidate.providerId, a.candidate.alias).lastUsedAt -
    getAccountUsage(b.candidate.providerId, b.candidate.alias).lastUsedAt
  );
}

export function selectWeightedAccount(candidates, sample, now = Date.now()) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const ranked = rankWeightedAccounts(candidates, now);
  const totalWeight = ranked.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return ranked[0].candidate;

  const draw = typeof sample === 'number' && Number.isFinite(sample)
    ? Math.min(0.999999999, Math.max(0, sample))
    : crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

  let threshold = draw * totalWeight;
  for (const item of ranked) {
    threshold -= item.weight;
    if (threshold <= 0) return item.candidate;
  }
  return ranked[0].candidate;
}
