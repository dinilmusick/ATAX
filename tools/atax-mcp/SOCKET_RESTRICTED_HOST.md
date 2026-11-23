# ATAX Socket V1 — Restricted host contract

## Two separate deployment surfaces

- Existing **worker.mjs** / **wrangler.toml** stays the independently authorized maintainer MCP gateway. Agent C does not change its tools.
- New **socket-worker.mjs** / **wrangler.socket.toml** is an isolated restricted Worker entrypoint; it imports no maintainer tool registry, GitHub provider, generic SQL, filesystem or arbitrary HTTP tool.

The restricted host MUST expose **only this socket MCP server** to task-bound agents. Disable all host-provided GitHub, Supabase, Cloudflare, terminal, filesystem, unrestricted browser, HTTP, and other provider connectors in that agent's tool environment. Do not give it a maintainer endpoint or maintainer token. A prompt cannot revoke host capabilities; ATAX cannot guarantee isolation if unrelated connectors remain available. Maintain independent maintainer access outside socket mode.

## MCP allowlist

| Tool | Scope | Operation |
| --- | --- | --- |
| atax_socket_context_pull | socket:context:read | Metered context page, limit 1–16 |
| atax_socket_output_submit | socket:output:submit | Bounded task output only, no target edit |
| atax_socket_atomisation_request | socket:atomise:request | Fenced stop/atomisation request |
| atax_socket_workflow_request | socket:workflow:request | Typed outbox intent, not direct GitHub dispatch |
| atax_socket_task_status | socket:task:status | Metered minimal task status |

MCP protocol discovery and handshakes (`initialize`, `ping`, `tools/list`, `resources/list`, `prompts/list`, unknown methods and the initialized notification) are **not free side channels**. Each authenticated valid JSON-RPC message invokes the canonical fenced `protocol` transaction under `socket:protocol` capability. Revoked capability, expired lease and stale fence must deny even discovery. Input, retry and full fixed output frame are cumulatively charged, with overflow forcing atomisation. Malformed unauthenticated transport is rejected before a socket can be identified; ingress rate limiting is a separate host responsibility.

Direct repository modifications, arbitrary SQL, unrestricted file reads and provider calls are **not tools**. Every call is bound to the signed principal, session and task ID, canonical active fenced claim, current lease, canonical task capability and cumulative input/output quota. Cross-task use, revoked capabilities and stale claims always fail closed. Repeated context reads and retries count cumulatively. Overflow requires a durable atomic stop → atomise → release transaction with partial progress preserved.

The signed OAuth resource token must be an RSA RS256 at+jwt access token with exact HTTPS issuer, audience and approved client (azp); sub, iat, exp, atax_task_id, atax_session_id and atax_claim_token are required. Expiry is at most 30 minutes. The gateway does not mint identities or accept identity in tool args. Browser Origin headers are denied.

## Deployment configuration

Deploy the separate Worker using npx wrangler deploy --config tools/atax-mcp/wrangler.socket.toml **only after reconciliation and independent verification**.

**New single-bootstrap contract:** the only Worker environment binding is the server-only secret `SUPABASE_URL` with `#key=<privileged-server-key>` in its fragment. The runtime loads `SOCKET_AUTH_ISSUER`, `SOCKET_AUTH_JWKS_URL`, `SOCKET_AUTH_AUDIENCE`, `SOCKET_AUTH_CLIENT_ID` and `SOCKET_WORKFLOW_CATALOG_JSON` from canonical Supabase settings, NOT deployment environment variables. See docs/MCP_LEDGER_CONFIG_UI_HANDOFF.md.  The workflow catalog is a JSON object of approved workflow keys to permitted input names, e.g. {"safe_ci":{"revision":"sha"}}. Supported workflow input types are sha (40 hexadecimal characters), uuid, slug, integer and boolean; input names and value types are both checked. Empty or malformed catalog disables workflow requests. Do not inject GitHub or Cloudflare secrets into this Worker.

## Production adapter contract for Agents A, B and D

Agent C intentionally uses **own fake adapters for tests** and never writes to Agent B's migration paths. The production Worker calls one canonical server-side transaction: POST /rest/v1/rpc/atax_socket_execute_v1 with a single JSON argument named command_in. This RPC must be implemented by the final reconciler, using the independent Agent A/B/D work, before enabling socket execution.

Command fields: operation, capability, principalId, sessionId, taskId, claimToken, payload, inboundTokens, replyId, maxReplyBytes, rejectReason. For `operation=protocol`, add `replyFrame` (the **exact gateway-authored JSON-RPC wire response**, or empty string for acknowledged notifications) and require `capability=socket:protocol`. The transaction verifies the current claim and meters this frame **before** its contents are returned to the agent. No mutable client-provided response frame is accepted. If the canonical RPC does not implement this operation, protocol requests fail closed; the maintainer MCP endpoint remains separate.

The RPC MUST in one durable PostgreSQL transaction:

1. Validate current principal, signed session and task identity, active claim, lease expiry, claim fencing token and task-specific capabilities (also at the DB boundary, not merely by trusting JWT scope).
2. Meter cumulative input per invocation including retries and repeated reads, and reserve the entire bounded MCP response output **before** returning it, using the calibrated Agent A model profile. No unbounded context, credentials or tool-result bypass.
3. On budget exhaustion atomically persist the overflow and partial progress, block execution, create the Agent B atomisation handoff and release the old execution fence. No continued execution under a stale claim.
4. Return either a bounded success result with charged inputTokens/outputTokens receipt or a stable denied error code. Reject oversized output after metering its inbound payload.
5. For workflow requests, verify the task-specific typed grant and insert an auditable idempotent outbox intent; Agent D's separately authorized external controller later dispatches approved workflows. Never perform network/GitHub dispatch within the DB transaction.

This RPC must be accessible only to a server-side privileged role: explicitly REVOKE EXECUTE FROM PUBLIC, anon, authenticated, and preserve row-level security. The socket Worker carries only the single server-secret Supabase bootstrap URL; its parsed credential never leaves the server. Its interim meter conservatively counts one UTF-8 byte as one token; Agent A's verified cumulative meter must replace it during integration. The gateway checks that the durable receipt covers the full response frame.

**Not production-ready until the RPC, signed identity provider, restricted-host configuration and live denial tests are installed.** Missing RPC or missing credentials fail closed; fake tests do not prove production deployment.

Run node --test tools/atax-mcp/socket-gateway.test.mjs (Node 22+). Tests cover forbidden discovery/invocation, cross-task, principal/session mismatch, stale fence, revoked capability, lease expiry, cumulative repeated pulls, concurrent output quotas, oversized submissions, workflow input allowlists, signed JWT verification, receipts and fail-closed behavior. Final reconciler owns live end-to-end and independent verification.
