# Connect ATAX to Claude and Gemini via canonical Luth OAuth

## Architecture

ATAX runs a stateless, publicly addressable Streamable HTTP MCP resource server.
Luth is the **only** OAuth 2.1 authorization server and owns authentication,
consent, RFC 7591 Dynamic Client Registration (DCR), token and refresh issuance.
ATAX does not issue client IDs, client secrets, or OAuth tokens.

| Connection field | Value |
| --- | --- |
| Connector name | ATAX |
| MCP Server URL | `https://atax-mcp.dextro1n1laevo.workers.dev/mcp` |
| OAuth authorization server | `https://luth.blueprint-ninjastudios.workers.dev/api/auth` (verify exact issuer from live metadata) |
| OAuth client ID / secret | Leave blank for **dynamic registration**. Luth creates unique credentials per client. |
| Authentication | OAuth authorization code + S256 PKCE; consent in Luth |
| Required resource audience | Exact MCP URL above |
| OAuth login scopes | `openid profile email offline_access` |
| ATAX capability scopes | **Not granted by OAuth scopes alone**. Server-side owner allowlist and explicit `MCP_AUTH_OWNER_SCOPES` policy are both required. |

## Required production setup

Set these on the `atax-mcp` Worker (Cloudflare account `dextro1n1laevo`):

- `SUPABASE_URL` — canonical ATAX project API URL, non-secret
- `SUPABASE_SECRET_KEY` — dedicated privileged Supabase key, Cloudflare **secret** only
- `MCP_AUTH_AUTHORIZATION_SERVER` — exact issuer from Luth live metadata
- `MCP_AUTH_ISSUER` — exact `iss` in Luth resource access tokens
- `MCP_AUTH_JWKS_URL` — actual live Better Auth JWKS endpoint
- `MCP_AUTH_AUDIENCE` — exactly `https://atax-mcp.dextro1n1laevo.workers.dev/mcp`
- `MCP_ATAX_OWNER_JWT_SUBJECT` — explicit Luth *owner user's verified* `sub` (not an email/domain/Origin)
- `MCP_AUTH_OWNER_SCOPES` — policy e.g. `atax:read atax:write` (avoid `atax:verify` on the same identity as task execution)

Do not place any tokens, credentials, personal identifiers, or secrets in this file,
source, issues, CI logs or chat. Existing shared bearer token bootstrap remains
isolated and must not be distributed to Claude or Gemini.

Luth must **register the ATAX MCP URL as an OAuth protected resource** and
link each connector client to that resource. Better Auth issues a JWT resource
access token only when a resource is requested; it may otherwise issue an opaque
token that ATAX correctly rejects. Use the official Better Auth resource
registration and per-client grants. Retain `enforcePerClientResources`: do not
globally disable audience restrictions merely to get onboarding working.

## Connect in Claude

Claude → Customize → Connectors → Add custom connector.
Name: `ATAX`. MCP server URL: above. Add, connect, authorize in Luth,
and consent. Do not supply a static client ID/secret if DCR succeeds.
Claude's custom connector authentication is managed by Claude's account.

## Connect in Gemini Apps

Open `https://gemini.google.com/devmode`. Create new custom MCP app,
enter the same HTTPS MCP server URL, leave advanced client ID and secret blank
for DCR, and select Dynamic Client Registration under Authentication.
Authorize in Luth and inspect discovered tool schemas and Event Log.
If your Gemini UI requires manual client credentials, register a separate
client at Luth's `/api/auth/oauth2/register` and store the resulting
client secret in Gemini's secure configuration rather than in ATAX source.

## Certification checks (do not claim success without live evidence)

1. `GET /health` returns 200 and stateless MCP protocol information.
2. Both `/.well-known/oauth-protected-resource` and path-specific `/mcp` discovery return `resource` and exact Luth authorization server.
3. Luth's live OAuth metadata returns 200 with valid `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `response_types_supported: ["code"]` (or containing it), and PKCE S256.
4. Real Claude and Gemini clients perform DCR → login/consent → token exchange. Tokens are issued for the exact MCP resource, not a broad Luth-only audience.
5. `initialize`, `tools/list`, `atax_context`, and `atax_skill_get` succeed for a configured owner identity.
6. Missing, invalid, expired, wrong-audience, non-owner and insufficient-scope tokens fail closed.
7. Independent verifier is a **distinct** identity; task lease claims, scoped writes, result submission and verification are tested without self-verification.
8. CI checks the exact source commit; deploy only with credentials configured and finish a live two-provider test.

**Status:** Source support and contract tests are not proof of deployed production
configuration or successful third-party OAuth login. Public URLs and issuer
must be probed from a network-enabled environment before user onboarding.
