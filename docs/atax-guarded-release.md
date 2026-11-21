# ATAX guarded release gate (IST)

This is a durable **release coordination contract** for transient external agents. ATAX does not spawn or schedule agents. Releasing source code is a separate, privileged operation from normal ATAX substrate development on pull-request branches.

## Invariants

- The canonical Supabase ledger has exactly one active reservation per ATAX system per India Standard Time (Asia/Kolkata) calendar day.
- The release reconciler may reserve exactly one `main_update` or `worker_deployment` action, for 120–1800 seconds. Different actions share the exclusive reservation.
- Limits are **at most two externally observed main updates and two Worker deployments per IST day**, individually. The counter is an external attestation, not merely the number of uses of this SQL function.
- A reservation cannot be stolen before expiry. **Expiry does not itself authorize takeover**: abandoned/uncertain reservations require independent reconciliation of GitHub and Cloudflare evidence before any new attempt.
- Every reserve and finalize appends a durable event. Only authenticated server-side `service_role` callers may invoke the two public RPCs; underlying release tables and audit events are not directly exposed to clients.
- This gate cannot prevent a direct GitHub owner push or Cloudflare API deployment outside its control. Protect `main`, require exact-head checks, and ensure every deployment workflow/reconciler invokes the reservation RPC. Without those integrations, do **not** call the release process universally enforced.

## Incoming release-agent protocol

1. Read the **current** ATAX system state, active constraints, candidate PRs and their exact heads, main SHA, database migration compatibility, and IST date.
2. Independently read complete source-backed GitHub default-branch update/push history for today's IST window and every Cloudflare `atax-mcp` Worker deployment in that window, including manual uploads and secret-triggered deployments. Page through results to exhaustion. If an endpoint cannot prove the full update count, stop: do not invent zero.
3. Have a **different agent** independently verify the source evidence, current SHA, provider boundaries, and exact-head integration acceptance. Record real provider URLs and a timestamp. Never use a fabricated verifier ID to bypass this step.
4. Call `public.atax_release_reserve(system_id, agent_id, action, provider_report, lease_seconds)` with report keys: `ist_day`, `verifier_agent_id`, `verified_at`, `github_history_complete=true`, `cloudflare_history_complete=true`, `observed_main_sha`, `main_updates`, `worker_deployments`, and `source_links` (at least two). The database validates contract completeness, distinct agent IDs, freshness, observed counter monotonicity, quota, and exclusive ownership. **Source authenticity is not independently verifiable by SQL**; the human/agent must establish it.
5. Make exactly one externally authorized change using the approved exact-head SHA and configured deployment identity. Reobserve GitHub and Cloudflare through independent providers.
6. Call `public.atax_release_finalize(system_id, agent_id, token, 'completed'|'aborted', fresh_provider_report)`. Only correct `+1` external count for the reserved successful action (or unchanged counts for an abort) and an unexpired token return completion. Any ambiguity becomes `reconcile_required`, never green.
7. If an agent crashes after reservation, do not create a second lease or bypass the row. Independently reconcile the real source actions and add a separate audited recovery transaction before any subsequent release. Retain all prior events.

## Safety and deployment

- Run the disposable Supabase reset + full SQL/RLS/RPC/trigger tests and the `atax-ist-release-gate.integration.sql` regression before any production migration.
- A green CI job **only validates the source**. It does not establish current provider counts, prove producer compliance, or constitute production migration authorization.
- Use an integration batch whose exact head is independently checked, with a rollback path. No migrations, main updates or Worker deployments may be inferred from the existence of this branch or PR.
- Do not apply this migration to a multi-tenant environment without independently auditing the `service_role` privilege boundary, the security-definer functions, and evidence provenance.
