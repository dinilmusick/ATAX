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

## MCP client configuration

Configure your MCP client with a remote Streamable HTTP URL and a bearer Authorization header:

```text
MCP server URL: https://<your-worker-hostname>/mcp
Authorization: Bearer <your-client-access-token>
```

An authenticated client sends `initialize`, `notifications/initialized`, `tools/list`, then `tools/call` (e.g. `atax_context`) to hydrate live state. For work, call `atax_skill_get` and `atax_goal_overview`, then claim work with fenced task tools. `atax_verification_claim` must run with an **independent verifier identity**; never self-certify. See `tools/list` for current schemas.

## Parity and tests

`node --test worker.test.mjs` exercises both negative and positive protocol handshakes, CORS and origin checks, tool/resource discovery, credential denial, RSA JWKS verification, guarded RPC mappings, claim/heartbeat/submission mappings and verifier-scope segregation without making production writes. This is a **local contract test**; it does not assert a deployed Supabase integration is working.

Production acceptance requires, on the *selected* Cloudflare account: bound secrets and identity provider, a live `/mcp` handshake, actual scoped `atax_context` and `atax_skill_get`, an isolated **real** task claim→heartbeat→submit→independent verifier→finalize (with separately authorized identities), denial of an unauthorized client, and regression checks that direct GitHub+Supabase access still works during an MCP outage. Record exact evidence on the feature issue. Never mutate unrelated production tasks for smoke testing.

## Boundaries

ATAX is only a coordination control plane and tooling provider. This gateway neither creates external agents nor schedules them. It never executes target code; ATAX's existing container-first and disposable FMRL compute boundary remains in force. Remote MCP outages must not affect GitHub-native agents.
## Governed work authoring (MCP-only agents)

The server supports canonical creation and maintenance through named, **allowlisted** PostgreSQL RPCs. `atax:write` permits Vision creation/target/board association, bounded and Omni goal creation, goal and task dependencies, goal priority, and loop contracts. `atax:read` exposes goal resumes, blockers and self-improvement context, while `atax:verify` exposes pending verification. These do not spawn or schedule agents, execute arbitrary SQL, or bypass database acceptance and fencing guards.

Vision-linked Omni goals require an actual target and existing attached tldraw board, as enforced by Supabase.

**Canonical System association:** New MCP goals require a `system_key` and call the additive, service-role-only `atax_goal_create_system_bounded` / `atax_goal_create_system_omni` RPCs. Each delegates to the original goal-creation RPC, then atomically attaches the goal and its finite tasks to a real active System. `atax_goal_attach_system` also safely repairs existing unlinked, non-running goals. The database rejects reassignment to another System. The checked-in SQL migration must be applied before enabling the corresponding MCP tools.

## Build and independent verification

The CI job checks the deterministic, secret-free protocol/auth suite and a Cloudflare Wrangler deploy dry-run. A dry-run confirms Worker packaging only, not credentials or live Supabase calls. Production release requires authenticated read/write/verifier tests and independent evidence without secrets.
