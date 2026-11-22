// Pure policy functions, not a provider tokenizer. Token counts are supplied by an
// independently attested tokenizer or by a deterministic mock in conformance tests.
export function determineCeiling(profile, policy, observed = null) {
  const positiveInt = value => Number.isSafeInteger(value) && value > 0;
  if (!positiveInt(policy.unknownModelFallbackTokens) || !(policy.defaultContextFraction > 0 && policy.defaultContextFraction <= 0.4)) {
    throw new RangeError('unsafe policy');
  }
  if (!positiveInt(policy.systemReserveTokens) || !positiveInt(policy.generationReserveTokens) || !positiveInt(policy.unknownOutputFallbackTokens)) throw new RangeError('invalid reserves');
  const exact = positiveInt(profile?.contextTokens) ? profile.contextTokens : null;
  const fractionCap = exact === null ? policy.unknownModelFallbackTokens : Math.floor(exact * policy.defaultContextFraction);
  // Reserve applies against context, but 40% remains a hard maximum even if the reserve is smaller.
  const reserveCap = exact === null ? policy.unknownModelFallbackTokens : Math.max(0, exact - policy.systemReserveTokens - policy.generationReserveTokens);
  const measured = observed ?? profile?.reliableCeilingTokens;
  if (measured !== null && measured !== undefined && !positiveInt(measured)) throw new RangeError('invalid reliability cap');
  const usable = Math.min(fractionCap, reserveCap, measured ?? Number.MAX_SAFE_INTEGER);
  const providerOutput = positiveInt(profile?.maxOutputTokens) ? profile.maxOutputTokens : null;
  const outputLimit = Math.min(usable, providerOutput ?? policy.unknownOutputFallbackTokens);
  if (!positiveInt(usable) || !positiveInt(outputLimit)) throw new RangeError('no usable budget');
  return { usableTokens: usable, inputLimitTokens: usable, outputLimitTokens: outputLimit,
    maxOutputTokens: providerOutput,
    source: exact === null ? 'unknown-exact-context-fallback' : 'verified-provider-window',
    empirical: measured === null || measured === undefined ? 'not-measured' : 'measured' };
}

// Probe evidence must be externally collected. Never infer live reliability from synthetic fixtures.
export function deriveReliableCeiling(record, minimumPassRate = 1) {
  if (record?.kind !== 'provider-observation' || !record.provenance?.provider || !record.provenance?.model ||
      !record.provenance?.observedAt || !record.provenance?.responseIds?.length || !record.provenance?.tokenizer) {
    throw new Error('missing independently reproducible provider evidence');
  }
  if (!(minimumPassRate > 0 && minimumPassRate <= 1)) throw new RangeError('pass rate');
  if (!Array.isArray(record.trials) || !record.trials.length) throw new Error('missing trials');
  const groups = new Map();
  for (const trial of record.trials) {
    if (!Number.isSafeInteger(trial.budgetTokens) || trial.budgetTokens <= 0 ||
        typeof trial.success !== 'boolean' || !trial.responseId) throw new Error('invalid trial');
    if (!record.provenance.responseIds.includes(trial.responseId)) throw new Error('unreferenced response');
    const g = groups.get(trial.budgetTokens) ?? [];
    g.push(trial); groups.set(trial.budgetTokens, g);
  }
  const ordered = [...groups].sort(([a], [b]) => a - b);
  let ceiling = null;
  for (const [budget, trials] of ordered) {
    if (trials.length < 3 || trials.filter(t => t.success).length / trials.length < minimumPassRate) break;
    ceiling = budget;
  }
  return ceiling; // null = not calibrated; never silently fall back to a claimed reliable value
}