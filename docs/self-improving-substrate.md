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
