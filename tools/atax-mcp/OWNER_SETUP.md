# Personal ATAX MCP — one owner, three substrate connection modes

> **Supabase Data API architecture:** ATAX Workers (`worker-dashboard.ts` / `tools/atax-mcp/worker.mjs`) and the local Express server (`server.ts`) connect to Supabase **exclusively via HTTPS Data API / PostgREST** using `ATAX_SUPABASE_URL` and `ATAX_SUPABASE_SECRET_KEY`. Direct PostgreSQL connection URIs (`ATAX_SUPABASE_CONNECTION_URL`), `postgres.js`, and Hyperdrive bindings are retired and removed. MCP settings, singleton instance passkey auth, and encrypted GitHub/Cloudflare credentials live in canonical Supabase tables + Vault and are managed through the Settings UI (`/api/settings/*`).


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

## Configure one canonical ledger (Data API)

| Cloudflare Worker secret | Type | Purpose |
| --- | --- | --- |
| `ATAX_SUPABASE_URL` | **Secret** | Canonical ATAX Supabase HTTPS API URL (`https://<project>.supabase.co`) |
| `ATAX_SUPABASE_SECRET_KEY` | **Secret** | Dedicated server-side Supabase secret key for HTTPS PostgREST / Data API; never exposed through an API/MCP response |

Owner authentication policies (`MCP_OWNER_SUBJECT`, `MCP_SHARED_TOKEN_SHA256`, `MCP_SHARED_SUBJECT`, `MCP_SHARED_SCOPES`, `MCP_ATAX_OWNER_JWT_SUBJECT`, `MCP_AUTH_OWNER_SCOPES`, `MCP_AUTH_AUTHORIZATION_SERVER`, `MCP_AUTH_ISSUER`, `MCP_AUTH_JWKS_URL`, `MCP_AUTH_AUDIENCE`) are stored in `atax_private.mcp_server_settings` and loaded via `atax_mcp_runtime_config_v1`. Keep executing agents and independent verifiers in distinct identities/scopes.

## Configure Supabase OAuth 2.1 & Google Sign-In

1. **Supabase Dashboard -> Authentication -> Providers -> Google:** Enable Google Sign-In with your Google OAuth Client ID and Client Secret, and ensure Supabase Auth OAuth 2.1 Server + Dynamic Client Registration (`/auth/v1/oauth/clients/register`) are enabled.
2. **Sign in once with the owner's Google account** through the OAuth flow (or check Supabase **Authentication -> Users**) to obtain the owner's permanent **User UID (`user.id` UUID)** — never use an email address.
3. **Set OAuth policy in `atax_private.mcp_server_settings`** (via `atax_mcp_set_settings_v1`):
   - `MCP_AUTH_AUTHORIZATION_SERVER`: `https://<project>.supabase.co/auth/v1`
   - `MCP_AUTH_ISSUER`: `https://<project>.supabase.co/auth/v1`
   - `MCP_AUTH_JWKS_URL`: `https://<project>.supabase.co/auth/v1/.well-known/jwks.json`
   - `MCP_AUTH_AUDIENCE`: `authenticated` (or space/comma-separated list including custom audiences if Custom Access Token Hooks set one)
   - `MCP_ATAX_OWNER_JWT_SUBJECT`: `<owner-supabase-user-uuid>`
   - `MCP_AUTH_OWNER_SCOPES`: `atax:read atax:write atax:github:read atax:github:create atax:cloudflare:read atax:fmrl:execute` (omit `atax:verify` unless explicitly intended; keep independent verifiers separate)
4. **Security boundary:** Non-owner Supabase Auth users (even with valid Google accounts) fail `isOwnerPrincipal()` and receive no owner tools or credentials.

## Add named provider accounts via Supabase Vault

Manage named **GitHub** and **Cloudflare** credentials through the authenticated Settings UI (`/api/settings/providers`), which stores tokens encrypted inside **Supabase Vault** (`atax_private.provider_accounts` + `vault.secrets`) under the singleton instance owner. Never store secret values in git, `wrangler.toml`, chats, issues, or logs.

Initialize the instance passkey once via Supabase SQL Editor (`SELECT atax_private.initialize_instance_passkey_v1('<12+ char passkey>');`), then unlock the Settings UI with `Enter passkey` to add, test, enable/disable, rotate, or revoke aliases.

- **Troubleshooting Settings `Test` button:** `/api/settings/providers/:provider/:alias/test` resolves the instance owner from the canonical database before calling `vault.testAccountConnection(ownerSubject, provider, alias)` and returns `503` if the instance owner is not configured or session is invalid, or `404` if the account alias is disabled in Vault (only enabled accounts are active in `atax_mcp_runtime_config_v1`).
- **Multi-account GitHub + FMRL:** `atax_provider_accounts_list` lists aliases only. When two or more GitHub accounts are registered (e.g. `PERSONAL`, `WORK`), callers must specify `account` explicitly on every GitHub and FMRL tool call; `atax_fmrl_create_run_dispose` returns `dispatched_account`, which can be passed back to `atax_fmrl_get_status` to enforce same-account polling.
- Configure `MCP_GITHUB_OWNER` (valid GitHub login for the ATAX controller repo) and `MCP_FMRL_ALLOWED_TARGETS` for FMRL CI dispatch. Selected GitHub credentials never leak in responses or logs.

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
2. Confirm the target Worker actually has `ATAX_SUPABASE_URL` and `ATAX_SUPABASE_SECRET_KEY` secrets configured, and verified owner OAuth admission. Provider credentials are managed via Supabase Vault, not direct Worker secrets. A public `/health` result alone does not prove readiness.
3. Verify an unauthorized identity gets no tools; the actual owner completes `initialize`, `tools/list`, `atax_context`, `atax_skill_get`, named account listing and GitHub/Cloudflare reads.
4. Verify real GitHub repository operation and FMRL controller execution/cleanup; ensure test actors and an independent verifier retain distinct identities and scopes.
5. Confirm the **direct GitHub connector + direct Supabase connector path** still works if the Worker is unreachable; compare tool coverage and record any parity gaps before claiming identical capabilities.
6. Deploy only after the ATAX release guard and an authorized operator-secret setup are satisfied; test native Claude/Gemini connections separately. Do not publish server credentials as client credentials.

The abandoned multi-user proposal was PR #1606. It was closed without merge on 22 November 2026.
