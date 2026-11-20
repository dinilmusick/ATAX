---
name: GitHub Development Workspace
slug: github-development-workspace
version: 1.4.2
source: Supabase Skills Database
sourceId: 40
status: active
---

# GitHub Development Workspace

## Mandatory FMRL execution boundary

ATAX is **only the control plane and tool source**, never a checkout workspace or GitHub Actions runner for target code. No target/private checkout, installation, build, test, `act` invocation, or coding commands may run in `dinilmusick/ATAX` Actions. The historical ATAX-as-workspace and Agent-Workspace-1 patterns are forbidden.

Execution priority:
1. Use the agent's own container/runtime; clone the **target repository** directly there (if authorized), edit and test locally. ATAX tools may be downloaded as tooling, but the ATAX repository must not become the target checkout or runner.
2. If local execution is unavailable, inaccessible, insufficient, or remote public Actions evidence is required, provision an **FMRL-prefixed, one-job disposable public repository** through `tools/github/disposable_workspace.py` or ATAX's control-plane workflow. This is the **only** remote GitHub compute location for private targets.
3. The FMRL public repository contains only bridge workflow code. Authorized private source is checked out **only inside its transient runner** and never pushed, artifacted, cached, or committed to the public repository. The checkout token is used only by the clone step; target commands receive no repository token.
4. Run and inspect checks, record evidence, obtain independent verification, **delete FMRL**, and independently confirm the repository returns 404. Deletion is mandatory on failure as well as success; failed cleanup is a blocker, not completion.
5. If FMRL cannot be provisioned, report the blocker and preserve work in the ledger. **Never fall back to ATAX or private-repository Actions execution.**

A new permanent repository (plain or Skipo) is a different lifecycle from disposable FMRL compute. Keep the two workflows separate.

## Mandatory obstacle reflex

Obstacle recording is part of normal repository development, not an optional documentation step.

Before beginning and throughout every material change:

```text
semanticResolve
  -> inspect canonical obstacle memory
  -> execute
  -> on obstacle: normalize + search + record occurrence
  -> resolve
  -> verify
  -> if reusable substrate weakness: update skill/workflow
```

Treat these as obstacles by default: failed tests, CI failures, unexpected type/runtime errors, missing exports, dependency/toolchain failures, environment mismatches, workflow failures, authentication/token problems, ref/branch mistakes, and any workaround that should become a reusable pattern.

## Verification discipline

Before triggering remote CI after adding or changing tests:
1. Inspect the target implementation exports.
2. Verify every test import resolves to the canonical module boundary actually exporting the symbol.
3. Run the narrow affected test locally when the environment permits.
4. Only then trigger ATAX private-repo CI.
5. If CI fails, classify it before changing source.
6. Immediately search obstacle memory for the failure class.
7. Record the occurrence and evidence before applying the fix.
8. After the fix, independently verify it and update the obstacle resolution.
9. If the failure reveals a reusable weakness in ATAX, update the relevant skill/workflow and verify that improvement separately.

Known failure pattern: a certification test imported `getSystemDatabaseUrl` from `src/backend/auth/betterAuth` even though the canonical export was `src/backend/types.ts`. Typecheck passed, but CI failed with `TypeError: getSystemDatabaseUrl is not a function`. The fix was to import the canonical resolver from `src/backend/types.ts`. Do not repeat this class of error.

Known substrate failure pattern: a single `curl` request for the pinned `act` release returned HTTP 504, causing private-repo CI to stop before cloning or executing the target workflow. The workflow was hardened with bounded retry, timeout, and preserved SHA256 verification. Treat transient bootstrap failures as infrastructure obstacles and improve the substrate rather than modifying target application code.

## Substrate improvement

When an obstacle is caused by this workspace, its workflows, skills, or reusable tooling:

1. record the obstacle and current-task occurrence;
2. identify the reusable prevention rule;
3. update the smallest relevant skill/workflow/tool;
4. test the substrate change;
5. rerun the originally blocked operation;
6. independently verify the improvement;
7. record evidence linking the obstacle, fix, and verification.

The goal is progressive self-hardening of ATAX.

## Skipo application flow

```text
create repository
  -> clone canonical Skipo
  -> python3 assistant.py generate scaffold <target> --name <App>
  -> install dependencies
  -> validate
  -> commit/push
  -> continue coding in the agent container or disposable FMRL runner
```

## Routing

```text
private repository + CI/build/test evidence
  -> ATAX GitHub tools
  -> ephemeral public bridge
  -> runtime private clone
  -> container when usable, otherwise public GitHub runner
  -> evidence -> independent verification -> delete + verify deletion

any authorized repo + code execution/edit/build/test
  -> agent container first; FMRL disposable public runner as fallback

new Skipo application
  -> create-skipo-app workflow
  -> github-development-workspace
```
## Supabase independence

Supabase is the canonical persistence layer for goals, tasks, ownership, leases and evidence when available. It is not required for repository development. An agent with GitHub access and this skill can perform the complete repository lifecycle using GitHub repository state, Actions, artifacts and workflow logs.

## Security

- Use `CODING_REPO_TOKEN` for coding operations.
- Repository creation requires Repository creation: write.
- Never expose deployment credentials to coding commands.
- Never print tokens or commit secrets.
- Only execute arbitrary commands against trusted repositories.

## Deterministic execution bootstrap

For any substantive repository task, establish the execution substrate before editing: use a usable local container/runtime first; clone the target directly; if local execution cannot satisfy the request, provision and run a disposable FMRL public repository through ATAX tools. Discover and run all repository-defined build, test, typecheck, lint and custom build scripts that participate in the real build. Use GitHub Actions only when local execution is unavailable, insufficient for the target environment, or remote evidence is explicitly required. Capture command results as evidence and require independent verification before completion.

The canonical local preflight is `python tools/agent-bootstrap/bootstrap.py plan`; use `prepare` to establish the workspace and target checkout. Never place credentials in source, logs or task metadata.


## Remote execution route

When local container execution cannot perform the work, provision a disposable FMRL public repo using ATAX tools or the ATAX `private-repo-ci.yml` control-plane dispatcher. The old `[github-dev]` ATAX execution path is retired. Never put private source into FMRL git history.

## Commercial repository acquisition\n\nBefore copying any public source project into the template portfolio, follow `docs/commercial-acquisition-policy.md`. Track candidate sources, exact revisions, evidence and unresolved checks in `docs/template-portfolio-candidates.md`. Root SPDX metadata is only an initial filter; it does not prove that all dependencies, assets, bundled editions or extensions are commercially redistributable. Only fully APPROVED candidates may be submitted to `.github/workflows/independent-commercial-acquisition.yml`. The workflow creates a new private repository, mirrors Git history/refs, verifies object IDs and never creates a fork. Never submit CONDITIONAL, REJECTED or UNVERIFIED candidates.\n

## SUBSTRATE_PROTOCOL_V3
All agents are ephemeral workers. Supabase is canonical coordination state; chat is not durable state. Before acting, load the current Task Ledger and the narrowest applicable specialist skill. Persist every meaningful checkpoint: current_step, activity, progress, discoveries, blockers, evidence and next_action.
WORKER=discover->resolve->route->plan->persist->claim->execute->evidence->independentVerify->finalize. Claims MUST use the atomic ledger claim path. HEARTBEAT~2m->checkpoint+renew lease. OWNERSHIP_CHECK~5m->if fence is lost: append final handoff note, stop immediately, and never overwrite the new owner. Recovery is allowed after heartbeat silence>=5m; the new worker reads the task row, checkpoint and task events before continuing. Use fenced release for queued/blocked/abandoned work.
LOOPS=separateAuthor->readyContract->independentExecutor. A loop-authoring worker defines and validates success parameters/checkpoints, persists the loop contract, then releases/requeues the task. It MUST NOT execute the resulting task. An execution worker may claim only a ready contract authored by another agent and MUST execute against those persisted parameters. No worker may redefine its own success conditions. Verification is independent.
CODING=GitHubIssueCanonicalExecutionState; one independent coding task->one worker->one Issue->one PR. ASYNC=started->wait/poll->inspect->repair/retry->poll->verify; never stop while a started/pollable process remains. OBSTACLE=normalize->semanticSearch->reuseOrCreate->record->resolve->verify. Never keep essential context only in chat or secrets in task records/logs.
SKILL TIMING: use this skill when its trigger matches; load supporting skills before their required action, not after. Prefer the narrowest specialist skill plus only necessary support skills. If the substrate changes, update the canonical Supabase skill and repository copy, then independently verify parity.

## Mandatory FMRL execution boundary

ATAX is **only the control plane and tool source**, never a checkout workspace or GitHub Actions runner for target code. No target/private checkout, installation, build, test, `act` invocation, or coding commands may run in `dinilmusick/ATAX` Actions. The historical ATAX-as-workspace and Agent-Workspace-1 patterns are forbidden.

Execution priority:
1. Use the agent's own container/runtime; clone the **target repository** directly there (if authorized), edit and test locally. ATAX tools may be downloaded as tooling, but the ATAX repository must not become the target checkout or runner.
2. If local execution is unavailable, inaccessible, insufficient, or remote public Actions evidence is required, provision an **FMRL-prefixed, one-job disposable public repository** through `tools/github/disposable_workspace.py` or ATAX's control-plane workflow. This is the **only** remote GitHub compute location for private targets.
3. The FMRL public repository contains only bridge workflow code. Authorized private source is checked out **only inside its transient runner** and never pushed, artifacted, cached, or committed to the public repository. The checkout token is used only by the clone step; target commands receive no repository token.
4. Run and inspect checks, record evidence, obtain independent verification, **delete FMRL**, and independently confirm the repository returns 404. Deletion is mandatory on failure as well as success; failed cleanup is a blocker, not completion.
5. If FMRL cannot be provisioned, report the blocker and preserve work in the ledger. **Never fall back to ATAX or private-repository Actions execution.**

A new permanent repository (plain or Skipo) is a different lifecycle from disposable FMRL compute. Keep the two workflows separate.

## Mandatory ATAX higher-order GitHub operations discovery (2026-11-19)
When a task requires creating, deleting, configuring, or templating a GitHub repository, do NOT conclude that the operation is unavailable merely because the ChatGPT GitHub connector lacks the action. First hydrate ATAX Supabase skills and inspect dinilmusick/ATAX for its tools/github control-plane tooling, supported invocation method, credentials/permissions and applicable permanent-repository lifecycle. Use ATAX tooling for supported higher-order operations; keep ATAX as control plane, never target checkout/CI workspace. Verify the actual GitHub repository and is_template setting independently after creation. If ATAX tools are inaccessible from this runtime, persist the exact blocker and next invocation route rather than claiming the capability does not exist. Distinguish permanent Skiplet template creation from disposable FMRL execution.

## Owner-authorized private lockfile regeneration (FMRL)

**Discovery/entry point.** For a private `dinilmusick/Luth`, `dinilmusick/Srkl-Engine`, or `dinilmusick/Aiko` pull request with an invalid/stale lockfile, use ATAX's existing FMRL control plane. Its owner-only request is an issue in `dinilmusick/ATAX` titled exactly `[atax-fmrl] repair-lockfile`; the **entire body is the opaque GitHub pull-request `node_id`** (format `PR_...`, available from the authenticated GitHub pull-request metadata). The issue author must pass the controller's verified owner-ID gate. Do not put private repository names, source code, tokens or private commit SHAs in public issue bodies. See `.github/workflows/owner-authorized-private-ci.yml` and `.github/workflows/private-repo-ci.yml`.

**Exact operation.** The resolver uses `CODING_REPO_TOKEN` only for owner-scoped private PR metadata, obtains the exact head SHA and non-fork branch, and provisions an `FMRL-*` disposable **public repository containing static bridge code only**. Only that repository's transient runner clones private source, at the exact SHA, using the separately scoped clone-only token. In `--mode repair`: for Luth regenerate `pnpm-lock.yaml` using `pnpm install --lockfile-only --ignore-scripts --fix-lockfile --no-frozen-lockfile`, then prove `pnpm install --frozen-lockfile --ignore-scripts`; for SRKL/Aiko regenerate `package-lock.json` using `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then prove `npm ci --ignore-scripts --no-audit --no-fund`. No arbitrary package lifecycle scripts run in this repair phase.

**Commit and verification.** `tools/github/fmrl_lock_writer.py` is a reviewed static helper in the public bridge, invoked only **after** dependency operations finish. It accepts a write credential in that one step, validates the private PR head is still the requested commit, refuses non-lockfile changes, creates a lockfile-only commit, and uses non-forced GitHub REST `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` (plural `refs`, unlike read endpoint `GET /git/ref/heads/...`). Independently re-read the branch and committed blob digest. If the PR head changed, write authority is absent, or any readback fails, report a blocker, never force-push or mark repaired. Never expose write credentials to install/test commands.

**Required acceptance:** confirm changed paths contain only the expected lockfile; independently verify exact PR head, frozen install, and that each disposable FMRL repository is DELETED even after failure and returns unauthenticated HTTP 404. Record the ATAX issue/run, original/new SHA, change scope and deletion evidence in the canonical ledger. Then request a fresh `[atax-fmrl] verify` issue with the same PR node ID to run the portable **direct** install/test/build/typecheck checks against the new head. Direct FMRL success is **not** original GitHub Actions parity or deployed OAuth evidence. Full target workflow checks, protected preview deployment, real login/logout/refresh/revocation, negative authorization and workspace-isolation tests remain separate release gates.

**Failures:** `ERR_PNPM_BROKEN_LOCKFILE` or an npm frozen-lock mismatch calls for repair, not hand-editing lockfile snapshots. An API 404 at `atomic-branch-update` must be investigated as route/permission failure; check plural `git/refs` for PATCH, no fallback to force-update or credential disclosure. Consult `tools/github/README.md`, `skills/private-repo-ci-workspace-runner/SKILL.md`, `tools/github/disposable_workspace.py`, `tools/github/fmrl_lock_writer.py`, and their `test_fmrl_lock_repair.py` contract tests. Until an actual PR writeback and subsequent CI are green, describe the operation as implemented but **not yet end-to-end certified**.


## First-class remote ATAX MCP GitHub tools (no repository access needed)

When an incoming agent has ATAX MCP connectivity but **not** access to the ATAX GitHub repository, hydrate ATAX/Supabase context and current skills first, then call `atax_github_workflows_guide` (also available as resource `atax://guides/github-workflows` or prompt `atax-github-workflow`). Use **first-class** MCP tools, not invented shell commands or generic GitHub REST URLs:

- `atax_github_repository_create` (scope `atax:github:create`) provisions a **permanent** private-by-default GitHub repository; `atax_github_repository_inspect` (scope `atax:github:read`) verifies its owner/visibility/default branch. Never use this path to create `FMRL-*` or delete a permanent repo.
- `atax_fmrl_create_run_dispose` (scope `atax:fmrl:execute`) is the **disposable, one-job public FMRL fallback** for an explicitly approved private target at an exact 40-character commit SHA when agent-local execution is unavailable/insufficient or independent remote CI is needed. It delegates only to ATAX's canonical `.github/workflows/private-repo-ci.yml` controller, which provisions FMRL, clones private code only into the ephemeral runner, runs checks, and always attempts deletion. ATAX is never the execution workspace.
- `atax_fmrl_get_status` (same scope) must be polled using the returned `request_id` until terminal. Require both **successful CI conclusion** and **`cleanup_verified: true`** (successful provision/cleanup steps plus an independent public HTTP 404). A 403/429, incomplete run, missing correlation or failed cleanup is **not** deletion proof. Record it as a blocker, never claim success from dispatch acceptance.
- Secrets are stored only as Worker bindings: separate `GITHUB_REPOSITORY_TOKEN`, `GITHUB_FMRL_DISPATCH_TOKEN`, `MCP_GITHUB_OWNER`, and mandatory `MCP_FMRL_ALLOWED_TARGETS`; no wildcard target access. MCP JWT/OAuth scopes must be explicitly issued to authorized clients. The Worker never receives the FMRL clone-only secret and never creates/schedules agents.
- If the agent **does** have direct GitHub/ATAX repository access, existing `tools/github/create_repository.py`, `tools/github/disposable_workspace.py`, and `repository_lifecycle.py` remain fully supported; the two entry paths are **additive** and share canonical Supabase state.

For tool contracts, caller scopes, client request examples and security invariants see `tools/atax-mcp/GITHUB_TOOLS.md`. Every completion still needs independent verification and canonical ledger evidence.
