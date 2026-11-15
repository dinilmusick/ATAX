---
name: GitHub Development Workspace
slug: github-development-workspace
version: 1.3.0
source: Supabase Skills Database
sourceId: 40
status: active
---

## ATAX Private Repository Execution Rule

For private-repository CI/build/test work, use **ATAX GitHub tools**, not the ChatGPT GitHub connector, to provision and execute the workflow. First attempt the **container/runtime**: clone ATAX there, use its tools, and attempt direct target cloning. If the private target cannot be cloned directly, ATAX provisions an **ephemeral public repository as a compute bridge**; clone that public bridge into the container when possible, and keep the private source private. If the container cannot execute the required work, use the bridge's public GitHub runner. The private target is cloned only at runtime. Required lifecycle: **ATAX provision → runtime private clone → execute → evidence → independent verification → delete bridge → verify deletion**. Never run the target CI directly in the private repository and never publish private source to the public bridge.

**Credential distinction:** an Actions repository secret is consumed by the GitHub runner at runtime; it is not automatically readable by the agent's local process. Do not report an ATAX runner as credential-blocked merely because the local process lacks a token. Verify the ATAX runner path first.
# GitHub Development Workspace

Use GitHub itself as the development substrate. This capability does not require Supabase.

## Capabilities

- Create repositories through `tools/github/create-repository.sh`.
- Create a repository and immediately scaffold a canonical Skipo application.
- Clone authorized target repositories into ephemeral GitHub-hosted runners.
- Edit code with normal shell/tooling.
- Install dependencies.
- Run lint, format, typecheck, unit/integration tests, builds and application validators.
- Run the same verification on Linux, Windows and macOS standard public runners.
- Commit and push verified changes when explicitly requested.
- Preserve logs as workflow artifacts.

## Execution Substrate

**Container/runtime first.** Clone ATAX into the container and use its tools/scripts. Attempt direct target cloning. If a private target cannot be cloned directly, use ATAX GitHub tools to provision an **ephemeral public repository as a compute bridge**; clone that bridge into the container when possible. If the container cannot execute the required work, use the bridge's public GitHub runner. The private target is cloned only at runtime and is never published to the bridge.

The ChatGPT GitHub connector is for ordinary repository reading/editing/PR operations. It is **not** the provisioning or CI execution path for private-repository work. Never weaken repository access controls or expose credentials.
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
  -> continue coding in github-development-workspace
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
  -> github-development-workspace

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

For any substantive repository task, establish the execution substrate before editing: use a usable local container/runtime first; clone ATAX into that runtime; use its tools/scripts; attempt the target repository directly; if a private target cannot be cloned directly, use the ATAX private-repository tooling and dedicated clones bridge. Discover and run all repository-defined build, test, typecheck, lint and custom build scripts that participate in the real build. Use GitHub Actions only when local execution is unavailable, insufficient for the target environment, or remote evidence is explicitly required. Capture command results as evidence and require independent verification before completion.

The canonical local preflight is `python tools/agent-bootstrap/bootstrap.py plan`; use `prepare` to establish the workspace and target checkout. Never place credentials in source, logs or task metadata.


## Issue-triggered development execution

When workflow-dispatch API access is unavailable, use the issue-triggered route in `.github/workflows/github-dev-workspace.yml`:

1. Create an issue in ATAX titled `[github-dev] <short task>`.
2. Put a JSON request in the issue body with `repository`, `ref`, and `commands`.
3. For write work, set `push: true`, provide a new `branch`, and optionally set `create_pr: true`.
4. Only owners, members and collaborators can invoke the route.
5. The request resolver validates the issue author, repository/ref, command limits and branch/PR contract.
6. Target commands run without repository or deployment secrets. Credentials are supplied only to checkout and post-execution push/PR steps.
7. Inspect the Actions run and download its development log artifact. Do not claim completion without checking the run result and evidence.

Request schema and examples: `docs/github-development-workspace.md`.

Run resolver tests with:

```bash
python3 -m unittest runner/test_resolve_development_request.py
```
\n\n## Commercial repository acquisition\n\nBefore copying any public source project into the template portfolio, follow `docs/commercial-acquisition-policy.md`. Track candidate sources, exact revisions, evidence and unresolved checks in `docs/template-portfolio-candidates.md`. Root SPDX metadata is only an initial filter; it does not prove that all dependencies, assets, bundled editions or extensions are commercially redistributable. Only fully APPROVED candidates may be submitted to `.github/workflows/independent-commercial-acquisition.yml`. The workflow creates a new private repository, mirrors Git history/refs, verifies object IDs and never creates a fork. Never submit CONDITIONAL, REJECTED or UNVERIFIED candidates.\n

## SUBSTRATE_PROTOCOL_V3
All agents are ephemeral workers. Supabase is canonical coordination state; chat is not durable state. Before acting, load the current Task Ledger and the narrowest applicable specialist skill. Persist every meaningful checkpoint: current_step, activity, progress, discoveries, blockers, evidence and next_action.
WORKER=discover->resolve->route->plan->persist->claim->execute->evidence->independentVerify->finalize. Claims MUST use the atomic ledger claim path. HEARTBEAT~2m->checkpoint+renew lease. OWNERSHIP_CHECK~5m->if fence is lost: append final handoff note, stop immediately, and never overwrite the new owner. Recovery is allowed after heartbeat silence>=5m; the new worker reads the task row, checkpoint and task events before continuing. Use fenced release for queued/blocked/abandoned work.
LOOPS=separateAuthor->readyContract->independentExecutor. A loop-authoring worker defines and validates success parameters/checkpoints, persists the loop contract, then releases/requeues the task. It MUST NOT execute the resulting task. An execution worker may claim only a ready contract authored by another agent and MUST execute against those persisted parameters. No worker may redefine its own success conditions. Verification is independent.
CODING=GitHubIssueCanonicalExecutionState; one independent coding task->one worker->one Issue->one PR. ASYNC=started->wait/poll->inspect->repair/retry->poll->verify; never stop while a started/pollable process remains. OBSTACLE=normalize->semanticSearch->reuseOrCreate->record->resolve->verify. Never keep essential context only in chat or secrets in task records/logs.
SKILL TIMING: use this skill when its trigger matches; load supporting skills before their required action, not after. Prefer the narrowest specialist skill plus only necessary support skills. If the substrate changes, update the canonical Supabase skill and repository copy, then independently verify parity.

## Mandatory private-CI routing invariant

A private repository must **never** be used as the GitHub Actions execution substrate for this workflow.

When CI/build/test evidence is required for a private target:

1. Provision an **ephemeral public ATAX workspace repository** with the ATAX repository lifecycle/disposable-workspace tooling.
2. The public workspace is a **compute bridge only**. It must not contain or publish the private target source.
3. At workflow runtime, clone the authorized private target into the ephemeral workspace using a least-privilege secret/token.
4. Execute the target's CI/checks on the public repository's GitHub-hosted runner.
5. Capture workflow logs/artifacts as evidence and independently verify the result.
6. Delete the ephemeral public repository and verify that deletion.
7. Never commit, push, cache, artifact, or otherwise expose the private target source in the public workspace.

Local execution may be used for fast reproduction and debugging, but it does not replace the required ephemeral-public-workspace path when remote GitHub CI evidence is required.

**Hard rule:** private target + CI → ephemeral public workspace → runtime private clone → public GitHub runner → evidence → independent verification → deletion verification.

Do not fall back to running the target workflow directly in the private repository merely because native private Actions are available.