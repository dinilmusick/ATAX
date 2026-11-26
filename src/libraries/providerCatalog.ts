export type ProviderCategory = 'infra' | 'compute' | 'inference';

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  category: ProviderCategory;
  apiKeyUrl: string;
  apiKeyLinkLabel: string;
  accountIdLabel?: string;
  accountIdPlaceholder?: string;
  tokenPlaceholder: string;
  hint: string;
  freeTierNote?: string;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // Core Infrastructure
  {
    id: 'github',
    label: 'GitHub',
    category: 'infra',
    apiKeyUrl: 'https://github.com/settings/tokens',
    apiKeyLinkLabel: 'Get GitHub Token',
    accountIdLabel: 'GitHub Owner / Organization',
    accountIdPlaceholder: 'owner-or-org',
    tokenPlaceholder: 'github_pat_... or ghp_...',
    hint: 'Used server-side for repository inspection, creation, and FMRL CI.',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    category: 'infra',
    apiKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    apiKeyLinkLabel: 'Get Cloudflare API Token',
    accountIdLabel: 'Cloudflare Account ID',
    accountIdPlaceholder: '32-character account identifier',
    tokenPlaceholder: 'Cloudflare API token...',
    hint: 'Used server-side for Workers & account diagnostics.',
  },

  // Cloud Compute (FRNES)
  {
    id: 'fly',
    label: 'Fly.io',
    category: 'compute',
    apiKeyUrl: 'https://fly.io/dashboard/personal/tokens',
    apiKeyLinkLabel: 'Get Fly.io Token',
    accountIdLabel: 'Fly App Name (optional)',
    accountIdPlaceholder: 'my-frnes-runner',
    tokenPlaceholder: 'FlyV1 ... or fo1_...',
    hint: 'MicroVM / container execution via Fly Machines API.',
    freeTierNote: 'Pay-as-you-go / legacy free allowance',
  },
  {
    id: 'render',
    label: 'Render',
    category: 'compute',
    apiKeyUrl: 'https://dashboard.render.com/u/settings#api-keys',
    apiKeyLinkLabel: 'Get Render API Key',
    accountIdLabel: 'Default Service ID (optional)',
    accountIdPlaceholder: 'srv-...',
    tokenPlaceholder: 'rnd_...',
    hint: 'One-off disposable jobs via Render Jobs API.',
    freeTierNote: 'Free web/job tier available',
  },
  {
    id: 'northflank',
    label: 'Northflank',
    category: 'compute',
    apiKeyUrl: 'https://app.northflank.com/settings/api',
    apiKeyLinkLabel: 'Get Northflank API Token',
    accountIdLabel: 'Default Project ID (optional)',
    accountIdPlaceholder: 'project-id',
    tokenPlaceholder: 'nf_...',
    hint: 'Container jobs via Northflank Jobs API.',
    freeTierNote: 'Free developer sandbox tier',
  },
  {
    id: 'railway',
    label: 'Railway',
    category: 'compute',
    apiKeyUrl: 'https://railway.com/account/tokens',
    apiKeyLinkLabel: 'Get Railway Token',
    accountIdLabel: 'Default Project ID (optional)',
    accountIdPlaceholder: 'project-uuid',
    tokenPlaceholder: 'Railway API token...',
    hint: 'Cloud agent & container tasks via Railway GraphQL API.',
    freeTierNote: 'Free trial / hobby tier',
  },
  {
    id: 'koyeb',
    label: 'Koyeb',
    category: 'compute',
    apiKeyUrl: 'https://app.koyeb.com/account/api',
    apiKeyLinkLabel: 'Get Koyeb API Token',
    accountIdLabel: 'Default App ID (optional)',
    accountIdPlaceholder: 'app-id',
    tokenPlaceholder: 'Koyeb API token...',
    hint: 'MicroVM / serverless containers via Koyeb API.',
    freeTierNote: 'Free starter nano service',
  },

  // AI Inference (from Aiko)
  {
    id: 'google',
    label: 'Google AI Studio',
    category: 'inference',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    apiKeyLinkLabel: 'Get Gemini API Key',
    tokenPlaceholder: 'AIza...',
    hint: 'Gemini models via Google AI Studio free tier.',
    freeTierNote: 'Generous free tier',
  },
  {
    id: 'groq',
    label: 'Groq',
    category: 'inference',
    apiKeyUrl: 'https://console.groq.com/keys',
    apiKeyLinkLabel: 'Get Groq API Key',
    tokenPlaceholder: 'gsk_...',
    hint: 'Ultra-fast Llama / Mixtral inference.',
    freeTierNote: 'Free rate-limited tier',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    category: 'inference',
    apiKeyUrl: 'https://cloud.cerebras.ai/',
    apiKeyLinkLabel: 'Get Cerebras API Key',
    tokenPlaceholder: 'csk-...',
    hint: 'High-throughput Llama inference.',
    freeTierNote: 'Free tier available',
  },
  {
    id: 'together',
    label: 'Together AI',
    category: 'inference',
    apiKeyUrl: 'https://api.together.xyz/settings/api-keys',
    apiKeyLinkLabel: 'Get Together API Key',
    tokenPlaceholder: 'Together API key...',
    hint: 'Open-weights models including free endpoints.',
    freeTierNote: 'Free models & starter credits',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    category: 'inference',
    apiKeyUrl: 'https://build.nvidia.com/',
    apiKeyLinkLabel: 'Get NVIDIA NIM Key',
    tokenPlaceholder: 'nvapi-...',
    hint: 'NVIDIA hosted NIM inference endpoints.',
    freeTierNote: 'Free developer credits',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    category: 'inference',
    apiKeyUrl: 'https://openrouter.ai/keys',
    apiKeyLinkLabel: 'Get OpenRouter Key',
    tokenPlaceholder: 'sk-or-...',
    hint: 'Unified router with :free model endpoints.',
    freeTierNote: 'Free :free models',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    category: 'inference',
    apiKeyUrl: 'https://huggingface.co/settings/tokens',
    apiKeyLinkLabel: 'Get Hugging Face Token',
    tokenPlaceholder: 'hf_...',
    hint: 'Serverless inference router for open models.',
    freeTierNote: 'Free monthly inference tier',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    category: 'inference',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    apiKeyLinkLabel: 'Get Anthropic Key',
    tokenPlaceholder: 'sk-ant-...',
    hint: 'Claude models via Anthropic Messages API.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'inference',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    apiKeyLinkLabel: 'Get OpenAI Key',
    tokenPlaceholder: 'sk-...',
    hint: 'GPT models via OpenAI Chat Completions API.',
  },
];

export const COMPUTE_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.category === 'compute');
export const INFERENCE_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.category === 'inference');
export const INFRA_PROVIDERS = PROVIDER_CATALOG.filter((p) => p.category === 'infra');

export function normalizeGroupAlias(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .slice(0, 48);
}
