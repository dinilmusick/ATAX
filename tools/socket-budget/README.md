# ATAX Socket V1 — Context Metering (Agent A)

Standalone JavaScript ESM, zero runtime dependencies. This directory is the ONLY writable scope of Agent A. **No MCP handler, Supabase migration, agent scheduling, or GitHub workflow execution is implemented here.**

## Interface

\`\`\`js
import { createSocketBudgetMeter } from './index.mjs';
const meter = createSocketBudgetMeter('task-socket-id', 'gpt-4o-mini', {
  reliabilityCeilingTokens: 12000, // measured lower operating ceiling
  inputLimitTokens: 8000,
  outputLimitTokens: 4000
});
const d = meter.chargeInput('tool result text');
if (!d.accepted) { /* do not expose payload to worker */ }
const output = meter.chargeOutput('agent-generated answer');
if (!output.accepted) { /* do not accept/forward output */ }
const snapshot = meter.snapshot();
\`\`\`

Exports: \`TOKENIZER_ID\`, \`PROFILE_SET_VERSION\`, \`UNKNOWN_CONTEXT_TOKENS\`, \`VERIFIED_MODELS\`, \`canonicalPayload\`, \`estimateTextTokens\`, \`resolveBudget\`, \`createSocketBudgetMeter\`. Pure preflight \`preview(direction,value,kind)\` is **not** authorization. Every actual transfer must call \`charge\` before releasing any bytes. \`kind='tool'\` counts canonical JSON \`{tool,payload}\`; other kinds throw. Never dedupe chunks, attempts, retries or requests.

Responses have \`status: allowed | approaching_limit | input_exceeded | output_exceeded\`, \`accepted\`, \`direction\`, \`chargedTokens\`, machine-readable \`reasons: input_quota | output_quota | combined_capacity\`, projections and \`accounting\`. State tracks accepted input/output, attempted input/output (including rejected transfers), rejected input/output, revisions and attempt counts. Rejected transfers are counted as attempted but do not consume accepted capacity.

## Profile policy and uncertainty

- Default maximum usable capacity = **floor(40% of explicitly documented model context)**. Reliability ceilings and caller limits can only reduce this figure.
- Unknown/unrecognised/chat-plan models use an **unverified 8,192-token context assumption**, yielding a conservative 3,276-token usable maximum. This is an operational safety fallback, not a claim about the actual context window.
- Default directional reservations = 75% input / 25% output of the combined budget. Combined quota remains authoritative even with custom larger directional reservations. At or above 80% of any limit, admission returns \`approaching_limit\`.
- Verified IDs are exact and revision-sensitive; do not fuzzy-match aliases or assume browser subscriptions share API windows. Capacity sources (as checked 2026-11-22): [OpenAI GPT-4o mini](https://platform.openai.com/docs/models/gpt-4o-mini), [Anthropic model overview](https://docs.anthropic.com/en/docs/about-claude/models/overview), [Gemini models](https://ai.google.dev/gemini-api/docs/models), [xAI Grok 4.7](https://docs.x.ai/developers/grok-4-7). Confirm a provider/version's current window before upgrading profiles. Low-end Cerebras and subscription-tier models not formally verified remain unknown models.
- Pinned estimator \`utf8-byte-upper-bound-v1\`: one token charged per UTF-8 byte plus **8 tokens per transfer** for envelope uncertainty. This deliberately overcounts common byte-based tokenizer text relative to actual model tokens and is deterministic across JavaScript engines with standards-compliant \`TextEncoder\`. It is **not** the exact Gemini/Claude/OpenAI/xAI tokenizer, nor proof of capacity for hidden reasoning/system/tool/image/audio overhead. Calibrate a *lower* ceiling from real provider usage and observed failure behavior; otherwise remain conservative. For non-text/multimodal provider payloads not expressible as plain JSON, **reject** and use a separate verified provider-aware metering adapter. Internal hidden reasoning, repeated full-prefix requests, cached payload re-sends and provider overhead must also be charged by the caller if transmitted/observed.
- Inputs containing cyclic, binary, non-finite or non-JSON values are rejected rather than undercounted. UTF-8 string length counts Unicode byte width, including replacement encoding of malformed UTF-16.

## MCP / database integration contract (future Agents B–E)

The gateway must own each fenced socket's durable snapshot. For **each input/tool payload/output**, including retries and repeated messages:

1. Check \`task_id + agent_id + claim_token + unexpired_lease\` in canonical Supabase. Never use chat/vendor identity as the fence.
2. Determine payload kind; meter the exact serialized content and framing before any data egress/ingress. Run \`charge\` synchronously. Do not rely on \`preview\` to authorize delivery.
3. Atomically compare-and-swap \`revision\` (or lock the row) and persist the **entire returned accounting snapshot**, including denied attempts, under the SAME canonical fence. A failed compare-and-swap requires rehydration and re-metering, never an automatic retry with reset state.
4. Only after successful fenced persistence and \`accepted=true\` release the input bytes or accept the output. A rejected attempt must not expose/accept the excess content. Preserve denied attempts for accounting and overflow analysis.
5. Resume from last committed snapshot on reconnect, retry or new request. A new task socket starts at zero; an existing socket does not. Never trust the caller to supply a smaller restored snapshot.
6. Enforce separate provider-side request/output and actual token-usage caps where available; native usage is an *additional* independent guard, not an excuse to discard byte-based cumulative counts.

This is a **reference in-memory meter**, NOT a distributed transaction manager. Cross-process concurrency, token-bearing authenticated mutations and server-side authorization belong to the gateway and DB adapter. Failing open on a persistence error violates the contract. Independent reviewer must verify gateway integration separately.

## Tests

\`\`\`sh
node --test tools/socket-budget/index.test.mjs
\`\`\`

Tests cover cumulative chunks, retry accounting, direction and combined overflow, unknown models, calibration, Unicode, canonical tool serialization, stale revisions, restore integrity, envelope accounting and malformed data. No network or provider credentials required.

**Task ledger note:** This bootstrap implementation must not be mistaken for a ready executor loop contract. Contract authoring remains independent; do not set \`loop_script_status=ready\` from this implementation agent. Independent verification and final reconciliation remain external.
