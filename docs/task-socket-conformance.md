# ATAX Socket V1: independent model-tier and adversarial conformance (Agent E)

**Contract version:** `task-socket-v1.0.0`  
**Source revision basis:** `dinilmusick/ATAX` main, independent branch for issue #1727  
**Reviewed:** 2026-11-22  
**Authority:** canonical Supabase task `task-e-model-tier-and-adversarial-conformance-ee673c63`  
**Ownership:** `tests/task-socket-conformance/**`, `docs/task-socket-conformance.md` only.

## 1. Result and boundaries

The suite has zero network, API key, database, or application dependencies and uses Node.js built-in test/assert modules. It defines a *reference fake*, rather than presuming that A–D have completed production implementation. Passing this mock suite **does not certify the integrated ATAX gateway**, its database schema, controller, tokenizer, permission enforcement, or any real hosted provider. A final independent reconciler must supply an integration shim and run the same contract against real external dependencies before certifying Socket V1.

```sh
node --test tests/task-socket-conformance/*.test.mjs
node tests/task-socket-conformance/calibration-cli.mjs
# Against production adapter, added by the final reconciler (not required for standalone run):
ATAX_SOCKET_CONFORMANCE_ADAPTER=/absolute/path/integrated-shim.mjs node --test tests/task-socket-conformance/adapter-contract.test.mjs
```

No installation, live model invocation, or production file import occurs by default. An integrated shim should be isolated, use disposable test state, avoid real target writes, and clean up its fixtures. Only the shim resolves production API/RPC names to this implementation-independent contract.

## 2. Model profiles and evidence quality

See machine-readable `tests/task-socket-conformance/model-profiles.json` (schema version 1). **Context-window size, maximum output size, model access tier and measured reliability are distinct assertions.** We never infer one from another. Provider exact values are entered as numbers only when the primary vendor explicitly publishes exact figures. Rounded values, uncertain API entitlements and missing maxima are `null` with accompanying textual facts. `null` means *unverified*, not infinite.

| Provider / model reference | Published capacity | Tier constraint and certainty | Official evidence |
| --- | --- | --- | --- |
| Gemini API `gemini-2.5-flash-lite` | Input **1,048,576**; output **65,536** tokens | Gemini Developer API free tier is documented; subject to project and regional quotas | [Google model spec](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite), [Google pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Gemini API `gemini-2.5-flash` | Input **1,048,576**; output **65,536** tokens | Free-tier availability documented, not guaranteed for each API key or geography | [Google model spec](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash), [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Claude `claude-haiku-5-5` | Context **1M**, output **128K** (vendor rounded notation; exact numeric unknown) | API quota/free entitlement **not** established; Claude consumer free UI not equivalent to API use | [Anthropic Haiku overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview), [models overview](https://platform.claude.com/docs/en/models/overview) |
| OpenAI API `gpt-5.4-nano` | Context **400,000**, output **128,000** | API free entitlement **not** established; ChatGPT Free model and limits are app-managed, not interchangeable with the API | [OpenAI API model spec](https://developers.openai.com/api/docs/models/gpt-5.4-nano) |
| xAI API `grok-4.7` | Context **500,000**; exact model-specific max output **not verified** | API free entitlement **not** established; Grok consumer free tier is not a stable API capability contract | [xAI Grok 4.7 guide](https://docs.x.ai/developers/grok-4-7), [output best practices](https://docs.x.ai/developers/model-capabilities/text/best-practices) |
| Cerebras free-trial `gpt-oss-120b` | **65k free-trial / 131k paid** (rounded); output unknown | Free-trial access explicitly listed; precise runtime model limit must be probed | [Cerebras model catalog](https://inference-docs.cerebras.ai/models/overview) |
| Cerebras free-trial preview `gemma-4-31b` | **65k free-trial / 131k paid** (rounded); output unknown | Preview can be discontinued; must recheck before every release certification | [Cerebras model catalog](https://inference-docs.cerebras.ai/models/overview) |

**Observed limitation:** No provider credentials, account-specific entitlement inspection, paid quota access or live tokens-per-request records were available in this task. No empirical reliability or quota values have been produced or claimed. The local `model-profiles.json` deliberately stores `reliableCeilingTokens: null` for every provider. This is a **calibration coverage gap**, not a failure of deterministic offline conformance. New evidence should append a dated model/tier/version row; do not silently reinterpret an old version as the latest model. Model aliases and consumer-interface capacity may shift independently from API specifications.

## 3. Reproducible calibration protocol

Policy defaults are *ATAX-owned*, not vendor-advertised values: usable budget max **40%** of documented *exact* context capacity; system reserve **2,048**; generation reserve **4,096**; fallback for unknown exact capacity **4,096** total tokens; output fallback when exact output limit is unknown **1,024** tokens. These are conservative initial test parameters subject to review, not empirically measured limits. A real provider can have lower limits from application restrictions, rate limits, model updates or local transport constraints.

For profile context `C`, system reserve `S`, generation reserve `G`, measured reliably executable ceiling `R` (if independently proven):

```text
providerExact(C) ? maxContext = floor(0.40 × C) : maxContext = 4096
reserveCap = providerExact(C) ? max(0, C − S − G) : 4096
usable = min(maxContext, reserveCap, R if proven)
outputLimit = min(usable, providerMaxOutput if exact else 1024)
inputLimit = usable
cumulativeUsage = sum(all input and output chunks across request/retry/tool events)
accept iff cumulativeUsage <= usable AND individual output allowance <= outputLimit
```

These reserves are *not* subtracted again from the 40% slice, but they always reduce capacity if they bind. 40% is an upper cap, never a promise that the model can process that much accurately. Actual tokenizer usage must be measured with a model-compatible tokenizer or provider usage API, not estimated by byte or word count; fake tests inject exact synthetic token counts. Output policy includes reasoning and tool-visible output where provider accounting includes them. Fail closed if token accounting is missing or untrusted.

**Calibration steps:** (1) identify exact model ID, provider API version, access tier, account/region, provider-reported input and output limits, tokenizer/version, and timestamp; (2) run a deterministic context retrieval + tool-call + JSON-output + checksum task with 3+ attempts at each ascending budget (e.g. 10%, 20%, 30%, 40%), applying independent result checks, recording request IDs and prompt hashes; (3) include retransmission, interleaved tool responses, full output, and lease reconnect tests; (4) record truncation, API rejections, quota failures, context loss and correctness failures distinctly; (5) choose the highest contiguous fully passing candidate from the bottom; cap it by the 40%-reserve policy; (6) store provenance and re-run when model aliases or limits change. Do not use production secrets in fixtures.

The calibration utility reads an optional observation JSON and **rejects** a clearly labeled synthetic fixture. For real observation data it requires `kind: provider-observation`, `provenance` containing provider, model, observedAt, tokenizer, responseIds, and each trial to contain `budgetTokens`, boolean `success` and matching `responseId`. The minimum default sample count is 3 per threshold at 100% pass rate. This is a narrow data-validation and deterministic ceiling selection tool, **not** a statistical proof of reliability or live model metering. Account plan and rate limits should be measured independently. The fixture is intentionally marked synthetic, not passed off as observation data.

## 4. Mock adapter contract and observable state machine

`adapter-contract.mjs` exports `CONTRACT_VERSION = 'task-socket-v1.0.0'` and `registerAdapterConformance(createAdapter)`. `createAdapter({budget,maxPayloadBytes})` must provide methods with the same externally observable meaning as the mock: `createTask`, `claim`, `guard` (for mock), `pull`, `push`, `usage`, `reconnect`, `heartbeat`, `checkpoint`, `status`, `directTarget`, `readCredential`, `unrestrictedFetch`, `atomize`, `get`, `requestWorkflow`, `dispatchAck`, `dispatchFinish`, `submit`, `verify`, `finalizeParent` and test-clock `tick`. Adapter methods may return values or promises, but must issue stable error codes. Production adapters should map real RPC responses to these names; they must not load, fork or patch this mock.

```text
queued ──claim(fenced principal/session/task)──> running
running ──bounded pull/push + append meter──> running
running ──any direction exceeds cumulative cap──> stopped_overflow
stopped_overflow ──independent planner, CAS, validated children──> atomized
atomized ──child claim by different incoming actor──> children.running
child.running ──pinned delegated job request/ack/terminal evidence──> pending_verification
pending_verification ──distinct verifier, evidence checked──> completed
atomized parent ──all children independently verified + separate final auditor──> completed
```

- **Fence:** every tool invocation binds authenticated principal, task ID, session ID, capability scope and unexpired claim token. Reconnection never resets meter. Missing/stale/forged principal and tokens fail closed; lease expiry forfeits only the old task, not the external agent.
- **Budget:** every input chunk, output chunk, duplicate tool payload, failed attempt and retry is an append-only consumption event. The sum is cumulative; separate counters are preserved. Overflow event itself is recorded, then the socket is non-executable. Exceeding the output provider maximum independently of the combined budget must also fail.
- **Atomization:** an independently identified planner produces at least two atomic children, each with bounded actions (1–4), typed input/output, explicit dependencies, one measurable acceptance outcome, independent verification contract and provenance of partial parent results. Validate the entire child graph and perform parent stop → child insert → release atomically under version/fencing checks. Parent can no longer execute its original task. Concurrent planners must not create duplicate children.
- **Execution:** no task-bound principal may read raw credentials, push code, edit the target directly or invoke unbounded web/API capabilities. Delegate only approved operation + target + immutable revision + input/output contract + correlation + idempotency + valid claim. Durable outbox, retries, independent terminal reconciliation and bounded results are required. The mock deliberately does *not* create external GitHub runs.
- **Completion:** a runner acknowledgment is not success. A successful bounded delegated result can only move a valid running child to `pending_verification`; a different verifier checks acceptance before completion. Parent completion requires verified children. Never self-certify.

### Stable required error codes

`CONTEXT_OVERFLOW`, `NOT_EXECUTABLE`, `STALE_OR_FORGED_CLAIM`, `IDENTITY_REQUIRED`, `DIRECT_TARGET_ACCESS_FORBIDDEN`, `RAW_CREDENTIAL_FORBIDDEN`, `UNRESTRICTED_API_FORBIDDEN`, `INDEPENDENT_PLANNER_REQUIRED`, `CONCURRENT_SPLIT_CONFLICT`, `INVALID_CHILD_CONTRACT`, `DEPENDENCY_CYCLE`, `DEPENDENCY_UNVERIFIED`, `SEPARATE_AGENT_REQUIRED`, `UNAUTHORIZED_TARGET_OR_REVISION`, `INVALID_WORKFLOW_CONTRACT`, `OVERSIZED_WORKFLOW_REQUEST`, `OVERSIZED_EXECUTION_RESULT`, `DISPATCH_CORRELATION_MISMATCH`, `IDEMPOTENCY_COLLISION`, `DISPATCH_NOT_COMPLETE`, `INDEPENDENT_VERIFIER_REQUIRED`, `CHILDREN_NOT_VERIFIED` and `NOT_PENDING_VERIFICATION`. Adapters may add codes, but must not report success or mutate durable state where one of the specified rejection cases applies.

## 5. Negative and adversarial matrix

| Case | Expected failure | Observable required evidence |
| --- | --- | --- |
| Cumulative chunked input exceeds cap | `CONTEXT_OVERFLOW` then `NOT_EXECUTABLE` | Consumption ledger includes **every** attempt and overage |
| Cumulative output generation exceeds cap | `CONTEXT_OVERFLOW` then `NOT_EXECUTABLE` | Output counter includes the rejected chunk |
| Replayed chunk or repeated retried tool response | No quota discount | Monotone meter and repeated entries |
| Reconnect with same claimant | No meter reset | Identical durable counters |
| Reconnect with forged session/fence/principal | `STALE_OR_FORGED_CLAIM` | No target mutation or new meter state |
| Lease expiration, agent takeover | Old fence rejected | New claimant fence differs, prior consumption retained |
| Direct repository write or raw provider secret request | `DIRECT_TARGET_ACCESS_FORBIDDEN` / `RAW_CREDENTIAL_FORBIDDEN` | No target writes or credentials disclosed |
| Same agent authorizes own parent atomization | `INDEPENDENT_PLANNER_REQUIRED` | Parent still stopped, no child side effects |
| Two concurrent atomizers | Single winner; loser `CONCURRENT_SPLIT_CONFLICT`/`NOT_STOPPED` | Exactly one child set and one provenance record |
| Child lacks independently checkable acceptance or circular dependency | `INVALID_CHILD_CONTRACT` / `DEPENDENCY_CYCLE` | No partial child insertion |
| Parent's original agent tries child execution | `SEPARATE_AGENT_REQUIRED` | Child remains unclaimed |
| Unauthorized target or mutable revision | `UNAUTHORIZED_TARGET_OR_REVISION` | No outbox request |
| Mismatched job correlation or replay with changed payload | `DISPATCH_CORRELATION_MISMATCH` / `IDEMPOTENCY_COLLISION` | No forged acknowledgment |
| Oversized worker result or failed workflow | `OVERSIZED_EXECUTION_RESULT` / `DISPATCH_NOT_COMPLETE` | Task cannot claim success |
| Executor attempts to self-verify | `INDEPENDENT_VERIFIER_REQUIRED` | `pending_verification` persists |
| Parent finalized while children unfinished | `CHILDREN_NOT_VERIFIED` | Parent remains atomized |

**Expected failures report:** With only standalone mocks present, all tests should pass. On integrated implementation, the following are intentional **RED** gates until proven externally: real provider window calibration for unknown profiles, actual token accounting of input *and* generated output, Supabase transactional split and concurrent writer fences, production gateway principal enforcement, target-job GitHub dispatch and independently reconciled terminal evidence. A test simply not executed is `NOT_RUN`, never a pass. All unknown observations remain open blockers to **production certification**, not to delivery of this standalone test artifact.

## 6. Final reconciler certification gates

1. **Standalone (this PR):** all tests pass in fresh Node 20+ environment with no dependencies; no production source imports; only owned paths changed; source review and deterministic scenario coverage established.
2. **Database:** run boundary/concurrency tests against disposable Supabase tasks; assert append-only token events, valid fences, single atomic split, no stale writes, rejected self-verification, preserved parent evidence. Never use the canonical production task as a mutation test fixture.
3. **Gateway:** run equivalent tests against authenticated task-bound MCP sockets; verify every request rejects forged task/session/capability and raw credentials. Inspect outbound tool catalogs for direct mutation and unrestricted fetch paths.
4. **Controller:** dispatch a benign pinned test operation to a disposable target, verify outbox, idempotency, correlation, delayed acknowledgment, retry, terminal result reconciliation, payload limits and no secret exposure. Fail if GitHub Actions cannot be dispatched live.
5. **Model tiers:** verify each explicitly supported API model/tier with actual provider metadata and 3+ calibrated trials per threshold, including output/truncation; record the exact model version and empirical ceiling. Keep consumer free-app entitlements separate from APIs. No certification for unprobed model/version combinations.
6. **Independence:** separate author, atomizer/planner, child executor, result verifier and final certification roles; compare actor IDs plus claim fences in durable logs. Re-run one deliberately faulty adapter to establish negative-case sensitivity.
7. **Evidence and release:** attach command transcripts, provider records (redacted), immutable job revision, artifact hashes, tracked exceptions, issue/PR links and independent reviewer verdict to the canonical Supabase task. Release is **PASS only if every applicable gate is evidenced**; otherwise `FAIL` or `NOT_RUN` with explicit blockers. Agent E must not merge this PR or self-verify it.

### Known limitation: mock versus integrated

Mocks prove contract logic is testable and that the test cases detect violations in the reference oracle, not that any live controller meets the contract. This Agent E deliverable deliberately does not modify the Agents A–D production gateway, database or workflows. Final integration is a separate independently verified task.
## 7. Independent Agent K hardening of source PR #1731

Source HEAD pinned for review: 896ce4a18396d64fe9a4d14afaa38cb3fb8ae29e, 2026-11-22. Canonical Agent K task: task-k-certify-model-tier-conformance-fixture-and-integrated-5ccfd45a; issue #1738.

### Evidence categories (never conflate)

- SOURCE_REPLAY_PASS: 27/27 original source tests passed in an independently assembled isolated V8 source-function harness at the exact pinned blob SHAs. This was NOT a native Node test runner execution.
- NODE_NATIVE_PARTIAL: The newly added attestation.test.mjs passed 6/6 cases under Node 22.16.0 in a local reproduction. The attestation module (Git blob b1b9782a...), test file (d2e7c1ca...), and pinned synthetic fixture (4341d7e7...) were individually matched to the remote Git blob hashes. The local calibration.mjs dependency copy had equivalent reviewed logic but was not blob-identical. Therefore the full native checkout execution remains NOT_RUN; unrelated successful CI workflows cannot substitute for it.
- MOCK_ONLY: The added attestation tests sign fake observations using ephemeral locally generated keys. They do not measure providers or establish quota access.
- LIVE_PROVIDER / DATABASE / MCP_GATEWAY / GITHUB_ACTIONS: NOT_RUN until an independent actor executes real disposable integration tests and attaches records. Never promote an unrun gate to PASS.

### Signed calibration evidence: schema v1

The earlier pure deriveReliableCeiling helper is a threshold computation, not evidence authentication. The Agent K attestation module validates independent Ed25519 signing before the calibration CLI will accept an external observation.

The signed JSON must contain schemaVersion 1, kind provider-observation, and provenance with provider, model, tier, apiVersion, tokenizer, executor, independentVerifier, observedAt ISO timestamp and responseIds. Each trial needs positive budgetTokens/inputTokens, nonnegative integer outputTokens, a distinct responseId, SHA-256 prompt digest, boolean success, plus independently evaluated pass and SHA-256 output digest. Response IDs must exactly cover all trials; executor and evaluator must differ. No provider keys or raw sensitive prompts belong in records. Evidence expires after 30 days and must not be future-dated.

The attestation object has algorithm Ed25519, keyId, signedBy, signatureBase64. The signature is over UTF-8 recursively key-sorted JSON of the entire record EXCLUDING the attestation object, with arrays kept in original order. The keyId must resolve in an externally provisioned trustedSignerKey map: never trust a public key supplied by the observation itself. signedBy must match the independent verifier. Missing signing evidence, altered input/output counts, invalid hashes, duplicate response IDs, self-evaluation, stale records, untrusted keys, and provider/model/tier mismatch are UNTRUSTED_CALIBRATION failures. A valid signature establishes only evidence integrity and accountable observer identity; it is NOT automatic proof of genuine provider calls, response correctness or account-specific tier entitlement.

A trust store is JSON mapping signer IDs to trusted PEM Ed25519 PUBLIC keys. Store any private signing key elsewhere, never in git.

Commands from a clean checkout:

    node --test tests/task-socket-conformance/*.test.mjs
    node tests/task-socket-conformance/calibration-cli.mjs
    ATAX_SOCKET_TRUST_STORE=/secure/trusted-observers.json node tests/task-socket-conformance/calibration-cli.mjs /secure/real-signed-provider-observation.json
    ATAX_SOCKET_CONFORMANCE_ADAPTER=/absolute/path/integrated-shim.mjs node --test tests/task-socket-conformance/adapter-contract.test.mjs tests/task-socket-conformance/adapter-adversarial.test.mjs

The evidence-path CLI must refuse records without a trusted store, including the committed synthetic fixture. The default CLI without evidence still prints conservative UNCALIBRATED limits. The provider's published exact context C is an UPPER bound, not a measured reliability guarantee. The ATAX ceiling must never exceed floor(0.40*C), the system/output reserves, or a lower independently calibrated limit. Rounded or unknown capacities retain the 4096-token fallback; the unknown exact output cap remains 1024. Consumer Free-plan access must never be inferred from API tier documentation.

### Disposable integrated adapter contract for final Agent F

Implement createAdapter({budget,maxPayloadBytes}) exporting the contract in adapter-contract.mjs. The adapter must implement createTask, claim, pull, push, usage, reconnect, tick, get, atomize, requestWorkflow, dispatchAck, dispatchFinish, submit, verify, directTarget, readCredential and unrestrictedFetch, returning stable machine error codes. Every test creates a fresh disposable namespace, immutable target revision and authorized allowlist. tick uses an isolated clock or controlled lease-expiration fixture, NOT direct mutation of the production claim ledger. The adapter must never import the reference fake.

Required evidence: immutable source and test SHAs; native Node output; redacted request and metering event IDs including failed attempts/retries; canonical database claim/session/fence; atomic split and verified child transitions; authenticated restricted-tool denial logs; pinned GitHub job request/ack/terminal evidence; signed provider observations with independent result evaluations; and teardown confirmation. Avoid durable writes to real ATAX task keys during integration. A supplied shim that only simulates gateway, database or GitHub activity is a mock and receives MOCK_ONLY, not LIVE PASS.

Security release failures include: context usage reset, missing token accounting, accepted forged principal/session/fence, stale lease access, output over provider-specific cap even if combined budget fits, self-planning or self-verification, partial child inserts, direct writes or credential disclosure, mutable revision, unauthorized target, idempotency collision, nonterminal/failed/oversized dispatch promoted to success, or skipped negative tests. The reference mock has only a shared budget and DOES NOT establish enforcement of a smaller provider-specific output cap; Agent F must test that boundary against the actual metering implementation. All absent evidence remains NOT_RUN/BLOCKED. Agent F owns final integration and a different independent reviewer must verify Agent K's changes. No production certification is claimed here.
