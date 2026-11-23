# ATAX environment configuration: React handoff + existing control plane

> **Architecture transition (23 November 2026):** This document inventories the **currently deployed legacy** Worker configuration; do not mistake it for the future configuration contract. The new [MCP/UI ledger-credential handoff](MCP_UI_LEDGER_CREDENTIALS_HANDOFF.md) supersedes it for new implementation: exactly **one** ATAX MCP/UI server runtime variable, `ATAX_SUPABASE_CONNECTION_URL` (confidential server-only PostgreSQL TLS URI), with other settings and multi-provider secrets managed in canonical Supabase. **The source has not yet completed this migration.** Do not remove existing runtime credentials or weaken authentication until cutover tests pass. Direct GitHub/Supabase connector settings and separate CI/CLI secrets are outside the MCP runtime change.


This is an **inventory and setup contract**, not proof that a UI server or Vercel provider adapter already exists. Source of truth for the existing MCP Worker is `tools/atax-mcp/wrangler.toml`, `worker.mjs`, `provider-accounts.mjs`, `github-tools.mjs` and `OWNER_SETUP.md`. All values in `.env.example` are intentionally blank.

## Security boundary: Google AI Studio and React

**Public React compile-time variable:** `VITE_ATAX_API_BASE_URL` (or the framework-appropriate `NEXT_PUBLIC_ATAX_API_BASE_URL`) may hold a **nonsecret HTTPS URL for a separately authenticated UI backend**, not a Supabase service key. Those prefixes are exposed to browser users. Prefer same-origin relative URLs if supported. This proposed key is **not currently consumed by an ATAX React app**.

**Server-only secrets:** `SUPABASE_SECRET_KEY`, `GH_KEY_<ALIAS>`, `CF_KEY_<ALIAS>`, OAuth client secrets, tokens, and future Vercel tokens **must not be placed in AI Studio's browser-exposed variables**. If the AI Studio project cannot supply an isolated authenticated server runtime / secret store, it can build a static preview but **must not use privileged live credentials**. Do not use a public static website as a proxy for privileged Supabase calls. The browser never connects directly with a Supabase admin/service-role key.

Backend authorization must be independent of whether an origin is on an allowlist; use scoped identities and least-privileged queries/RPCs. Never hardcode credential values in source, prompts, screenshots, logs, commits, or testing artifacts.

## Existing ATAX Worker bindings (owner-only remote MCP)

| Name | Store | Status | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | Nonsecret Worker config | Existing | Canonical ATAX Supabase API origin |
| `SUPABASE_SECRET_KEY` | **Worker secret** | Existing; required for live DB operations | Canonical ledger server key; `SUPABASE_SERVICE_ROLE_KEY` is legacy fallback, not recommended |
| `GH_KEY_<ALIAS>` | **Worker secret** | Existing optional named accounts | GitHub API tools; uppercase alias like `PERSONAL` |
| `CF_KEY_<ALIAS>` | **Worker secret** | Existing optional named accounts | Cloudflare read-only diagnostics; provider-scoped token |
| `MCP_GITHUB_OWNER` | Worker config | Existing | Owner for guarded FMRL controller |
| `MCP_FMRL_ALLOWED_TARGETS` | Worker config | Existing optional | Explicit target allowlist for FMRL control |
| `MCP_SHARED_TOKEN_SHA256` | **Worker secret** | Existing optional owner bearer mode | SHA-256 digest of high-entropy bearer; never store raw bearer in source |
| `MCP_SHARED_SUBJECT`, `MCP_SHARED_SCOPES` | Worker config | Existing owner bearer mode | Identity and explicit permissions; no wildcard |
| `MCP_AUTH_ISSUER`, `MCP_AUTH_JWKS_URL`, `MCP_AUTH_AUDIENCE` | Worker config | Existing optional OAuth resource verifier | Actual issuer, key-set endpoint and expected token audience |
| `MCP_AUTH_AUTHORIZATION_SERVER` | Worker config | Existing optional OAuth discovery | External standards-based authorization server |
| `MCP_ATAX_OWNER_JWT_SUBJECT`, `MCP_AUTH_OWNER_SCOPES` | Worker config | Existing optional OAuth owner admission | Exact verified owner subject and permitted scopes |
| `MCP_ALLOWED_ORIGINS` | Worker config | Existing optional CORS policy | Browser-origin handling; never a replacement for bearer authorization |

`GH_TOKEN_<ALIAS>` and `CLOUDFLARE_TOKEN_<ALIAS>` are accepted legacy aliases. Do **not** configure both old and new tokens for the same alias: existing code fails closed. Each alias matches `[A-Z][A-Z0-9_]{0,47}`. Each provider key is independently stored; never make GitHub connector, direct Supabase connector and MCP credentials interchangeable.

**Vercel:** there is currently **no live Vercel account adapter in `tools/atax-mcp`**. `VERCEL_TOKEN_<ALIAS>` is only a **reserved future server-secret convention**, not consumed, validated or surfaced as a working account today. Adding a value will not enable Vercel calls. Add a dedicated scoped adapter, tests, and a real verified connection before claiming availability.

## Separate deployment and CLI settings

- GitHub Actions `.github/workflows/atax-mcp-deploy.yml` needs repository **secret** `ATAX_MCP_CLOUDFLARE_API_TOKEN` and a manually supplied workflow input `cloudflare_account_id` for target-account selection. Neither is a browser variable.
- Local Supabase CLI/integration setup uses `SUPABASE_PROJECT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` in `supabase/.env.example`; use only in appropriate trusted runtimes.
- The GitHub-only private controller separately requires trusted **GitHub Actions** secrets `SUPABASE_URL`, `SUPABASE_SECRET_KEY` plus variables `ATAX_BRIDGE_REF`, `ATAX_BRIDGE_ALLOWED_ACTORS`; never put these in the public ATAX repository or public PR workflow.
- A future AI Studio read-only React backend needs its **own authentication implementation** and securely bound credentials. No public or documented environment variable makes that currently nonexistent backend operational automatically.

## Configuration verification steps

1. Populate credentials using the hosting provider's **server-side secret manager**; do not commit local `.env` files (the root `.gitignore` excludes them).
2. Confirm required binding **names**, not values. For MCP Worker: check `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, one appropriate owner auth method, and only the named provider tokens required by tools in use.
3. Run `node --check tools/atax-mcp/worker.mjs`, `node --check tools/atax-mcp/provider-accounts.mjs`, and `node --test tools/atax-mcp/*.test.mjs` on an authorized developer environment.
4. Independently test owner-authenticated `initialize`, `tools/list`, `atax_context` and `atax_skill_get` against the exact deployed Worker. Test denial of unauthenticated identities and missing scopes. A health endpoint alone is insufficient.
5. For future React live read-only testing: verify an authenticated backend can access the canonical ledger with correct ownership filtering; inspect the built JS, HTML and network traces for provider tokens and privileged DB credentials; test unauthorized requests fail closed.
6. For Vercel, report `not implemented` until adapter and live tests exist. Do not assert success based on a placeholder variable.

## Non-goals for UI handoff

No secret uploads through the React frontend, no local secret storage, no anonymous privileged API, no synthetic agent heartbeat, no side-effecting CI/deployment from read-only UI, and no replacement of canonical Supabase with client state.
