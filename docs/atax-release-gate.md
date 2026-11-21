# ATAX guarded substrate releases (IST day)

ATAX **does not** schedule or spawn agents. Incoming external release agents coordinate through this durable Supabase gate and then use provider-native GitHub/Cloudflare actions.

## Status and authority

This migration defines a **fail-closed coordination mechanism**. It is **not** proof that any release was made, not a production deployment, and not a substitute for GitHub repository protection or Cloudflare permission boundaries. Until those providers enforce the gateway, manual pushes and direct Cloudflare API uploads can bypass this SQL protocol. Do not say release is safe when only the database lock exists.

## Procedure

1. Read ATAX System constraints and the current exact GitHub default-branch SHA from GitHub (not an old projection). Enumerate all open PRs through the paginated repository API. Identify one coherent exact-head integration batch, dependency compatibility and external verification.
2. Read all GitHub main-branch commits and **push/update events** covering 00:00–23:59:59 Asia/Kolkata. A partial commit page is not complete push evidence. Include direct pushes, merges, squash, web commits and force updates. Read all Cloudflare Worker deployments **and secret-/upload-triggered deployments** for the same IST interval; Workers Builds alone is insufficient.
3. An **independent** attestor (not the release lock owner) calls `atax_release_gate_attest` only when both provider histories are exhaustive. Supply actual counts, source URLs, and explicit `complete_ist_day=true` provenance for `github_rest` / `cloudflare_workers_deployments`. SQL cannot cryptographically verify attestation truth; a trusted attestor must inspect source material.
4. Release agent atomically calls `atax_release_gate_acquire(agent_id, lease_seconds)`. If `acquired=false`, do not release. Use the returned fencing token; never reuse a token after expiry.
5. Ingest every relevant exact-head GitHub check (including failures and pending status) into `github_check_runs` with current SHA and timestamps. Run independent acceptance and migration compatibility checks. Only a fresh complete passing set is valid.
6. Reserve **each action** with `atax_release_gate_reserve(agent_id, claim_token, operation, exact_head_sha, acceptance)` before touching GitHub main or the Worker. The call rejects unknown provider counts, stale provenance, missing checks, wrong owners, missing compatibility proof, and exhausted caps. `operation` is `main_update` or `worker_deployment`. Reservations are conservatively nonrefundable, including ambiguous provider failures.
7. After successful reservation, run exactly the reserved GitHub or Cloudflare operation and independently verify its provider-native SHA, source artifact and deployment version. Append evidence outside this gate; refresh provider history and day totals before another release. Release the lock with `atax_release_gate_release` while it is still valid.

## Rules and limitations

- Both budgets are at most **two per IST calendar day**: GitHub main updates and Cloudflare Worker deployments. These are separate counters. A missing source page is **unknown, not zero**.
- The accounting deliberately treats provider-observed events **plus** outstanding reservations as consumed budget. This can overcount after a successful release until reconciliation logic is extended. It cannot silently grant additional release capacity.
- An already merged PR and a green old-head check are insufficient for a different exact head. A draft PR is not release-ready without acceptance.
- **Before release, enforce GitHub main-branch protection/rulesets, restrict Cloudflare deployment credentials, and ensure every release entrypoint requires an actual reservation.** The connected GitHub repository was observed unprotected on 21 Nov 2026; do not claim this independent precondition is met by the migration.
- This gate does not alter task claims, schedules, existing historical task events, or deployment secrets. Every claim or budget transition is a single PostgreSQL transaction.
- The disposable `atax-guarded-release-gate.integration.sql` fixture tests exclusive lock contention, stale token fencing, independent-day attestation, exact-head checks and both daily caps. Real concurrent transactions and provider API end-to-end checks are still necessary before production enforcement.
