# ATAX Remote MCP Gateway

This is an **additive remote Model Context Protocol (MCP) adapter**, not an alternative ATAX implementation. ATAX's existing GitHub-native repository/tools access and direct Supabase connector operations remain available and **do not call this Worker**. Both paths read/write the **same canonical Supabase records and RPCs**.

## Runtime

- Stateless Cloudflare Workers `fetch` service, **Streamable HTTP** `POST /mcp` (JSON-RPC 2.0, MCP `2025-06-18`, also accepting `2025-03-26`); no custom agent process, resident runtime, scheduling, polling, queuing or autonomous actions.
- `GET /health`: non-sensitive liveness. `GET /mcp`: 405 because the server is stateless and does not offer a stand-alone SSE notification stream. `DELETE /mcp`: 405 (no MCP sessions). `POST /mcp`: initialize, ping, tools/list, tools/call, resources/list, resources/templates/list, resources/read, prompts/list, notifications/initialized. Batched JSON-RPC messages are accepted.
- Exactly defined, schema-validated `atax_*` tools backed by canonical PostgREST RPCs; **no generic SQL or arbitrary RPC execution**. Live skill instructions come from the Supabase Skills Database.
- A verified token principal supplies every agent/verifier identity. The caller may never pass an impersonated `agent_id` or bypass task claim tokens. Lease fencing, loop contracts, submission and independent verification remain enforced by PostgreSQL.

## Secure configuration

Deploy to a selected Cloudflare account using Wrangler from this directory (Node 22+):

```bash
node --test worker.test.mjs
npx wrangler deploy
```

`SUPABASE_URL` is a non-secret variable in `wrangler.toml`. Before deployment, provision the Supabase **server-side** key through your chosen Cloudflare account's Worker secret configuration:

```bash
npx wrangler secret put SUPABASE_SECRET_KEY
# or legacy credential: npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Choose **one** of these authentication mechanisms:

1. **Recommended**: Configure `MCP_AUTH_JWKS_URL`, `MCP_AUTH_ISSUER`, and `MCP_AUTH_AUDIENCE` as Worker secrets/variables. Clients present signed RS256 JWTs with matching issuer, audience, expiry, and per-client `scope` claims (`atax:read`, `atax:write`, or `atax:verify`). Every client needs a distinct stable JWT `sub` value. Protect your OIDC identity provider and only issue those scopes to approved agents. `MCP_AUTH_AUTHORIZATION_SERVER` optionally sets the resource metadata authorization server URL; ATAX does not mint tokens.
2. **Single-owner bootstrap**: Generate a **random 48+ byte** bearer token outside the repo, store only its SHA-256 hex digest as the `MCP_SHARED_TOKEN_SHA256` Worker secret, and configure `MCP_SHARED_SUBJECT` and `MCP_SHARED_SCOPES` (space separated). Use **read-only by default**. Do not share the same token between an executing worker and its independent verifier; for distinct principals prefer JWT mode. Neither the bearer token nor any Supabase secret belongs in source, issues, tests, logs or chats.

A sample credential-generation sequence *on your own trusted machine*:

```bash
TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
printf %s "$TOKEN" | shasum -a 256 | awk '{print $1}'
# Secret-store only the digest as MCP_SHARED_TOKEN_SHA256.
# Supply TOKEN securely to your MCP client; never commit or paste it into issues.
```

Optional `MCP_ALLOWED_ORIGINS` (comma-separated exact HTTPS origin strings) enables browser CORS and Origin checking; unlisted browser origins are rejected. Non-browser clients usually omit Origin. Authentication is **fail-closed** if mandatory DB or token configuration is missing. Only HTTPS JWKS endpoints are accepted; unknown signature keys, expired/invalid JWTs, missing scopes and malformed input are rejected. Set Cloudflare Access/WAF rate limits separately before exposing the service publicly.

**Important:** Current ATAX is a single-owner Supabase project. This adapter must **not** be advertised as multi-tenant without proper per-owner authorization, JWT/RLS boundaries, and tenant isolation. `SUPABASE_SECRET_KEY`/service-role credentials must remain server-side only.


## First-class GitHub and disposable FMRL tools

The server exposes `atax_github_workflows_guide` (always read first), `atax_github_repository_create` and `atax_github_repository_inspect` for permanent repositories, plus `atax_fmrl_create_run_dispose` and `atax_fmrl_get_status` for **automatic provision → run → mandatory delete and independent 404**. The FMRL tools call the existing ATAX GitHub Actions *controller*, never run target code in ATAX. Tools have distinct operator permissions: `atax:github:read`, `atax:github:create` and `atax:fmrl:execute`. Set `MCP_GITHUB_OWNER`, `MCP_FMRL_ALLOWED_TARGETS`, `GITHUB_REPOSITORY_TOKEN` and `GITHUB_FMRL_DISPATCH_TOKEN` (tokens are Worker secrets). FMRL dispatch is disabled without an explicit target-repository allowlist. Full setup, security and agent examples: [GITHUB_TOOLS.md](GITHUB_TOOLS.md).


## Named GitHub, Cloudflare, and Vercel accounts

For a **single owner-operated ATAX server**, add as many Cloudflare Worker secrets as needed. The suffix is the account alias; the braces in GH_TOKEN_<ALIAS> are placeholders, not literal characters.

| Worker secret | Use |
| --- | --- |
| GH_TOKEN_PERSONAL | GitHub personal token |
| GH_TOKEN_WORK | GitHub work token |
| CLOUDFLARE_TOKEN_PERSONAL | Cloudflare API token |
| CLOUDFLARE_TOKEN_WORK | Second Cloudflare API token |
| VERCEL_TOKEN_PERSONAL | Vercel personal token |
| VERCEL_TOKEN_WORK | Second Vercel token |

Run from this directory (the actual credential is entered securely in the terminal, never committed):

```bash
npx wrangler secret put GH_TOKEN_PERSONAL
npx wrangler secret put GH_TOKEN_WORK
npx wrangler secret put CLOUDFLARE_TOKEN_PERSONAL
npx wrangler secret put VERCEL_TOKEN_PERSONAL
```

A new correctly named secret appears automatically through `atax_provider_accounts_list`; no code change is needed for additional aliases. If exactly one permitted credential exists for a provider, `account` can be omitted. If multiple accounts exist, pass `account: "WORK"` (or another alias). Values never appear in tools/list, tool responses, or logs.

GitHub `atax_github_repository_inspect` and `atax_github_repository_create` use the named account credential and verify the resulting repository identity. Existing `GITHUB_REPOSITORY_TOKEN` remains as a legacy single-account fallback when no named GitHub tokens exist. FMRL CI dispatch continues to use `GITHUB_FMRL_DISPATCH_TOKEN` and its canonical allowlist.

Cloudflare `atax_cloudflare_accounts_list` discovers account IDs reachable with the selected token; `atax_cloudflare_workers_list` accepts an `account_id`, or a non-secret `CLOUDFLARE_ACCOUNT_ID_WORK` binding can pin the WORK account. Vercel `atax_vercel_projects_list` and `atax_vercel_deployments_list` can be scoped to a Vercel team via non-secret `VERCEL_TEAM_ID_WORK`. They are **read-only diagnostic operations**. Authentication, provider permissions and sufficient token scopes are required; simply setting a token does not magically create write/deployment capabilities.

For the existing bootstrap bearer, **verified shared-token authentication provenance** plus `MCP_SHARED_SUBJECT` identifies the owner principal and allows configured aliases subject to the MCP tool scopes (e.g. `atax:github:read`, `atax:github:create`, `atax:cloudflare:read`, `atax:vercel:read`). A signed JWT bearing the **same** `sub` as `MCP_SHARED_SUBJECT` is **not** a bootstrap bearer and receives no owner wildcard; it needs an explicit grant like every other JWT identity. Any other signed JWT subject is **denied by default** and requires an explicit, non-secret `MCP_PROVIDER_ACCOUNT_GRANTS` JSON binding, for example `{"developer-2":{"github":["WORK"],"cloudflare":["WORK"],"vercel":["WORK"]}}`. Never distribute the owner's bootstrap bearer to other users. Provider-native OAuth connections remain separate from these owner-controlled Worker secrets. Prefer provider-scoped limited permissions over full-access tokens.

## MCP client configuration

Configure your MCP client with a remote Streamable HTTP URL and a bearer Authorization header:

```text
MCP server URL: https://<your-worker-hostname>/mcp
Authorization: Bearer <your-client-access-token>
```

An authenticated client sends `initialize`, `notifications/initialized`, `tools/list`, then `tools/call` (e.g. `atax_context`) to hydrate live state. For work, call `atax_skill_get` and `atax_goal_overview`, then claim work with fenced task tools. `atax_verification_claim` must run with an **independent verifier identity**; never self-certify. See `tools/list` for current schemas.

## Parity and tests

`node --test *.test.mjs` exercises both negative and positive protocol handshakes, CORS and origin checks, tool/resource discovery, credential denial, RSA JWKS verification, guarded RPC mappings, claim/heartbeat/submission mappings and verifier-scope segregation without making production writes. This is a **local contract test**; it does not assert a deployed Supabase integration is working.

Production acceptance requires, on the *selected* Cloudflare account: bound secrets and identity provider, a live `/mcp` handshake, actual scoped `atax_context` and `atax_skill_get`, an isolated **real** task claim→heartbeat→submit→independent verifier→finalize (with separately authorized identities), denial of an unauthorized client, and regression checks that direct GitHub+Supabase access still works during an MCP outage. Record exact evidence on the feature issue. Never mutate unrelated production tasks for smoke testing.

## Boundaries

ATAX is only a coordination control plane and tooling provider. This gateway neither creates external agents nor schedules them. It never executes target code; ATAX's existing container-first and disposable FMRL compute boundary remains in force. Remote MCP outages must not affect GitHub-native agents.
