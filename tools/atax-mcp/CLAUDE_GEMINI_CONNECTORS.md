# Connect ATAX Remote MCP to Claude and Gemini

## Overview

The ATAX Cloudflare Worker (`worker-dashboard.ts` -> `tools/atax-mcp/worker.mjs`) exposes a **stateless, Streamable HTTP MCP resource server** at:

- Live endpoint: `https://atax.dextro1n1laevo.workers.dev/mcp`

ATAX is strictly the **MCP protected resource server**, never an OAuth token issuer or tenant vault:

- **Authorization Server:** Canonical ATAX Supabase Auth (`https://<project>.supabase.co/auth/v1`) with Google sign-in and OAuth 2.1 Dynamic Client Registration (`/auth/v1/oauth/clients/register`).
- **Owner Mapping:** Authenticated Supabase Auth user UUID (`sub`) is matched against `MCP_ATAX_OWNER_JWT_SUBJECT` in `atax_private.mcp_server_settings`. A valid Google login alone never grants ATAX owner access.
- **Provider Credentials:** GitHub and Cloudflare tokens are encrypted in **Supabase Vault** (`atax_private.provider_accounts`), managed in the Settings UI (`/api/settings/providers`), and never pasted into Claude or Gemini.

## Primary Path — Supabase OAuth 2.1 (URL-Only Discovery + Dynamic Registration)

MCP clients that support RFC 9728 Protected Resource Metadata, RFC 8414 / OIDC discovery, PKCE (`S256`), and RFC 7591 Dynamic Client Registration (such as Gemini and Claude custom remote MCP connectors) require **only** the `/mcp` HTTPS URL.

### How discovery and authentication work

1. Client sends unauthenticated `POST /mcp` -> Worker returns `401 Unauthorized` with:
   `WWW-Authenticate: Bearer resource_metadata="https://atax.dextro1n1laevo.workers.dev/.well-known/oauth-protected-resource/mcp"`
2. Client fetches `/.well-known/oauth-protected-resource/mcp` (or `/.well-known/oauth-protected-resource`) and receives:
   - `authorization_servers`: `["https://<project>.supabase.co/auth/v1"]`
   - `registration_endpoint`: `"https://<project>.supabase.co/auth/v1/oauth/clients/register"`
   - `scopes_supported`: `["openid", "profile", "email", "offline_access"]`
3. Clients that also probe `/.well-known/oauth-authorization-server`, `/.well-known/oauth-authorization-server/mcp`, or `/.well-known/openid-configuration` on the Worker receive the proxied Supabase OIDC discovery metadata directly (including `authorization_endpoint`, `token_endpoint`, `jwks_uri`, and `registration_endpoint`).
4. Client dynamically registers with Supabase Auth, completes Authorization Code + PKCE with Google sign-in and consent, and sends the resulting Supabase JWT (`ES256`/`RS256`, `typ: 'JWT'` or `'at+jwt'`) as `Authorization: Bearer <access_token>`.
5. Worker verifies JWT signature against cached Supabase JWKS (`/.well-known/jwks.json`), validates `iss`, `aud` (`authenticated` or configured resource URLs), `exp`, `nbf`, `sub`, and `client_id`/`azp` format, then pins ATAX owner scopes from `MCP_AUTH_OWNER_SCOPES` only when `sub === MCP_ATAX_OWNER_JWT_SUBJECT`.

### Connect Gemini or Claude

1. Open custom remote MCP connector / extension settings in Gemini or Claude.
2. Enter **only** the remote MCP URL:
   `https://atax.dextro1n1laevo.workers.dev/mcp`
3. When prompted to authenticate, sign in with the **owner's Google account** authorized in Supabase Auth and approve consent.
4. Never paste Supabase secret keys, Cloudflare tokens, or GitHub PATs into the client.

## Secondary Path — Single-Owner Shared Bearer Token (Bootstrap / Headless CLI)

For automated scripts or clients without OAuth 2.1 UI flows, the Worker also retains support for a single-owner shared bearer token hashed via SHA-256 (`MCP_SHARED_TOKEN_SHA256`, `MCP_SHARED_SUBJECT`, `MCP_SHARED_SCOPES` in `atax_private.mcp_server_settings`). Never store the plaintext bearer token in source, Wrangler `[vars]`, or logs.

## Using Multiple GitHub Accounts Over MCP

- Call `atax_provider_accounts_list` to see configured GitHub aliases (e.g., `PERSONAL`, `WORK`) without exposing tokens.
- Pass `account: "<ALIAS>"` to GitHub and FMRL tools (`atax_github_repository_inspect`, `atax_github_repository_create`, `atax_github_workflow_dispatch`, `atax_github_workflow_runs`, `atax_github_check_runs`, `atax_github_file_get`, `atax_github_file_put`, `atax_github_pull_request_create`, `atax_fmrl_create_run_dispose`, `atax_fmrl_get_status`).
- When multiple GitHub accounts are registered, omitting `account` fails closed (`Specify an account alias when multiple accounts are configured`).
- For FMRL CI, `atax_fmrl_create_run_dispose` returns `dispatched_account`; pass the same `account` (and optionally `dispatched_account`) to `atax_fmrl_get_status` to prevent cross-account polling mismatches.

## Post-Deployment Verification Checklist

1. `GET /health` -> `200` with `"databaseTransport": "supabase-data-api"`.
2. `GET /.well-known/oauth-protected-resource` -> `200` with `authorization_servers` and `registration_endpoint` ending in `/auth/v1/oauth/clients/register`.
3. `GET /.well-known/oauth-authorization-server` -> `200` with Supabase OIDC metadata (`token_endpoint`, `jwks_uri`, `registration_endpoint`).
4. `POST /mcp` without token -> `401` with `WWW-Authenticate` challenge pointing to `/.well-known/oauth-protected-resource/mcp`.
5. Owner OAuth login -> `initialize` -> `tools/list` -> `atax_context` -> `atax_provider_accounts_list` -> scoped GitHub inspection.
6. Verify unauthorized Google users receive zero owner tools (`atax_context`, `atax_provider_accounts_list`, GitHub, and FMRL tools are absent).
