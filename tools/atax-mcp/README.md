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

`SUPABASE_URL` is a non-secret variable in `wrangler.toml`. Before deployment, provision the Supabase **server-side** key and any named provider keys through your chosen Cloudflare account's Worker secret configuration. See [OWNER_SETUP.md](OWNER_SETUP.md) for the exact account naming contract:

```bash
npx wrangler secret put SUPABASE_SECRET_KEY
# or legacy credential: npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Choose **one** of these authentication mechanisms:

1. **Recommended**: Configure `MCP_AUTH_JWKS_URL`, `MCP_AUTH_ISSUER`, and `MCP_AUTH_AUDIENCE` for signed, audience-bound resource tokens. Configure **exactly one verified owner** using `MCP_ATAX_OWNER_JWT_SUBJECT`, with scoped permissions in `MCP_AUTH_OWNER_SCOPES`. The gateway refuses non-owner subjects even if their JWT includes `atax:*` scopes. `MCP_AUTH_AUTHORIZATION_SERVER` optionally sets protected-resource metadata; ATAX does not mint tokens.
2. **Single-owner bootstrap**: Generate a **random 48+ byte** bearer token outside the repo, store only its SHA-256 hex digest as the `MCP_SHARED_TOKEN_SHA256` Worker secret, and configure `MCP_SHARED_SUBJECT` and `MCP_SHARED_SCOPES` (space separated). Use **read-only by default**. Do not share the same token between an executing worker and its independent verifier; for distinct principals prefer JWT mode. Neither the bearer token nor any Supabase secret belongs in source, issues, tests, logs or chats.

A sample credential-generation sequence *on your own trusted machine*:

```bash
TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
printf %s "$TOKEN" | shasum -a 256 | awk '{print $1}'
# Secret-store only the digest as MCP_SHARED_TOKEN_SHA256.
# Supply TOKEN securely to your MCP client; never commit or paste it into issues.
```

Optional `MCP_ALLOWED_ORIGINS` (comma-separated exact HTTPS origin strings) enables browser CORS and Origin checking; unlisted browser origins are rejected. Non-browser clients usually omit Origin. Authentication is **fail-closed** if mandatory DB or token configuration is missing. Only HTTPS JWKS endpoints are accepted; unknown signature keys, expired/invalid JWTs, missing scopes and malformed input are rejected. Set Cloudflare Access/WAF rate limits separately before exposing the service publicly.

**Important:** This is deliberately a **single-owner** gateway. No multi-user BYOC onboarding, tenant credential storage, or shared access to the owner's ledger is supported. `SUPABASE_SECRET_KEY`/service-role credentials must remain server-side only.


## First-class GitHub and disposable FMRL tools

The server exposes `atax_github_workflows_guide` (always read first), `atax_github_repository_create` and `atax_github_repository_inspect` for permanent repositories, plus `atax_fmrl_create_run_dispose` and `atax_fmrl_get_status` for **automatic provision → run → mandatory delete and independent 404**. The FMRL tools call the existing ATAX GitHub Actions *controller*, never run target code in ATAX. Tools have distinct operator permissions: `atax:github:read`, `atax:github:create` and `atax:fmrl:execute`. Set `MCP_GITHUB_OWNER`, `MCP_FMRL_ALLOWED_TARGETS`, and at least one named `GH_KEY_<ALIAS>` Worker secret with the appropriate repository/Actions rights. The FMRL tools take an optional `account` selector and use that same named token for dispatch/status. FMRL dispatch is disabled without an explicit target-repository allowlist. Full setup, security and agent examples: [GITHUB_TOOLS.md](GITHUB_TOOLS.md).


## Single-owner provider secrets — no multi-user BYOC

See **[OWNER_SETUP.md](OWNER_SETUP.md)** for the complete, authoritative credential map, GitHub repository secrets boundary, and direct-GitHub/Supabase connector parity rules.

| Worker secret | Function |
| --- | --- |
| `GH_KEY_PERSONAL`, `GH_KEY_WORK`, `GH_KEY_<ALIAS>` | Dynamically selected named GitHub accounts |
| `CF_KEY_PERSONAL`, `CF_KEY_WORK`, `CF_KEY_<ALIAS>` | Dynamically selected named Cloudflare accounts |
| `SUPABASE_SECRET_KEY` | The one canonical ATAX ledger, server-side only |

`GH_TOKEN_<ALIAS>` and `CLOUDFLARE_TOKEN_<ALIAS>` remain supported during migration. Duplicate alias bindings fail closed; secret *values* never appear in MCP tool results. Use `atax_provider_accounts_list` to discover names, then pass the explicit `account` selector when more than one is configured. **Vercel is deferred**, and no per-user database/vault or tenant routing is used.

GitHub **repository secrets** and Cloudflare **Worker secrets** are independent stores. The same alias names can be configured in both, but GitHub Actions must explicitly map its own repository secrets into trusted workflow jobs; ordinary direct ChatGPT GitHub/Supabase connectors use their existing connector authentication. **Neither direct connector depends on this Worker.**

## Canonical single-owner admission

The Worker uses one Supabase server-side key for the same ledger accessed directly through the ChatGPT Supabase connector. It admits canonical ledger tools, provider tools, resources and prompts **only to the verified owner**, identified by (1) the actually verified bootstrap bearer and its exact shared subject, or (2) the verified OAuth JWT subject pinned in `MCP_ATAX_OWNER_JWT_SUBJECT`. The signed JWT's scope claims alone are never enough to gain owner access. Required per-tool scopes still apply after owner authentication.

There is **no** provider-account delegation table, per-user vault, tenant enrollment, or separate ATAX database. Cloudflare provider tools are diagnostics only; the direct GitHub/Supabase connector path keeps operating independently. A separate verifier identity and properly scoped verification authority remain required by ATAX's task governance.

## MCP client configuration

Configure your MCP client with a remote Streamable HTTP URL and a bearer Authorization header:

```text
MCP server URL: https://<your-worker-hostname>/mcp
Authorization: Bearer <your-client-access-token>
```

**When claim validation fails:** the agent stops updating the old task and calls `atax_task_handoff` with `task_id`, the lost `claim_token`, a partial-work note and optional evidence context. The event is append-only and does **not** renew the old claim. The same external agent then calls `atax_task_claim_next` or `atax_goal_claim_task` to occupy another available socket. Do not terminate the overall session merely because one lease expired.

An authenticated client sends `initialize`, `notifications/initialized`, `tools/list`, then `tools/call` (e.g. `atax_context`) to hydrate live state. For work, call `atax_skill_get` and `atax_goal_overview`, then claim work with fenced task tools. `atax_verification_claim` must run with an **independent verifier identity**; never self-certify. See `tools/list` for current schemas.

## Parity and tests

`node --test *.test.mjs` exercises both negative and positive protocol handshakes, CORS and origin checks, tool/resource discovery, credential denial, RSA JWKS verification, guarded RPC mappings, claim/heartbeat/submission mappings and verifier-scope segregation without making production writes. This is a **local contract test**; it does not assert a deployed Supabase integration is working.

Production acceptance requires, on the *selected* Cloudflare account: bound secrets and identity provider, a live `/mcp` handshake, actual scoped `atax_context` and `atax_skill_get`, an isolated **real** task claim→heartbeat→submit→independent verifier→finalize (with separately authorized identities), denial of an unauthorized client, and regression checks that direct GitHub+Supabase access still works during an MCP outage. Record exact evidence on the feature issue. Never mutate unrelated production tasks for smoke testing.

## Boundaries

ATAX is only a coordination control plane and tooling provider. This gateway neither creates external agents nor schedules them. It never executes target code; ATAX's existing container-first and disposable FMRL compute boundary remains in force. Remote MCP outages must not affect GitHub-native agents.
