# ATAX MCP: one Supabase bootstrap URL and credential-management UI

**Decision (2026-11-23):** The original ATAX repository was built as a headless substrate and MCP server, without an administrative frontend. This has changed: **ATAX will now include a web user interface**, suitable for the Google AI Studio/Hydrogen UI agent to build from the latest merged `main`. The first UI can still have read-only system/vision/goal/task graphs, but it **must also include an authenticated, write-capable MCP Credentials & Connections administration area**.

This change applies to the **ATAX remote MCP services only** (maintainer MCP and restricted task socket), not the existing direct GitHub + Supabase ChatGPT connectors, GitHub-only bridge, or the transient-agent substrate. Do not redirect those connection modes through the new MCP/UI.

## Absolute runtime contract

**Exactly one deployment environment binding is permitted for the MCP server and UI backend:**

```dotenv
SUPABASE_URL=https://<project>.supabase.co/#key=<privileged-server-key>
```

The entire value is a secret, even though its name is `SUPABASE_URL`. Set it in the *server-side* secret store of Cloudflare Workers / Vercel; never in `wrangler.toml` `[vars]`, a public env file, `VITE_*`, `NEXT_PUBLIC_*`, source code, a URL shown to a browser, logs, or prompts. The URL fragment is only a local bootstrap envelope. The MCP backend extracts the key and sends requests to the URL **without its fragment**, passing the key in the Supabase API headers over HTTPS. Bootstrap deliberately fails closed for a plain public URL, missing key, unexpected host or extra URL parameters.

Do not introduce separate `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GH_KEY_*`, `CF_KEY_*`, `VERCEL_TOKEN_*`, `MCP_*`, `SOCKET_*` or other runtime environment requirements for this interface. They are **database policy/credential values**, not deployment bindings. Existing GitHub Actions/CLI deployment-time credentials for the independent **direct connector / bridge** path are outside this MCP runtime contract and must not be removed in this work.

The Supabase URL has privileged bootstrap access. Its value is not an authentication credential for a human browser user; it **must never authorize a browser simply because the browser reaches the server**.

## Canonical settings and credentials

Supabase project `vcaerawuwffziufvpbvw` is the single existing ledger; do not create a second database.

A versioned migration `20261123113000_atax_mcp_vault_configuration.sql` provides:

- `atax_mcp_server_settings`: singleton server-side JSON policy (approved owner, bearer *hash* or OAuth issuer/JWKS/audience/scopes, allowed origins, socket identity policy, model and typed workflow catalog). This is not plaintext provider-token storage.
- `atax_mcp_provider_credentials`: many provider accounts per provider; unique `(provider,alias)`, `provider_account_id`, enable/disable and UUID references to **Supabase Vault** secrets. Supported storage types: GitHub, Cloudflare and Vercel.
- `atax_mcp_runtime_config_v1()`: **service-role-only** backend configuration hydration. It returns active provider credentials decrypted server-side and vetted server policy; no anonymous, authenticated-browser, or broad SQL access.
- `atax_mcp_set_settings_v1(...)`, `atax_mcp_upsert_provider_v1(...)`, `atax_mcp_set_provider_enabled_v1(...)`: server-role-only writes for use behind a separately authenticated, authorized admin API; secret uploads go directly from HTTPS backend into Vault and must never be echoed.

The runtime's internal compatibility mapping (for example, using an account token under a `GH_KEY_<ALIAS>` property **inside process memory**) must not be confused with deployment environment variables; only the Supabase URL is read from the host. Never read old Worker/CI provider secret bindings as a fallback. Configuration is fetched fresh per request so disabling or rotating an account takes effect without deploying the Worker.

**Current integration reality:** a Vercel provider *credential can be stored*, but no working Vercel MCP provider tool exists yet. The UI must label Vercel **stored / adapter unavailable**, not **connected / operational**, until a scoped adapter and real API test exist. Existing Cloudflare tools are read-only. Provider availability must be independently tested, not inferred from a saved token.

## Required UI (Google AI Studio / Hydrogen agent)

Build a React frontend and a **same-origin authenticated server API**, deployable to Vercel. The original repository's backend and three connection modes must remain intact. The UI must include:

1. **Authentication and authorization**: secure admin sign-in with a verified owner identity and server-held session, CSRF protections, authorization on *every* state-changing endpoint, anti-replay and request-size limits. Bootstrap the first admin identity using a trusted, manually authorized database procedure; do **not** let the first arbitrary visitor become admin. Direct possession of the one Supabase bootstrap URL is not a substitute for an authenticated UI session.
2. **MCP Credentials / Connections**: add, rotate, test, disable and remove named GitHub, Cloudflare and Vercel credentials. Support multiple accounts per provider. Show alias, account ID, last successful verification, expiry/scopes (if verifiable), last updated and effective status. Show only masked values after save; NEVER return a stored token to the browser.
3. **Server settings**: safely edit owner auth mode, approved scopes, OAuth issuer/JWKS/audience, FMRL target policies, restricted socket identity and approved workflow descriptors. The UI must validate settings and show which tools are deliberately disabled. No implicit wildcard permissions, no owner elevation from arbitrary third-party OAuth sign-in, and no prompt-based authorization.
4. **Read-only graph and status pages** per `AI_STUDIO_REACT_HANDOFF.md`; they may stay read-only even though the settings area performs administrative writes. Include real MCP health, last verified credential checks and deploy/release gate state. No fake active agents or fabricated provider checks.

Suggested server-only endpoints (names not yet deployed):

```text
GET    /api/admin/mcp/connections             -> masked metadata only
POST   /api/admin/mcp/connections             -> validate + write to Vault
PATCH  /api/admin/mcp/connections/:id         -> rotate / enable / disable
DELETE /api/admin/mcp/connections/:id         -> revoke / securely delete
POST   /api/admin/mcp/connections/:id/test    -> scoped backend provider probe
GET    /api/admin/mcp/settings                -> redacted policy
PUT    /api/admin/mcp/settings                -> validated admin-only policy
GET    /api/graph/...                         -> authorized, read-only projections
```

This API is **not** a general-purpose SQL proxy. Do not expose the service-role key, decrypted Vault view, or configuration-hydration RPC to browser sessions. Never send the secret URL into an HTML response or client bundle. Reject unauthorized and cross-site writes before touching any provider, and audit changes with actor, time and secret-free outcome.

For provider checks, implement explicit least-privilege adapters and provider-specific revocation semantics; a stored credential is not evidence of a successful connection. Multi-account selection must never silently choose the wrong identity. Respect existing FMRL allowlists, exact immutable target SHA, cleanup/404 verification and independent result evaluation. **ATAX never spawns or schedules agents.**

## Remaining release/testing gates

This repo branch introduces the bootstrap loader and database migration **as source**, not a production DB change or live UI. The UI agent (and release reviewer) must:

1. Create a disposable Supabase clone, replay ALL migrations, test the RPC permissions and Vault store/rotate/disable, verify anon/authenticated users cannot read or invoke privileged functions, and confirm database encryption and audit behavior. Do not write test provider secrets into production.
2. Test maintainer MCP and restricted Socket Worker with **only `SUPABASE_URL`** supplied by the runtime. Verify correct owner JWT/bearer, scope denial, credential isolation, unknown/disabled accounts, invalid bootstrap, rotation, revocation, and no secret in responses or logs.
3. Build and test real UI authorization, session/CSRF boundaries, and Vercel server/client bundle separation, including browser network traces. Independently confirm the client has zero privileged credentials.
4. Preserve existing ATAX source/build, task-socket fencing, bounded metering, atomic atomisation, evidence, independent verification and direct connector modes. Restricted Socket V1 is still **not** live-certified; do not enable its relay, migrations or target execution on the strength of source tests alone.

**Handoff acceptance:** the UI reads the latest reviewed `main`, recognizes this document as superseding the earlier read-only-only UI and multi-environment-variable assumptions, offers a functional authorized credential management interface, and can demonstrate MCP startup using the single server-held Supabase URL without any other runtime configuration variable.
