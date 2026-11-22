# GitHub-only ATAX ledger bridge (private controller)

This mode is for external agents that have a **GitHub connector but no Supabase connector and no MCP client**. They use GitHub to read the public `dinilmusick/ATAX` repo, then create bounded command issues in a **separate, trusted private GitHub controller repository**. GitHub Actions in that private repository uses its own Supabase secret to invoke the *same* canonical ledger RPCs. The agent polls the private issue comments for the result. ATAX never creates or schedules the agent.

**Do not use public ATAX issues, pull requests, workflow outputs, artifacts or comments as a private ledger channel.** The public ATAX repository is instructions and tooling distribution only. The private controller is a separate authorized interface, not a new canonical state store.

## Installation for an owner

1. Create an **owner-controlled private repository** accessible to the agents that will use the GitHub connector. Give only trusted operators access to private issue bodies and comments. Disable unwanted forks. Ordinary public ATAX repository access does not grant this privilege.
2. Copy `controller-workflow.example.yml` to `.github/workflows/atax-ledger-bridge.yml` in **that private repository**. Never deploy this issue-triggered workflow in the public ATAX repo.
3. In the private controller configure GitHub Actions environment `atax-ledger`, with secrets `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (dedicated minimum privilege where possible). Set repository variables `ATAX_BRIDGE_REF` to a **reviewed, immutable ATAX commit SHA** that contains this bridge and `ATAX_BRIDGE_ALLOWED_ACTORS` to the exact comma-separated GitHub logins of trusted callers. The workflow refuses to run without a pinned ref. No secrets belong in issue bodies or workflow inputs.
4. From the permitted GitHub account create a **new issue in the private controller**, with JSON body (no Markdown fence):

```json
{"protocol":"atax-github-bridge/v1","op":"context","args":{}}
```

5. Poll that issue's comments for `ATAX_BRIDGE_RESULT_V1` and a JSON `ok` result. The workflow does not disclose raw provider exceptions. Use `goals` and `skill` to hydrate before claiming. Issue comments (and claim tokens) are **private but visible to any private repo reader**. Protect access accordingly.
6. For a bounded claim, create another private issue:

```json
{"protocol":"atax-github-bridge/v1","op":"claim","args":{"goal_id":"GOAL_UUID"}}
```

The claim result includes the canonical task ID and fencing token. Send `heartbeat`, `submit` or `release` as separate new private issues with `task_id` and `claim_token`; no arbitrary RPC, SQL, table mutation, code execution or provider-control commands are accepted. Agents execute work in their own runtime, never in this bridge. The bridge's compute is limited to ATAX control-plane RPC calls.

For `heartbeat`:
```json
{"protocol":"atax-github-bridge/v1","op":"heartbeat","args":{"task_id":"TASK_UUID","claim_token":"CLAIM_UUID","current_step":"Working on acceptance checks"}}
```

For `submit`:
```json
{"protocol":"atax-github-bridge/v1","op":"submit","args":{"task_id":"TASK_UUID","claim_token":"CLAIM_UUID","result":{},"evidence":[{"description":"Verified output"}],"summary":"Work submitted","status":"completed"}}
```

Independent GitHub principals use `verification_claim` and `verify` with `task_id`, `verification_token`, `accepted` and `report`; the database denies self-verification. GitHub actor identities are **authorization principals**, not AI model names or a resident-agent registry.

## Security and operational limits

- Only authenticated, allowlisted GitHub issue authors can issue commands; GitHub event sender must match. Private visibility is mandatory. This is *not* an anonymous public gateway.
- A private repo issue is a request/response mailbox, **not** the durable ledger; Supabase owns every socket lease, checkpoint and verification.
- The controller's actor's GitHub login is its stable opaque holder identity. Two independent external agents sharing the same GitHub login are **not independent verifiers**. Use distinct authorized GitHub principals when independent verification is required.
- The workflow source must be pinned via `ATAX_BRIDGE_REF`. Pin the controller's third-party Actions as required by your security policy; protect the environment and repository branch.
- Failed/oversize requests fail closed. The client has no general table write path. Private issue content still has retention and collaborator-access implications; do not include provider credentials or unrelated personal data.
- The source code and offline tests can be verified in public CI. **Full GitHub-only readiness requires an actual private controller repository, configured secrets, private-issue dispatch, authenticated response, and end-to-end task claim/recovery/verification tests.** Until those are demonstrated, treat this as implemented bridge tooling, *not* certified live access.
- Direct GitHub+Supabase and remote MCP paths are independent of this controller. See [connection modes](../../docs/connection-modes.md).
