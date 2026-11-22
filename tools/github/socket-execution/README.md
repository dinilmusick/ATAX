# ATAX Socket V1 — Delegated Workflow Execution

**Scope:** Only `tools/github/socket-execution/**`, `supabase/migrations/*socket_dispatch*.sql`, `.github/workflows/*socket*`. ATAX remains the control plane; it never runs target code or creates/schedules AI agents.

## Protocol

1. A trusted socket gateway calls the service-only `socket_dispatch_submit` RPC with agent/task/session/fence, operation, target and runner repository, allowlisted workflow, immutable 40-character target commit SHA, bounded input/expected-output objects, correlation UUID and idempotency key. The RPC rechecks the current claim, target allowlist and duplicate conflict under lock. The client independently validates the strict contract.
2. Supabase writes an intent plus durable outbox. The installed `pg_cron` calls `socket_dispatch_pump` every minute. `pg_net` sends only `request_id` and `correlation_id` directly to **GitHub Actions workflow_dispatch** using a token decrypted from **Supabase Vault**. No Cloudflare Worker, agent spawning or agent credentials are involved.
3. `socket-execution-controller.yml` fetches the canonical intent with protected GitHub secrets; `socket_dispatch_begin` atomically grants one relay only if the claim/session/fence remain valid. It dispatches to an allowlisted runner and never checks out target code itself.
4. An independently deployed, protected **target** workflow must call `socket_dispatch_fence_valid` before checking out **exact target SHA** and performing fixed, reviewed operations. The test/build reference is `socket-target.example.yml`; it is **not** automatically installed into targets. `automation` and `change_request` require their own reviewed target-side adapters and write-lease checks.
5. A separate scheduled controller job independently reads the target GitHub Actions run status, matching `run-name: atax-socket/<correlation_id>`. Only completed exact matches produce a bounded, redacted receipt (≤4 KiB). Large artifacts stay in GitHub-controlled storage with an immutable `github-artifact://...` reference; never print raw target logs.
6. FMRL mode uses the established disposable lifecycle: the approved runner repository name is `owner/atax-fmrl-<first 20 hex of correlation>`. The controller deletes only that disposable repository after terminal work, then **independently GETs the repository and requires 404**. Cleanup failure blocks certification.

## Activation (disabled by default)

After independent migration review, configure the `socket_dispatch_config.github_token_secret_id` to an existing Supabase Vault secret, enable that row, and add reviewed enabled `socket_dispatch_allowed_targets` rows. Install the audited target workflow on protected `main`. In ATAX GitHub Actions secrets set `ATAX_SUPABASE_URL`, `ATAX_SUPABASE_SERVICE_ROLE_KEY`, `SOCKET_GITHUB_TOKEN`. Provision the fenced target-preflight credentials only within trusted protected target workflows; never pass them to checked-out code. Prefer short-lived GitHub App tokens with repo-limited permissions. FMRL deletion requires appropriately limited repository administration privileges.

No live token, target workflow allowlist or production migration is provisioned by this PR. Without operator activation the database pump is inert.

## Crash, retry and integrity rules

- The `pg_net` outbox records HTTP IDs, status and maximum 5 retries; it never drops a persisted dispatch intent. Missing HTTP acknowledgement can retry **only the opaque relay event**. The SQL compare-and-swap ensures duplicate relays do not send duplicate target operations.
- Failed/expired fenced claims deny new work. A timeout *after* calling the target GitHub API is ambiguous and does not automatically retry the side effect. If a relay crashes after winning `begin` but before dispatch, it remains unresolved pending independent adjudication rather than risking duplication.
- GitHub 204 means dispatch accepted, **not execution succeeded**. Missing or duplicate correlation-matched run IDs are nonterminal, never a success receipt.
- GitHub dispatch ref is a trusted workflow branch (`main`) because GitHub accepts branch/tag, while the **target checkout** must be pinned to the immutable target SHA.
- Server-only tables enable RLS and deny `anon`/`authenticated`. Security-definer Vault access is restricted to trusted dispatch pump. All other RPCs require server privileges; no agent sees service keys.

## Tests

`python3 -m unittest discover -s tools/github/socket-execution -p 'test_*.py' -v` covers duplicate dispatch, stale lease denial, malicious/oversized input/output, missing credentials, ambiguous retry, terminal failures, FMRL cleanup and independent verification. `socket-execution-tests.yml` runs it on PRs. The local fake tests **do not constitute** an applied migration, configured target or live end-to-end run. Final independent verifier must review migration, inspect exact PR head, verify target branch protection, prove target GH run and FMRL deletion, then accept or reject.
