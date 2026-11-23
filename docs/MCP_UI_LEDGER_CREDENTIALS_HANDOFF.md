# ATAX MCP server + management UI — canonical handoff (23 November 2026)

> **Decision / implementation target.** ATAX was originally developed as a headless agent substrate with no first-party UI. **That design restriction is removed.** The `dinilmusick/ATAX` repository must now ship an authenticated management UI alongside its remote MCP server. The Google AI Studio / Hydrogen implementation agent should read this file from **`main`** before designing or generating UI code. This is a target contract, **not evidence that the database-backed credential migration or UI is already deployed**.

## Scope and non-goals

- This changes **ATAX's own remote MCP server** and its new management UI/backend. It **does not change** the ChatGPT direct GitHub + Supabase connector workflow, GitHub-only controller mode, or the externally created/transient-agent substrate architecture.
- Supabase PostgreSQL remains the canonical durable ledger. ATAX must **never spawn, run or schedule resident agents**; existing atomic task claims, fencing, independent verification, role separation and release gates remain authoritative.
- The existing owner/maintainer MCP endpoint and the restricted Socket V1 endpoint remain separate security boundaries. A restricted task socket **must never receive provider-account credentials or unrestricted provider tools**.
- Do not silently enable unverified Socket V1 production execution, production migrations, or background relay. The user-facing UI is an administrative surface, not an alternate task executor.

## New runtime configuration contract

**Exactly one externally configured runtime environment variable for the ATAX MCP/UI server:**

```dotenv
ATAX_SUPABASE_CONNECTION_URL=
```

- Value: a **server-only, TLS-protected PostgreSQL connection URI** to the canonical ATAX Supabase ledger, including appropriate restricted database identity/credentials for the server-side connection. It is **not** the public `https://<project>.supabase.co` API origin alone. The URI is confidential. Never ship it in `VITE_*`, `NEXT_PUBLIC_*`, browser JavaScript, static assets, URL query logs, screenshots or agent prompts.
- Reject missing, malformed, insecure, untrusted-host or unprivileged connection configuration; **fail closed**. Use a narrowly privileged database role and audited, least-privilege server-side functions. Do not assume the connection URI is safe to display merely because it is named a URL.
- All other **MCP server/application** configuration belongs in the canonical ledger, with strict authorization: owner identity/admission policy, OAuth issuer/JWKS/client registration settings, GitHub ownership and FMRL policies, provider account aliases, provider-specific organization/account IDs, approved workflows and deployment policies. Configuration is *data*, not a second environment variable.
- Only sensitive **provider credentials** go in a server-side encrypted secret store, preferably Supabase Vault with database-managed encryption. Store metadata/aliases separately from secret material and reference Vault IDs. Never make decryption or raw token retrieval available to `anon`, general `authenticated` users, read-only graph clients or restricted socket agents.
- A database connection URI alone is **not** browser/user authentication. Client access still needs independent, standards-based identity verification, owner-bound authorization, replay/CSRF defenses, short sessions, audit events and explicit permissions. If secure bootstrap or credential isolation cannot be proven, withhold administrative mutation endpoints.
- Existing `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `GH_KEY_*`, `GH_TOKEN_*`, `CF_KEY_*`, `CLOUDFLARE_TOKEN_*`, `CLOUDFLARE_ACCOUNT_ID_*`, `MCP_*`, and future `VERCEL_TOKEN_*` are **legacy MCP runtime bindings to migrate out**, not part of the desired one-variable release. Do not delete required runtime checks before database-backed replacements pass tests. Separate GitHub Actions/Supabase CLI/hosting control-plane credentials are outside this MCP runtime contract and must not be silently removed or moved to the browser.

**Important architectural constraint:** the current Cloudflare Worker talks to Supabase through HTTPS REST using a separate secret key. The new single URI contract therefore requires an actual backend transport/driver migration (or a secure server-owned adapter with equivalent authenticated database access). Merely renaming `SUPABASE_URL` or removing the API key will break the server. The implementation agent must prove the chosen Cloudflare/Node/Vercel runtime supports a TLS PostgreSQL connection through a tested adapter; no fake fallback or unauthenticated Supabase REST calls.

## Unified credential registry

Introduce versioned migrations and server-owned transactions for a private provider-account registry. Suggested internal structure, subject to schema reconciliation:

- `atax_private.provider_accounts`: opaque ID, owner/principal ID, provider (`github` | `cloudflare` | `vercel`), normalized alias, optional provider account/organization ID, scoped capability metadata, status, vault secret reference, created/updated/rotated timestamps.
- `atax_private.mcp_server_settings`: authenticated owner identity policy, OAuth resource configuration, canonical GitHub owner/FMRL policies, approved workflows and feature flags (no plaintext secrets).
- `atax_private.provider_credential_audit`: actor, provider-account reference, action (`create`, `rotate`, `test`, `disable`, `delete`), timestamp and redacted status. **Never record credential content.**

Preserve multiple separately named GitHub, Cloudflare and Vercel accounts. Never automatically select an arbitrary account when multiple are configured. Use an explicit account selector/opaque ID and verify the authenticated principal is authorized for that account and operation. Keep provider-specific adapters narrowly scoped and audited; Vercel is **not currently implemented** in the existing MCP provider adapter and must not appear live in the UI until a real adapter and tests exist.

All privileged mutation/decryption must occur in authenticated server code and guarded SQL/RPC transactions with explicit grants. Follow row-level security where appropriate, prohibit direct public table access, resist account-ID substitution, and test owner isolation. Do not place private credentials or secrets in public Git repositories, workflow inputs, logs, database query results to agents, or UI responses.

## UI required in this repository

The previous read-only UI handoff (`docs/AI_STUDIO_REACT_HANDOFF.md`) is **expanded** by this decision; it is no longer the complete product scope. Keep its canonical graph-view requirements, and add an authenticated **MCP Settings / Provider Accounts** workspace.

Minimum UI:
1. **MCP connection/status**: ledger transport configured/unconfigured; maintainer vs restricted socket release status; real signed-in identity; no secrets displayed.
2. **Provider accounts**: separate GitHub, Cloudflare and Vercel sections; list aliases, capability scope, owner, last test/rotation and connected/disabled status; add as many accounts as required.
3. **Add / rotate / revoke credentials**: protected write-only forms delivered to the authenticated server over HTTPS, with no browser persistence, query-string tokens or secret echo. Display masked status, never stored values. Confirm destructive revocations.
4. **Connection test**: server-side least-privilege provider probe using only the selected account; show a safe success/error result; no raw upstream tokens or payloads.
5. **Access and policy**: owner identities, approved GitHub/FMRL targets, OAuth settings, workflow grants and independently verified deployment/health indicators, all loaded from the ledger after authorization.
6. **Existing graph read views**: Universe → Systems → Visions → Goals → Tasks, dependencies, heartbeat/lease evidence and independent verification; retain prior UI handoff semantics.

Frontend uses an authenticated same-origin server adapter and **no privileged database connection**. Build the UI in an isolated app package in this repository, with portable React components and a runtime-specific thin server adapter. Do not import `ATAX_SUPABASE_CONNECTION_URL` into the browser bundle or return full database rows. No vendor-specific Luth/ULTRST dependency.

Suggested routes are illustrative **new contracts**, not claims of existing handlers:
```
GET    /api/mcp/status
GET    /api/mcp/provider-accounts
POST   /api/mcp/provider-accounts
POST   /api/mcp/provider-accounts/:id/test
PUT    /api/mcp/provider-accounts/:id/credential
DELETE /api/mcp/provider-accounts/:id
GET    /api/graph/visions
```
All routes must authenticate and authorize server-side. Enforce input schema, size limits, per-actor rate limits, replay protection, same-site sessions and audit logs. Do not turn a credential-setting route into a generic network proxy.

## Migration in bounded, independently verified stages

1. **Ledger contracts**: define/enforce private schema, encryption/Vault access, account ownership, settings, grants and safe server-side RPCs; test migrations in disposable Supabase first.
2. **Server adapter**: replace `tools/atax-mcp/worker.mjs`, `provider-accounts.mjs`, `github-tools.mjs` and restricted host configuration dependencies with a server-owned ledger-backed configuration and credential resolver. Retain fail-closed authorization and provider allowlists. No credential/env fallback after cutover.
3. **UI**: implement the authenticated account-management experience plus existing read-only graphs. Add migration UX for existing secrets without ever copying plaintext into code or logs; require authorized owner re-entry/rotation where secure migration is unavailable.
4. **Certification/cutover**: prove one runtime environment variable suffices in clean deployment, old secret bindings are unused, multiple accounts work, independent auth denial/owner isolation passes, full test suite and independent real deployed tests pass. Only then remove old MCP runtime secret bindings from hosting. Preserve direct connectors and the guarded Socket V1 release state.

### Release acceptance checklist

- Clean MCP/UI server launch with **only** `ATAX_SUPABASE_CONNECTION_URL` configured; no other required MCP runtime environment variables.
- Secure owner login and durable configuration retrieval using ledger data, without a browser-held privileged database credential.
- Add, enumerate, rotate, test and disable **two or more** GitHub accounts and Cloudflare accounts; Vercel only after its real adapter succeeds.
- Negative checks: anonymous user, cross-owner ID, stale session, denied scope, restricted socket, invalid token, secret echo, logged URL/credential, CSRF and leaked React bundle all fail closed.
- Live task claim/fence/verification behavior remains unchanged; existing ChatGPT direct GitHub + Supabase connectors still function during MCP downtime.
- Exact-SHA tests, security gates, disposable DB migration/RLS, deployment and independently observed end-to-end evidence are attached to a reviewed PR before merge/production activation. No unverified PR is merged merely to make the UI generator see it.

## Current state at time of handoff

As checked on 23 November 2026, `main` is `2f5b7d7ca6ee27925a849fe1c1155f0b5aca2ece` and no ATAX PRs were open before this handoff. Socket V1 source was merged via PR #1743, but restricted production rollout and canonical verification are **not** certified. Current MCP source still requires older environment variables; **this document authorizes the new architecture, but does not itself implement or certify migration**. The next implementation agent must do the actual database/server/UI work before claiming single-variable runtime readiness.
