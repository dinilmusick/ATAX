# Self-improving ATAX: verified control-plane contract

ATAX is durable state for externally-created transient agents. It never starts, schedules or keeps resident agents. Every incoming agent is an authorised observer and potential contributor to substrate improvement. An agent working on another system must still inspect applicable ATAX health findings, and may open an ATAX improvement PR when an actual defect is demonstrated. Improvement is encouraged but never overrides claim, security, source-of-truth or independent verification invariants.

## Mandatory agent intake

Hydrate from canonical Supabase: global overview and applicable skills; resolved Universe and System; goal versions and task dependencies; memories and active constraints; verification and current CI/deployment evidence. If a source is unavailable, record UNKNOWN, never claim healthy from absence of a signal. The substrate's self-improvement modality is system-self-improvement, and system-health-check is available for observation. Reuse existing goals/tasks, register evidence-backed candidates, perform at most four finite units, open PRs, independently verify and persist results. Critical violations may outrank ordinary system priority. Agents must not certify their own unverified work or silently reassign a claimed task.

## Live baseline: November 18, 2026

Of 321 tasks and 70 goals, 203 tasks lack an explicit system link, 50 goals have no system, 42 task/goal context versions differ across all statuses, 21 completed tasks lack verification, 14 running task claims are expired and nine running tasks lack a claim token. All 40 initially registered repositories had no successful sync projection. Agent registry, system constraints, GitHub check runs and GitHub sync events were empty. This does not imply all missing links are corrupt: effective system can be inherited from a goal, and some goals are legitimately general. An expired claim alone is not proof that a worker can be superseded: heartbeat and fencing are authoritative.

## GitHub-hosted control-plane telemetry

The health_audit.py tool fetches canonical Supabase tables, emits bounded findings, and optionally writes idempotent health observations into ATAX system_memories. Resolution supersedes only observations created by that audit. It never modifies goals, tasks, dependencies or claims.

The cloudflare_builds.py collector polls Workers Builds using registered account ID and immutable Worker tag. It categorises failures and persists the latest observed build, commit, branch, account, worker and repository linkage without raw logs, bearer tokens or unredacted logs. A failed build becomes immediately visible to an incoming agent once the scheduled poll completes. Only act on evidence for the current target SHA. Cloudflare Workers Builds Event Subscriptions offer event-driven updates if extra Cloudflare ingress compute is later allowed; this PR uses GitHub polling to respect the compute constraint. Cloudflare Pages needs a separate adapter.

Account choice requires independently VERIFIED monthly usage, budget and current concurrency availability. A 90-day Builds API listing is NOT a reliable source for the current monthly quota. No measured capacity means no automatic account selection. Integrate Frnes as the authoritative account and quota broker when current usage and allowed credentials can be independently established.

## GitHub Actions configuration

Add these repository Actions secrets after merging the PR:
- ATAX_SUPABASE_URL: canonical project HTTPS URL
- ATAX_SUPABASE_SERVICE_ROLE_KEY: protected server-side key; future improvement should replace it with a restricted RPC writer
- CLOUDFLARE_BUILD_ACCOUNTS_JSON: an array of account objects, each with account_id, api_token, and workers list; each worker has tag, system_key and repository keys

Example structure with placeholders only:
[
  {
    "account_id": "<account-id>",
    "api_token": "<scoped-user-token>",
    "workers": [
      {"tag": "<immutable-worker-tag>", "system_key": "aiko", "repository": "dinilmusick/Aiko"}
    ]
  }
]

Use the least privileges supported by Cloudflare Builds; its API currently requires a user-scoped API token for Builds access. Keep credentials out of PRs and artifacts. Schedule runs on main every 15 minutes; PRs run credential-free offline tests. The workflow checks out ATAX control-plane code only and never executes private target code.

## Skipo CLI execution contract

The Skipo CLI must run inside a private target's disposable FMRL GitHub-hosted runner, not on ATAX Actions. Use the existing FMRL controller to clone the target only in transient runner storage, install the lockfile-pinned Node/pnpm/Skipo version, inspect supported CLI commands with skipo --help, then execute inspect, diagnose, plan, update, repair, sync and verify as supported by that exact revision. Commit changes only in an authorised PR branch, not main. The read-only clone token is never forwarded to Skipo or a target workflow. Preserve sanitized failure-step evidence and independently verify FMRL deletion. A known Secrets:write permission error for FMRL provisioning remains an operational blocker until token scopes are corrected.

## Remaining acceptance gates

1. Cross-agent hydration contains fresh ATAX health findings and current skill/goal/task versions.
2. Atomic fencing and verification prevent stale writes, false completions, and conflicting leases.
3. GitHub sync/checks ingestors prove status at current remote SHAs.
4. Workers Builds and Pages deployment failures are ingested with account/project/commit provenance.
5. Frnes provides verified remaining account budget, not a guessed figure.
6. Pinned Skipo executes in disposable remote GitHub compute with cleanup proven.
7. Self-improvement candidates become independently verified PR changes without ATAX spawning agents.

This change implements the first diagnostic and policy layer. The remaining gates are not certified by the existence of this document or workflow.

## Implementation reconciliation (2026-11-18)

Canonical database migrations have been applied from the accompanying SQL sources:
- 20261118_ownerless_atax_self_improvement.sql: ownerless global systems can register improvement cycles/constraints; RLS and existing service-role-only improvement RPC grants remain intact.
- 20261118_atax_context_snapshot.sql: read-only snapshot at atax_context_snapshot(system_key_in), granted only to service_role. Verified return of 43 skill versions, active constraints, memories, candidates and current system repository mapping. It is a bounded overview, not a substitute for reading full source contracts.

Canonical Supabase contains five ATAX constraints and five initial constraint observations, covering task verification, claim fencing, goal context drift, current build evidence and FMRL security. Five evidence-backed self-improvement candidates remain available for incoming agents; they are NOT automatically promoted to goals because existing promotion calls a legacy goal constructor rather than the canonical Vision/Omni pathway. Fixing that is an explicit next task.

The new GitHub reconciler polls current default-branch SHAs, check runs and open/closed PR transitions; source failures remain ERROR/UNKNOWN, never healthy. The current GitHub mapping is not certified synced until this code runs successfully against each actual repository with a suitable read-only token. The Cloudflare collector now polls both Workers Builds and the authoritative build-minute limits endpoint. The latter returns whether the limit has been reached and when it refreshes, NOT the exact remaining minutes.

Security correction: no private ledger IDs, build output, account inventory, or private repository metadata is uploaded to public GitHub Actions artifacts. CI scripts write temporary JSON only inside the ephemeral runner; these files are removed after execution. Canonical results live in protected Supabase. The workflow requires explicit GitHub Actions secrets before monitoring can run; the Cloudflare connector connection in ChatGPT does not automatically grant GitHub Actions credentials.

Suggested locked GitHub-runner diagnostic stack (adopt per target, after version verification): TypeScript tsc --noEmit, ESLint or Biome, oxlint, Knip, dependency-cruiser, Vitest, Playwright, Miniflare/workerd, Semgrep, OSV-Scanner, Trivy, Gitleaks, actionlint and ShellCheck. Choose smallest checks first: parse -> typecheck -> lint -> unit -> graph/conformance -> build -> Cloudflare deployment -> runtime smoke -> independently verified result. Skipo certification remains the app-architecture gate; do not duplicate the canonical Skipo implementation in ATAX.

The ATAX Security Gates npm audit is currently a blocker (nine high and eight moderate findings in an ATAX toolchain CI artifact). This is separately registered as an ATAX self-improvement candidate. Do not bypass the audit or merge the main PR as fully verified until this failure is reconciled.
