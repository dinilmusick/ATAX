# ATAX environment configuration: React UI + Data API control plane

> **Canonical Supabase Data API architecture:** Both the ATAX Worker (`worker-dashboard.ts`, `tools/atax-mcp/worker.mjs`) and the local Express server (`server.ts`) connect to Supabase **solely over HTTPS Data API / PostgREST** using `ATAX_SUPABASE_URL` and `ATAX_SUPABASE_SECRET_KEY`. Direct PostgreSQL connection URIs, `postgres.js`, and Hyperdrive bindings are retired and unsupported. All MCP policy settings (`atax_private.mcp_server_settings`), singleton instance auth (`atax_private.instance_auth`, `atax_private.instance_sessions`), and encrypted provider credentials (`atax_private.provider_accounts` + Supabase Vault) live in Supabase and are managed through `/api/settings/*`.

Source of truth for runtime configuration is `wrangler.toml`, `worker-dashboard.ts`, `server/settingsControlPlane.ts`, `server/supabaseVault.ts`, `tools/atax-mcp/data-api-ledger.mjs`, and `tools/atax-mcp/ledger-config.mjs`. All values in `.env.example` are intentionally blank.

## Security boundary: React UI & Server Adapter

**Same-origin browser calls:** The React frontend (`src/`) calls same-origin API routes (`/api/settings/*` and `/api/substrate/*`) without holding any Supabase keys or provider tokens. `VITE_ATAX_API_BASE_URL` (optional) holds only a nonsecret API origin if hosted cross-origin.

**Server-only secrets:** `ATAX_SUPABASE_URL` and `ATAX_SUPABASE_SECRET_KEY` remain strictly server-side (`wrangler secret put` in Cloudflare Workers, `.env` locally). Never bundle them into `VITE_*`, HTML, logs, or API responses.

Backend authorization uses server-verified `atax_settings_session` (`HttpOnly; SameSite=Strict`) cookies for Vault settings mutations and owner-pinned bearer/JWT verification for `/mcp`.

## Canonical ATAX Worker & Local Server Bindings

| Name | Store | Required | Purpose |
| --- | --- | --- | --- |
| `ATAX_SUPABASE_URL` | **Server secret / `.env`** | Yes | Canonical ATAX Supabase HTTPS project URL (`https://<project>.supabase.co`) |
| `ATAX_SUPABASE_SECRET_KEY` | **Server secret / `.env`** | Yes | Server-side Supabase secret key for HTTPS PostgREST / Data API calls |

Legacy aliases `SUPABASE_URL` and `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are accepted by config parsing when `ATAX_SUPABASE_*` is unset.

**Supabase-stored runtime policy & Vault secrets** (loaded via `atax_mcp_runtime_config_v1`, never deployment env vars):
- GitHub & Cloudflare provider tokens: stored encrypted in **Supabase Vault** via `atax_private.provider_accounts` (aliases match `[A-Z][A-Z0-9_]{0,47}`).
- Owner/MCP settings (`MCP_OWNER_SUBJECT`, `MCP_GITHUB_OWNER`, `MCP_SHARED_TOKEN_SHA256`, `MCP_SHARED_SUBJECT`, `MCP_SHARED_SCOPES`, `MCP_AUTH_*`, `SOCKET_*`): stored in `atax_private.mcp_server_settings`.

**Vercel:** there is currently **no live Vercel adapter** (`501 Not Implemented` in `server/supabaseVault.ts`, skipped in `tools/atax-mcp/ledger-config.mjs`).

## Separate deployment and CLI settings

- GitHub Actions `.github/workflows/atax-mcp-deploy.yml` needs repository **secret** `ATAX_MCP_CLOUDFLARE_API_TOKEN` and a manually supplied workflow input `cloudflare_account_id` for target-account selection. Neither is a browser variable.
- Local Supabase CLI/integration setup uses `SUPABASE_PROJECT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` in `supabase/.env.example`; use only in appropriate trusted runtimes.
- The GitHub-only private controller separately requires trusted **GitHub Actions** secrets `SUPABASE_URL`, `SUPABASE_SECRET_KEY` plus variables `ATAX_BRIDGE_REF`, `ATAX_BRIDGE_ALLOWED_ACTORS`; never put these in the public ATAX repository or public PR workflow.
- A future AI Studio read-only React backend needs its **own authentication implementation** and securely bound credentials. No public or documented environment variable makes that currently nonexistent backend operational automatically.

## Configuration verification steps

1. Populate credentials using the hosting provider's **server-side secret manager**; do not commit local `.env` files (the root `.gitignore` excludes them).
2. Confirm required binding **names**, not values: check `ATAX_SUPABASE_URL` and `ATAX_SUPABASE_SECRET_KEY` on the Worker / local `.env`.
3. Run `npm run lint`, `npm test`, `node tests/e2e-data-api/run-all.mjs`, and `node tools/atax-mcp/test-local-agent-e2e.mjs`.
4. Independently test owner-authenticated `initialize`, `tools/list`, `atax_context` and `atax_skill_get` against the exact deployed Worker. Test denial of unauthenticated identities and missing scopes. A health endpoint alone is insufficient.
5. For future React live read-only testing: verify an authenticated backend can access the canonical ledger with correct ownership filtering; inspect the built JS, HTML and network traces for provider tokens and privileged DB credentials; test unauthorized requests fail closed.
6. For Vercel, report `not implemented` until adapter and live tests exist. Do not assert success based on a placeholder variable.

## Non-goals for UI handoff

No secret uploads through the React frontend, no local secret storage, no anonymous privileged API, no synthetic agent heartbeat, no side-effecting CI/deployment from read-only UI, and no replacement of canonical Supabase with client state.
