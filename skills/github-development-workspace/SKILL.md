---
name: GitHub Development Workspace
slug: github-development-workspace
version: 1.3.1
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