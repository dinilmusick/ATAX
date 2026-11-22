# Personal ATAX MCP — one owner, three substrate connection modes

ATAX supports three ways for externally created agents to reach **one** canonical Supabase ledger: **GitHub connector only** (using an authorized, credential-bearing tool/Actions bridge for live ledger operations), **GitHub plus Supabase connectors** (the existing direct path), and **the remote ATAX MCP Worker**. Full coverage and verification differ by transport; the [connection-mode contract](../../docs/connection-modes.md) documents exact boundaries and acceptance gaps.

This document configures **only the third mode**, the single-owner remote MCP Worker. Do **not** resurrect multi-user BYOC enrollment, D1 credential vaults, per-tenant Supabase ledgers, or provider credentials passed in MCP tool arguments.

## All three entry points

| Entry path | Authentication and credentials | Canonical state |
| --- | --- | --- |
| **GitHub connector only** | Repository-level GitHub connection; trusted GitHub Actions secrets or a separately authorized runtime powers live Supabase RPC calls. A plain GitHub connector **cannot** read database secrets or live state automatically. | One ATAX Supabase ledger; GitHub-only live task bridge parity remains to be certified |
| **GitHub + Supabase connectors** | Existing ChatGPT/agent direct GitHub and Supabase tools, each using its own granted account authorization. No MCP dependency. | The **same** ATAX Supabase ledger |
| **Remote MCP** | Client authenticates to the MCP resource; the Worker admits only the configured owner and consumes owner-managed **Cloudflare Worker secrets** for GitHub/Cloudflare/Supabase. | The **same** ATAX Supabase ledger and guarded RPCs |

Do not make either direct connector path depend on MCP uptime, Cloudflare deployment, Worker credentials or Worker code. All three must use the canonical task-socket claim, fencing, checkpoint and independent verification contracts; no vendor-specific agent identity or resident orchestration. The Worker currently exposes bounded GitHub operations and Cloudflare read-only diagnostics; full three-mode tool parity is an **acceptance target**, not current fact.

## Task sockets: substrate invariant

ATAX is persistent state for externally created, transient agents. It does not classify, launch, spawn, schedule, or track the model/vendor/app doing work. A task is a **socket** with finite work and acceptance criteria. Incoming agents discover a socket, attempt an atomic claim, do the work externally, and persist evidence.

The substrate's relevant state is the socket itself:

- `queued` → available for atomic claim; competing claims cannot both succeed.
- `running` → occupied by one **valid lease + fencing token**. Concurrent arrivals cannot claim that live socket.
- `completed / pending verification` → executor has released its claim and submitted evidence; verification is separate from execution.
- `verified / finalized` → acceptance recorded after independent verification.
- If a lease expires or its heartbeat becomes stale, recovery may issue a **new** fencing token. Any holder of the old token must be refused further mutations. External side effects outside the substrate are not automatically cancellable: agents should use idempotency/reconciliation for those effects.

**Lease-loss continuation:** an external agent that finds `task_ledger_check_claim` false must forfeit that socket, append `task_ledger_record_handoff(task_id, old_claim_holder, old_claim_token, note, context)` (partial work, evidence and remaining steps), then rehydrate and atomically claim another eligible free task. It must not call submit, release or heartbeat on the lost socket. Losing one socket never ends the agent session by itself. The substrate does not initiate or schedule this transition; the agent does.

This is **exclusive authorized occupancy**, not a claim that only one external AI process can exist. GitHub and direct Supabase agents and MCP agents must all use the same canonical atomic claim/lease/fencing RPCs; no transport may invent its own local lock.

**Implementation boundary:** existing PostgreSQL task RPC signatures still accept an opaque `agent_id` for compatibility and audit/claim checking. That is an internal claim-holder reference, **not** a Gemini/Claude identity, agent registry, orchestrator, or reason to pick work. Never derive it from the AI application's vendor/name. Removing it from DB interfaces requires its own guarded migration; until then, the claim token and database row locks remain decisive for excluding concurrent claimers. Verification still requires a separate claim and independent evidence; using one operator account does not itself prove independence.

## Configure one canonical ledger

| Cloudflare Worker binding | Type | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Public configuration | The one canonical ATAX Supabase API origin |
| `SUPABASE_SECRET_KEY` | **Secret** | Dedicated, server-side Supabase key; never exposed through an MCP response |
| `MCP_ATAX_OWNER_JWT_SUBJECT` | Operator-supplied configuration | **Exact verified** Luth owner subject, not an email address or a wildcard |
| `MCP_AUTH_ISSUER`, `MCP_AUTH_JWKS_URL`, `MCP_AUTH_AUDIENCE` | Public configuration | Verify signed OAuth resource tokens |
| `MCP_AUTH_OWNER_SCOPES` | Public policy | Explicitly enables authorized MCP tools for the one owner |

The optional bootstrap shared bearer token uses `MCP_SHARED_TOKEN_SHA256`, `MCP_SHARED_SUBJECT` and `MCP_SHARED_SCOPES`; it is **not** a substitute for OAuth client compatibility, and must not be shared with external users. Keep executing agents and independent verifiers in distinct identities/scopes.

## Add named provider accounts to the Worker

Enter secret values **only** in Cloudflare's Worker Secrets UI or through `wrangler secret put` from a trusted terminal, never in git, `wrangler.toml`, a chat, an issue, or logs.

```sh
cd tools/atax-mcp
npx wrangler secret put SUPABASE_SECRET_KEY

npx wrangler secret put GH_KEY_PERSONAL
npx wrangler secret put GH_KEY_WORK
npx wrangler secret put CF_KEY_PERSONAL
npx wrangler secret put CF_KEY_SECONDARY
```

The suffix is the account alias. Account names must match `[A-Z][A-Z0-9_]{0,47}`. `GH_TOKEN_<ALIAS>` and `CLOUDFLARE_TOKEN_<ALIAS>` remain accepted for migration, but setting **both** new and old names for the *same* provider/alias fails closed rather than silently selecting a token. You may add more aliases without editing source code.

The `atax_provider_accounts_list` tool lists **aliases only**. When just one account is configured, tools can omit `account`; when several exist, tools must select an explicit alias. Selected GitHub credentials serve repository inspection, permanent repository creation and FMRL controller workflow dispatch/status. `CF_KEY_<ALIAS>` supplies Cloudflare account discovery and Worker-list diagnostics. Cloudflare mutation/deployment tools are **not yet** offered by this MCP surface. Vercel is intentionally deferred.

For FMRL, configure the nonsecret `MCP_GITHUB_OWNER` and `MCP_FMRL_ALLOWED_TARGETS` policy. Select a GitHub account whose permissions permit dispatching/reading the canonical ATAX FMRL controller. Its GitHub Actions workflow retains its own established secrets. A successful dispatch is not proof of test success or disposable-repo cleanup.

## GitHub repository secrets are a separate boundary

The ATAX **GitHub repository secrets** can use exactly the same names: `GH_KEY_PERSONAL`, `GH_KEY_WORK`, `CF_KEY_PERSONAL`, etc. They are accessible only to appropriately authorized GitHub Actions jobs, **not directly to a GitHub connector**, and **not automatically to the Cloudflare Worker**.

A trusted, restricted GitHub Actions job explicitly maps a secret into its running environment:

```yaml
# Add only to a trusted workflow/job that truly needs the secret.
env:
  GH_KEY_PERSONAL: ${{ secrets.GH_KEY_PERSONAL }}
  CF_KEY_PERSONAL: ${{ secrets.CF_KEY_PERSONAL }}
```

Do not grant secrets to arbitrary PR workflows, untrusted code, or general-purpose agent jobs. Users of the direct GitHub/Supabase connectors keep using those connectors' own account grants; when an agent dispatches a trusted GitHub Actions workflow, that workflow may use its specifically mapped repository secrets. This is the same provider-account *naming contract*, not one shared secret store.

## Release/verification contract

1. Run `node --check` on every Worker module and `node --test tools/atax-mcp/*.test.mjs` on the exact commit; verify no multi-user credential vault, no Vercel tools and no secret values in results.
2. Confirm the target Worker actually has `SUPABASE_SECRET_KEY`, named GitHub/Cloudflare secrets, and verified owner OAuth admission. A public `/health` result alone does not prove readiness.
3. Verify an unauthorized identity gets no tools; the actual owner completes `initialize`, `tools/list`, `atax_context`, `atax_skill_get`, named account listing and GitHub/Cloudflare reads.
4. Verify real GitHub repository operation and FMRL controller execution/cleanup; ensure test actors and an independent verifier retain distinct identities and scopes.
5. Confirm the **direct GitHub connector + direct Supabase connector path** still works if the Worker is unreachable; compare tool coverage and record any parity gaps before claiming identical capabilities.
6. Deploy only after the ATAX release guard and an authorized operator-secret setup are satisfied; test native Claude/Gemini connections separately. Do not publish server credentials as client credentials.

The abandoned multi-user proposal was PR #1606. It was closed without merge on 22 November 2026.
