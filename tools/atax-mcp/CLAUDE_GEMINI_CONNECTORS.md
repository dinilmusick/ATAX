# Connect the independent ATAX MCP Worker to Claude and Gemini

## Standalone single-owner design

The ATAX Cloudflare Worker is a **stateless, Streamable HTTP MCP resource server**, not an OAuth provider, agent runtime, or tenant credential vault. ATAX requires only its **own** configured Supabase key, named GitHub and Cloudflare secrets, and an owner authentication scheme. It has **no mandatory Luth, ULTRST, Vercel or third-party authorization-server dependency**.

MCP endpoint: `https://atax-mcp.dextro1n1laevo.workers.dev/mcp`.

## Option A — private single-owner bearer (fastest setup)

Configure in the selected Cloudflare Worker:

- `SUPABASE_URL`: canonical ATAX Supabase URL, non-secret
- `SUPABASE_SECRET_KEY`: canonical ledger server key, **Worker secret**
- `GH_KEY_<ALIAS>`: one or more GitHub account tokens, **Worker secrets**
- `CF_KEY_<ALIAS>`: optional Cloudflare account tokens, **Worker secrets**
- `MCP_SHARED_TOKEN_SHA256`: **SHA-256 hex digest** of a high-entropy, owner-only bearer token, **Worker secret**
- `MCP_SHARED_SUBJECT`: one stable owner subject
- `MCP_SHARED_SCOPES`: only the tools needed for that token; `atax:read atax:write` and separately authorized GitHub/Cloudflare/FMRL scopes as appropriate; verifier must be separately authorized

**Never place the bearer token itself in a Worker plain variable or in source.** Each MCP client that supports an external `Authorization: Bearer <token>` header can use the endpoint directly. An HTTPS client without custom-header support cannot necessarily use this method; do not claim universal client compatibility based on a protocol smoke test.

## Option B — optional standards-based OAuth resource tokens

Some Claude/Gemini connector experiences require OAuth 2.1 authorization rather than an externally supplied bearer header. If such a client requires OAuth, ATAX can be configured as a JWT-verifying **resource server** with an authorization server of the owner's choice. No specific provider is hard-coded.

- `MCP_AUTH_AUTHORIZATION_SERVER`: HTTPS issuer discovery URL advertised to the client
- `MCP_AUTH_ISSUER`: verified token `iss`
- `MCP_AUTH_JWKS_URL`: HTTPS public signing keys (JSON Web Key Set)
- `MCP_AUTH_AUDIENCE`: exact protected MCP resource URL
- `MCP_ATAX_OWNER_JWT_SUBJECT`: the one verified owner `sub`
- `MCP_AUTH_OWNER_SCOPES`: explicit ATAX permissions, excluding independent verifier authority unless separately justified

The selected authorization server must actually support authorization-code flow with PKCE, appropriate client registration and audience-bound access tokens if the client requires them. **The ATAX Worker does not itself issue OAuth access tokens or perform dynamic client registration.** Therefore Option B cannot be certified merely by setting its issuer variables.

## Client setup

For any Claude or Gemini build that supports custom remote MCP connectors, provide the HTTPS endpoint above. Use bearer configuration only where the client exposes a safe Authorization-header setting; otherwise use a separately configured standards-compliant OAuth provider. Check the client's current product/region availability and permitted connection methods before claiming compatibility. These steps are not evidence that Gemini or Claude has actually accepted this Worker.

Once authorized, the client should run `initialize` → `tools/list` → `atax_context` and `atax_skill_get`. When it claims a task, use the returned fencing token for heartbeat and submissions. On expired/lost ownership, call `atax_task_handoff` with the old token, partial results and evidence, then discover another free socket through `atax_task_claim_next` or a goal-scoped claim. **Do not terminate the agent merely because the former task lease was lost.**

## Production acceptance

1. Verify `GET /health` and `POST /mcp` negative-auth behavior; these are not proof of live owner access.
2. Verify the Worker has all required secret binding **names**, never print values.
3. Complete an authenticated owner `initialize`, `tools/list`, `atax_context`, and `atax_skill_get`.
4. Exercise an isolated real ledger task claim, heartbeat and result submission, with independently authorized verification; test denial of a stale token and successful append-only handoff followed by another claim.
5. Verify direct GitHub and Supabase connectors still work independently of the Worker.
6. Verify actual native Claude/Gemini connection for each client separately; classify untested clients as unverified.

The Worker, scripts and account configuration must remain independent of Luth. No credential contents belong in public GitHub, logs, prompts, issues or GitHub Actions artifacts.
