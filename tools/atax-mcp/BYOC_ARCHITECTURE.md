# ATAX MCP Gateway — independent BYOC contract

**Decision, 2026-11-21:** Keep the gateway inside this repository at `tools/atax-mcp/` until a separately released gateway is technically justified. Do **not** create a clone of the substrate or its Supabase migrations. The existing Cloudflare Worker is the deployment target.

## Separation of responsibilities

| Layer | Owns | Must NOT do |
| --- | --- | --- |
| ATAX substrate | Canonical ledger schema, skills, goals, tasks, claims, verification invariants, disposable FMRL contract | Spawn/schedule agents |
| ATAX MCP gateway | Remote HTTP transport, client OAuth admission, onboarding, user/tenant credential resolution, tool exposure | Become a second ledger, default to the operator's ledger, own GitHub provider credentials |
| External agent | Decides when to connect, hydrate, execute, persist and leave | Claim other users' identities or skip verification |

Build the gateway from **imported/versioned contracts**, never a duplicated copy of migrations or RPC semantics. Keep separate CI/deployment and tests, but one source tree.

## Non-negotiable BYOC invariants

1. **Zero operator-held provider credentials:** no global `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `GITHUB_REPOSITORY_TOKEN`, `GITHUB_FMRL_DISPATCH_TOKEN`, `GH_TOKEN_*`, trusted Luth issuer, or global owner/allowlist in Worker bindings.
2. **Tenant selection comes from authenticated server-side session**, never an arbitrary request parameter. Every MCP call, GitHub/FMRL operation and PostgREST RPC must use the exact session's credentials and project.
3. **Luth/ULTRST are not dependencies.** ATAX must not modify either ecosystem to enable remote MCP connection.
4. **User grants are explicit.** Connecting Claude or Gemini to ATAX is not permission to use GitHub or Supabase; those are separately enrolled. Never accept GitHub or Supabase secrets as LLM tool arguments, query parameters, logs or source files.
5. **No cross-tenant authority.** A service-role key for user A cannot select user B's ledger, and GitHub A's token cannot run FMRL in B's namespace. Perform independent negative tests.
6. **No legacy fallback to operator accounts.** Missing or revoked credentials must fail closed; never use a default admin Supabase project or `dinilmusick` GitHub controller.

## Proposed user flow

1. The client enters the same public HTTPS `/mcp` URL in Claude or Gemini.
2. ATAX serves its **own** OAuth 2.1 authorization server metadata, anonymous Dynamic Client Registration (with redirect constraints/rate limits) and Authorization Code + PKCE S256. This is client-to-ATAX authentication; it is **not** GitHub OAuth and has no Luth dependency.
3. ATAX opens a first-party HTTPS onboarding/consent screen. The user enrolls a GitHub fine-grained personal access token with intentionally scoped repository/Actions permissions, chooses an owner/organization, provides a **Supabase project URL** and an appropriately scoped Supabase API credential. Validate the GitHub identity and project reachability before enabling tools.
4. User approves which capabilities the MCP client may call; ATAX creates a tenant-bound OAuth session with short-lived access and rotating refresh tokens. Store only token hashes for bearer lookup.
5. Each incoming RPC resolves its tenant and capability policy; select **that tenant's** GitHub and Supabase connection. Apply user ledger schema only after an explicit authorized setup step and safe migration checks.
6. FMRL provisioning, dispatch, evidence and **mandatory deletion/independent 404** run under the user's GitHub namespace with the user's chosen controller workflow. The hosted ATAX repository must not be used as a user-workspace fallback.

## Critical encryption tradeoff

A gateway can operate with **no operator-provided GitHub token, Supabase key or OAuth-client secret**. However, if Claude or Gemini is to call tools later without resupplying credentials, ATAX must hold *some recoverable form* of each user's credentials for that authorized session. Mere hashing is insufficient because outgoing GitHub/Supabase calls need the secret.

Choose one audited mode before enabling production:
- **Preferred usability:** per-tenant encrypted credential vault with Cloudflare-managed encryption / key service, tenant-bound session authorization, revocation and short retention. This uses infrastructure-managed key material, even though no user/provider secrets are configured as Worker environment variables. The operator's privileged infrastructure access remains a trust boundary; do not promise zero visibility.
- **Strict no-recoverable-server-secret:** client-held encrypted credentials and a decryption key supplied on every authorized invocation. This is difficult to integrate with standard Claude/Gemini UI and should not be represented as seamless OAuth interoperability.

No credentials may enter MCP tool arguments/model context. Never store plaintext credentials in D1, KV, log lines, GitHub Actions or source.

## MCP and security acceptance gates

- Public `/health` and OAuth protected-resource + authorization-server discovery return the exact intended URLs.
- Claude and Gemini individually complete dynamic registration, authorization code/PKCE exchange and token refresh with the hosted Worker.
- Consent binds a verified client, user and tenant; GitHub and Supabase credentials are checked and can be rotated or revoked.
- A fresh user project can initialize its canonical ATAX ledger without modifying the operator's Supabase project.
- `initialize`, `tools/list`, context, skills, task claim, heartbeat, submission and **independent verifier** all pass live with user credentials.
- Cross-user, wrong-project, stolen session, invalid/expired token, missing permission and revoked-token cases reject.
- GitHub repository creation, FMRL dispatch and mandatory cleanup remain in the user's namespace, with exact API audit evidence.
- All tests, security checks and live production deployment verifications pass **before** declaring the server ready.

**Migration state:** The current `worker.mjs` and `github-tools.mjs` are legacy single-owner implementations. Removing the global bindings alone intentionally causes `503` and **does not implement BYOC**. Never merge/deploy that incomplete configuration as a production fix. Replace the legacy resolution, OAuth session handling and tests first.
