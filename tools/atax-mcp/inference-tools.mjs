/** Aiko-aligned AI inference providers with usage-based weighted account rotation and failover. */
import { isOwnerPrincipal } from './provider-accounts.mjs';
import {
  getAccountUsage,
  rankWeightedAccounts,
  recordAccountUsage,
  selectWeightedAccount,
} from './weighted-rotation.mjs';

const AI_PREFIX = 'AI_KEY_';
const AI_JSON = 'AI_INFERENCE_ACCOUNTS_JSON';
const ALIAS = /^[A-Z][A-Z0-9_]{0,47}$/;
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

export const AI_PROVIDER_ENDPOINTS = Object.freeze({
  google: {
    name: 'Google AI Studio',
    defaultModel: 'gemini-2.5-flash',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    format: 'google',
    isFreeTier: true,
  },
  groq: {
    name: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    apiKeyUrl: 'https://console.groq.com/keys',
    format: 'openai',
    isFreeTier: true,
  },
  cerebras: {
    name: 'Cerebras',
    defaultModel: 'llama-3.3-70b',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    apiKeyUrl: 'https://cloud.cerebras.ai/',
    format: 'openai',
    isFreeTier: true,
  },
  together: {
    name: 'Together AI',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    url: 'https://api.together.xyz/v1/chat/completions',
    apiKeyUrl: 'https://api.together.xyz/settings/api-keys',
    format: 'openai',
    isFreeTier: true,
  },
  nvidia: {
    name: 'NVIDIA NIM',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKeyUrl: 'https://build.nvidia.com/',
    format: 'openai',
    isFreeTier: true,
  },
  openrouter: {
    name: 'OpenRouter',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyUrl: 'https://openrouter.ai/keys',
    format: 'openai',
    isFreeTier: true,
  },
  huggingface: {
    name: 'Hugging Face',
    defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    url: 'https://router.huggingface.co/v1/chat/completions',
    apiKeyUrl: 'https://huggingface.co/settings/tokens',
    format: 'openai',
    isFreeTier: true,
  },
  anthropic: {
    name: 'Anthropic',
    defaultModel: 'claude-3-5-haiku-latest',
    url: 'https://api.anthropic.com/v1/messages',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    format: 'anthropic',
    isFreeTier: false,
  },
  openai: {
    name: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    url: 'https://api.openai.com/v1/chat/completions',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    format: 'openai',
    isFreeTier: false,
  },
});

export const INFERENCE_PROVIDER_IDS = Object.freeze(Object.keys(AI_PROVIDER_ENDPOINTS));

const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const tool = (name, description, scope, inputSchema, invoke) => ({
  name,
  description,
  scope,
  inputSchema,
  invoke,
});

function parseInferenceJsonEntries(env) {
  if (typeof env?.[AI_JSON] !== 'string' || !env[AI_JSON].trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(env[AI_JSON]);
  } catch {
    throw new Error('Invalid AI inference account configuration');
  }
  if (!Array.isArray(parsed)) throw new Error('Invalid AI inference account configuration');
  return parsed;
}

export function configuredInferenceAccounts(env, providerId) {
  if (!Object.prototype.hasOwnProperty.call(AI_PROVIDER_ENDPOINTS, providerId)) {
    throw new Error('Unknown AI inference provider');
  }
  const prefix = AI_PREFIX + providerId.replace(/-/g, '_') + '__';
  const accounts = new Map();
  for (const item of parseInferenceJsonEntries(env)) {
    if (!item || typeof item !== 'object' || item.providerId !== providerId || typeof item.alias !== 'string' || typeof item.token !== 'string') {
      continue;
    }
    const alias = item.alias.toUpperCase();
    if (!ALIAS.test(alias) || !item.token.trim()) continue;
    if (accounts.has(alias)) throw new Error('Duplicate AI inference account alias: ' + alias);
    accounts.set(alias, {
      providerId,
      alias,
      token: item.token,
      weight: typeof item.weight === 'number' && Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1,
      remainingFraction: typeof item.remainingFraction === 'number' ? item.remainingFraction : null,
    });
  }
  for (const key of Object.keys(env || {})) {
    if (!key.startsWith(prefix)) continue;
    const alias = key.slice(prefix.length);
    if (ALIAS.test(alias) && typeof env[key] === 'string' && env[key].trim()) {
      if (accounts.has(alias)) throw new Error('Duplicate AI inference account alias: ' + alias);
      accounts.set(alias, {
        providerId,
        alias,
        token: env[key],
        weight: 1,
        remainingFraction: null,
      });
    }
  }
  return accounts;
}

export function availableInferenceAccounts(env, principal, providerId) {
  if (!Object.prototype.hasOwnProperty.call(AI_PROVIDER_ENDPOINTS, providerId) || !isOwnerPrincipal(env, principal)) {
    return [];
  }
  return [...configuredInferenceAccounts(env, providerId).keys()].sort();
}

export function listInferenceProviders(env, principal) {
  const authorized = isOwnerPrincipal(env, principal);
  return INFERENCE_PROVIDER_IDS.map((providerId) => {
    const meta = AI_PROVIDER_ENDPOINTS[providerId];
    const aliases = authorized ? availableInferenceAccounts(env, principal, providerId) : [];
    return {
      providerId,
      name: meta.name,
      defaultModel: meta.defaultModel,
      apiKeyUrl: meta.apiKeyUrl,
      isFreeTier: meta.isFreeTier,
      aliases,
      accounts: aliases.map((alias) => {
        const stats = getAccountUsage(providerId, alias);
        return {
          alias,
          totalCalls: stats.totalCalls,
          successfulCalls: stats.successfulCalls,
          failedCalls: stats.failedCalls,
          inCooldown: stats.cooldownUntil > Date.now(),
        };
      }),
    };
  });
}

async function callInferenceProvider(candidate, { prompt, system, model, temperature, maxTokens }, fetcher) {
  const spec = AI_PROVIDER_ENDPOINTS[candidate.providerId];
  if (!spec) throw new Error('Unsupported AI inference provider');
  const targetModel = model || spec.defaultModel;
  if (!MODEL_ID.test(targetModel)) throw new Error('Invalid model identifier');

  let url;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'atax-mcp-inference',
  };
  let body;

  if (spec.format === 'google') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent`;
    headers['x-goog-api-key'] = candidate.token;
    body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
      },
    };
  } else if (spec.format === 'anthropic') {
    url = spec.url;
    headers['x-api-key'] = candidate.token;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: targetModel,
      max_tokens: maxTokens ?? 1024,
      ...(system ? { system } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      messages: [{ role: 'user', content: prompt }],
    };
  } else {
    url = spec.url;
    headers.authorization = 'Bearer ' + candidate.token;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    body = {
      model: targetModel,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    };
  }

  const res = await fetcher(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(45000),
    headers,
    body: JSON.stringify(body),
  });

  if (res.status >= 300 && res.status < 400) {
    throw Object.assign(new Error('Inference provider redirect rejected'), { status: res.status });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw Object.assign(new Error(`Inference provider returned HTTP ${res.status}`), {
      status: res.status,
      rateLimited: res.status === 429,
    });
  }

  let text = '';
  if (spec.format === 'google') {
    text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
  } else if (spec.format === 'anthropic') {
    text = String(data?.content?.[0]?.text ?? '');
  } else {
    text = String(data?.choices?.[0]?.message?.content ?? '');
  }
  if (!text) throw new Error('Inference provider returned empty completion');

  return {
    providerId: candidate.providerId,
    alias: candidate.alias,
    model: targetModel,
    text: text.slice(0, 65536),
  };
}

export async function executeWeightedInference(args, principal, env, fetcher) {
  if (!isOwnerPrincipal(env, principal)) {
    throw new Error('Inference account unavailable or not authorized');
  }
  const requestedProvider = args.providerId ? String(args.providerId).trim().toLowerCase() : null;
  const requestedAlias = args.alias ? String(args.alias).trim().toUpperCase() : null;
  if (requestedAlias && !ALIAS.test(requestedAlias)) {
    throw new Error('Invalid inference account alias');
  }

  const providerList = requestedProvider
    ? [requestedProvider]
    : INFERENCE_PROVIDER_IDS.filter((id) => args.includePaid === true || AI_PROVIDER_ENDPOINTS[id].isFreeTier);

  const candidates = [];
  for (const pid of providerList) {
    if (!Object.prototype.hasOwnProperty.call(AI_PROVIDER_ENDPOINTS, pid)) {
      throw new Error('Unknown AI inference provider');
    }
    const map = configuredInferenceAccounts(env, pid);
    for (const acc of map.values()) {
      if (!requestedAlias || acc.alias === requestedAlias) {
        candidates.push(acc);
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error('No enabled AI inference accounts configured for the requested provider or group');
  }

  const primary = selectWeightedAccount(candidates);
  const ordered = [
    primary,
    ...rankWeightedAccounts(candidates)
      .map((x) => x.candidate)
      .filter((c) => !(c.providerId === primary.providerId && c.alias === primary.alias)),
  ];

  const failoverChain = [];
  let lastError = null;
  for (const candidate of ordered) {
    try {
      const result = await callInferenceProvider(candidate, args, fetcher);
      recordAccountUsage(candidate.providerId, candidate.alias, { ok: true });
      return {
        ...result,
        failoverChain: [...failoverChain, `${candidate.providerId}:${candidate.alias}`],
      };
    } catch (err) {
      const rateLimited = Boolean(err?.rateLimited || err?.status === 429);
      recordAccountUsage(candidate.providerId, candidate.alias, { ok: false, rateLimited });
      failoverChain.push(`${candidate.providerId}:${candidate.alias}:failed`);
      lastError = err;
    }
  }

  throw lastError || new Error('All AI inference accounts failed');
}

export const inferenceTools = [
  tool(
    'atax_inference_providers',
    'List configured AI inference providers, group aliases, signup/API key URLs, and usage rotation stats without exposing credentials.',
    'atax:read',
    schema({}),
    (_a, _db, p, ctx) => ({ providers: listInferenceProviders(ctx.env, p) })
  ),
  tool(
    'atax_inference_execute',
    'Run AI inference using Aiko-aligned providers and usage-based weighted account rotation with automatic failover.',
    'atax:write',
    schema(
      {
        prompt: { type: 'string', minLength: 1, maxLength: 32000 },
        system: { type: 'string', minLength: 1, maxLength: 8192 },
        providerId: { type: 'string', minLength: 1, maxLength: 64 },
        alias: { type: 'string', minLength: 1, maxLength: 48 },
        model: { type: 'string', minLength: 1, maxLength: 128 },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        maxTokens: { type: 'integer', minimum: 1, maximum: 8192 },
        includePaid: { type: 'boolean' },
      },
      ['prompt']
    ),
    async (a, _db, p, ctx) => executeWeightedInference(a, p, ctx.env, ctx.fetcher)
  ),
];
