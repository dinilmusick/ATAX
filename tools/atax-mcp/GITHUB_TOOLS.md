# First-class GitHub and FMRL tools for ATAX MCP agents

## Tool-selection rule — begin here

**ATAX is a persistent control plane, NOT an execution runner or agent scheduler.** Always hydrate canonical Supabase context and current skills first. Then use tools in this order:

1. **Local target available:** clone the actual target repository in the agent's own container; edit and test there. **Never** use `dinilmusick/ATAX` as a target checkout.
2. **Need a permanent GitHub repository:** invoke `atax_github_repository_create`, optionally `atax_github_repository_inspect` to inspect it. New application and framework repositories are persistent; **do not** name them `FMRL-*`. GitHub-native ATAX scripts `tools/github/create_repository.py` and `repository_lifecycle.py` remain valid for agents with repository access.
3. **Need remote CI for an allowed private target:** invoke `atax_fmrl_create_run_dispose` with the exact 40-character lowercase target commit SHA, then **poll** `atax_fmrl_get_status` with its returned `request_id`. The controller runs `.github/workflows/private-repo-ci.yml` on ATAX as a pure control plane and provisions a **public FMRL-*** repository for one finite job. Private source is cloned only inside its ephemeral runner, never committed to FMRL or ATAX.
4. **Mandatory end state:** record both the CI outcome and independent FMRL 404 deletion proof as evidence in the Supabase ledger, then have a separate verifier review it. If execution or cleanup fails, retain a blocker; **never** claim success or use ATAX Actions / Agent-Workspace-1 as fallback.

### MCP tools and exact access scopes

| Tool | Scope | Purpose |
| --- | --- | --- |
| `atax_github_workflows_guide` | `atax:read` | Discover workflow choice and strict safety boundaries. |
| `atax_github_repository_inspect` | `atax:github:read` | Verify owner, URL, visibility and default branch. |
| `atax_github_repository_create` | `atax:github:create` | Create a **permanent** GitHub repository, private by default, initialized by default; reject reserved `FMRL-*` and `ATAX`. |
| `atax_fmrl_create_run_dispose` | `atax:fmrl:execute` | Dispatch current canonical FMRL controller for an allowlisted private target at an exact SHA. Returns *dispatch acknowledgement*, **not** completion. |
| `atax_fmrl_get_status` | `atax:fmrl:execute` | Retrieve a specific controller run by correlation ID (or ID+run ID); check terminal CI status, successful bridge provision/cleanup steps, and independent public 404. |

The server also advertises this guide as MCP resource `atax://guides/github-workflows` and an MCP prompt named `atax-github-workflow`. The `initialize` response tells incoming agents to read the guide before GitHub work. The MCP GitHub path is **optional**; GitHub-native ATAX scripts and direct Supabase operations do not require MCP uptime.

### Required Worker configuration — personal server

| Binding | Classification | Purpose |
| --- | --- | --- |
| `GH_KEY_PERSONAL`, `GH_KEY_WORK`, `GH_KEY_<ALIAS>` | Cloudflare **secrets** | Named GitHub accounts for repository creation, inspection and FMRL controller dispatch/status; require correct GitHub API permissions |
| `MCP_GITHUB_OWNER=dinilmusick` | Plain variable | Canonical ATAX FMRL controller owner; not an arbitrary target workspace |
| `MCP_FMRL_ALLOWED_TARGETS=dinilmusick/Skipo,dinilmusick/Kone` | Plain allowlist | Mandatory exact targets for FMRL; no wildcards |
| `SUPABASE_SECRET_KEY` | Cloudflare **secret** | The one canonical ledger |
| `MCP_ATAX_OWNER_JWT_SUBJECT` | Exact owner identity | Refuse all non-owner MCP callers even with nominal tool scopes |

The older `GH_TOKEN_<ALIAS>` naming is accepted for migration, but **do not configure two secret names with the same alias**. If only one GitHub credential exists, omit `account`; otherwise supply `account: "PERSONAL"` (or another named alias) in GitHub tools. FMRL `create_run_dispose` and `get_status` must use the same account, capable of dispatching and reading the controller workflow. Unlike the previous implementation, there is **no separate global `GITHUB_REPOSITORY_TOKEN` or `GITHUB_FMRL_DISPATCH_TOKEN` fallback**.

The controller retains its own established GitHub Actions secrets (`CODING_REPO_TOKEN`, `FMRL_SECRETS_TOKEN`, `PRIVATE_REPO_TOKEN`, etc.). These belong in the **GitHub repository secret store**, not in the MCP Worker. The Worker cannot read them and must not receive private-target source. The existing GitHub-native scripts and Supabase connector remain functional independently of the Worker. The same named `GH_KEY_<ALIAS>` convention may also be used in trusted repository workflow jobs, but workflows must explicitly reference `secrets.GH_KEY_<ALIAS>`; a direct GitHub connector cannot read their values.

The Worker requires MCP caller authentication in addition to server-side secrets. Only the exact verified owner may list accounts and invoke tools. Keep executor/verifier scopes and identities separate to enforce independent verification. See [OWNER_SETUP.md](OWNER_SETUP.md).

### Example permanent repository creation

Call `tools/call` with:

```json
{"name":"atax_github_repository_create","arguments":{"name":"ExampleProduct","account":"PERSONAL","description":"Persistent application repository","visibility":"private","initialize":true}}
```

The result verifies the repository under the selected GitHub token's actual user identity and its visibility; the example assumes the `PERSONAL` credential belongs to `dinilmusick`. It is **not** an FMRL repository and will **not** be deleted by ATAX.

### Example FMRL dispatch + cleanup verification

**Preflight:** verify that the target is in `MCP_FMRL_ALLOWED_TARGETS`, that a local container is unavailable/insufficient or independent remote CI is needed, that the exact target commit SHA has been resolved and that the ATAX task is properly claimed.

```json
{"name":"atax_fmrl_create_run_dispose","arguments":{"repository":"dinilmusick/Skipo","account":"PERSONAL","ref":"<exact lowercase 40-character commit SHA>","event":"pull_request","workflow":"test.yml"}}
```

The returned `request_id` is the only correlation input needed to poll:

```json
{"name":"atax_fmrl_get_status","arguments":{"request_id":"<returned UUID>","account":"PERSONAL"}}
```

Keep polling while `state` is not `completed` or awaiting GitHub discovery. On completion, **require** both `conclusion: "success"` and `cleanup_verified: true`. The latter requires successful provision and cleanup job-step evidence plus an independent **anonymous HTTP 404** for the named disposable bridge repository. A 403/429 means no deletion proof; fail closed and persist a blocker. When `conclusion` is a failure, do not mark the task successful even if the repository was properly cleaned up. If `run_id` is known, supply it on a follow-up to avoid the 100-run listing window.

Do not trigger the FMRL controller with arbitrary repo/ref metadata or custom execution commands. The `mode` for MCP is the established **direct portable suite**. It does not imply full original private workflow parity, release readiness, end-to-end OAuth checks or a production deployment.

### Boundaries and non-goals

- No unbounded generic GitHub REST gateway, shell execution, arbitrary workflow dispatch or permanent repository deletion via MCP.
- No FMRL public repository created from the generic permanent creation tool; no FMRL repository left behind intentionally.
- No resident agents, background agent scheduling, hidden job queue, or persistence beyond the authoritative Supabase ledger and GitHub's finite run records.
- No unilateral self-verification; ledger task ownership/leases and independent verifier rules continue to apply.
- A failure during GitHub creation, dispatch, polling or deletion must be reported as a real blocker, not substituted with fabricated evidence.
