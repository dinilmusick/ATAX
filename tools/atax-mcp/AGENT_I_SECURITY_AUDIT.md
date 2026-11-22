# Socket V1 Agent I — restricted gateway audit evidence

## Review boundary
- Source: PR #1730, exact audited implementation head `98e891f3dcdede80cf5d3c66914764ec8a563f99`.
- Independent scope: `tools/atax-mcp/**`; separate audit branch; no source-PR or main merge.
- API entrypoints: `socket-worker.mjs` (restricted) and `worker.mjs` (maintainer, unchanged).
- Implemented declarations: five `atax_socket_*` tools; `socket:protocol` is required for all signed protocol discovery messages.

## Security findings and scoped corrections
1. **Authenticated invalid workflow bypass (corrected).** The source used direct JSON responses for unknown workflow keys, resolver exceptions and bad workflow input values. These did not call the canonical metering transaction. The corrective branch sends each through `meteredProtocol`; repeated denials now consume cumulative input/output and can atomise.
2. **Malformed signed JSON-RPC frames (corrected).** The source returned errors before charging signed malformed frames. Validly authenticated JSON/JSON-RPC errors now use the fenced `protocol` transaction. IDs are capped at 128 characters (or safe integers), method names at 128 characters, and error replies do not echo oversized IDs.
3. **Unbounded in-memory body reads (corrected).** The source performed `request.text()` and remote response `.text()` before enforcing size ceilings. The corrective branch streams with size checks and cancels on overflow for request ingress, JWKS documents and canonical database replies. Invalid stream encoding fails closed.
4. **Canonical response contract (still dependent).** Tool results must be bounded, sanctioned and secret-redacted by the canonical RPC before output quota reservation; a fake adapter can test receipts but cannot substitute for a production schema/permission review. Errors never include thrown internal exception messages.
5. **Restricted-host isolation (not certified).** The Worker only controls its own exported MCP operations. It cannot revoke external tools independently supplied by ChatGPT, Claude, Gemini, CLI shells, browser automation or other AI hosts. A host inventory captured from the *actual launching platform* must prove that the task-bound process has only the restricted socket endpoint and has no ambient GitHub, Supabase, cloud, filesystem, shell, browser, general network or maintainer endpoints. Prompts and MCP `tools/list` checks alone do not meet this requirement.

## Live environmental verification, 2026-11-22
- GitHub source PR #1730 metadata: open, head `98e891f3dcdede80cf5d3c66914764ec8a563f99`, five files all under the owned path.
- Source commit `98e891f3dcdede80cf5d3c66914764ec8a563f99` had successful `ATAX MCP gateway tests` workflow run `45048305967`. This certifies neither the corrective branch nor host isolation.
- Canonical Supabase PostgreSQL `pg_proc` inspection: `public.atax_socket_execute_v1` does not exist. Missing transaction must deny tool requests, not silently fall back.
- Cloudflare account that hosts the existing `atax-mcp` maintainer Worker: account Worker inventory contains `atax-mcp` but no `atax-task-socket` Worker. The restricted Worker has not been proven deployed or run live.
- Local container Node version 22.16.0 is suitable, but this environment cannot resolve github.com to clone the private repository. The corrective PR **did** execute in an authorized GitHub Actions runner: run `45051805173`, success at `368353eb8f6cc51e7640422a1976a5bc99e42ed8`, 54 passing Node tests, 0 failures, **maintainer** Worker packaging dry run (`wrangler.toml`) and existing maintainer-Worker fail-closed probe. The CI workflow does **not** dry-run `wrangler.socket.toml`; restricted Worker packaging and deployment remain unverified. This is scoped test evidence, not production restricted-host evidence.

## Mandatory host attestation before certification
1. Obtain the agent host's **enforced** tool/connector/extension configuration from its control plane, not from the agent's prompt or self-report.
2. Run the actual task-bound session and enumerate effective host-native tools, MCP server registrations, shell/filesystem access, browser/network access, inherited credentials and allowed network destinations. Verify that only this restricted endpoint is reachable and no maintainer endpoint or general-purpose tools remain available.
3. Attempt to invoke the prohibited tool families from the task-bound session and prove host-level denial **before** any provider request can be issued.
4. Use a signed socket credential in a controlled environment; prove canonical database validation, revocation, wrong principal/session/task/fence, lease expiration, capability denial, repeated context/output charging, oversize and concurrent requests. Independently inspect DB rows/receipts and negative results.
5. Repeat checks against the final production Worker deployment and exact immutable release commit. Sign off independently; do not auto-merge.

## Unsupported host configurations
- **General ChatGPT/Claude/Gemini conversations with ambient tool connectors:** unsupported unless the host provides a separately isolated session or enforceable connector/tool allowlist. An instruction to ignore tools is not enforcement.
- **Coding hosts with resident local shell/browser/network/GitHub access:** unsupported unless those capabilities are actually removed by the sandbox/launcher and verified by adversarial execution.
- **MCP clients that combine socket tools with other MCP servers:** unsupported. Disabling tools only in the socket server does not revoke other registered servers.
- **Dedicated API/agent hosts allowing externally enforced tool inventories and sandbox isolation:** eligible only after an inventory/negative-run attestation demonstrates exclusive socket capabilities.

## Release decision
**NOT CERTIFIED.** The corrective branch addresses independently identified ingress/metering defects, and scoped corrective CI passed. Full acceptance remains blocked on the canonical RPC, restricted Worker deployment, live end-to-end negative tests and enforceable host-side isolation. Existing maintainer access remains independent and unchanged. Submit to an agent other than the implementation author or Agent I for independent release review.
