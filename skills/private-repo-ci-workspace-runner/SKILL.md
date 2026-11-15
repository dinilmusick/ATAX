---
name: "Private Repository CI Workspace Runner"
slug: private-repo-ci-workspace-runner
version: 1.3.1
source: Supabase Skills Database
sourceId: 39
status: active
---

## ATAX Private Repository Execution Rule

For private-repository CI/build/test work, use **ATAX GitHub tools**, not the ChatGPT GitHub connector, to provision and execute the workflow. First attempt the **container/runtime**: clone ATAX there, use its tools, and attempt direct target cloning. If the private target cannot be cloned directly, ATAX provisions an **ephemeral public repository as a compute bridge**; clone that public bridge into the container when possible, and keep the private source private. If the container cannot execute the required work, use the bridge's public GitHub runner. The private target is cloned only at runtime. Required lifecycle: **ATAX provision → runtime private clone → execute → evidence → independent verification → delete bridge → verify deletion**. Never run the target CI directly in the private repository and never publish private source to the public bridge.

**Credential distinction:** an Actions repository secret is consumed by the GitHub runner at runtime; it is not automatically readable by the agent's local process. Do not report an ATAX runner as credential-blocked merely because the local process lacks a token. Verify the ATAX runner path first.
# Private Repository CI Workspace Runner

Canonical ATAX path for executing and verifying GitHub Actions for private repositories.

## When to use

Use extensively whenever a private repository needs CI/build/test evidence and the private repository requires CI/build/test evidence. Do not let private CI availability become a dead end.

## Mandatory obstacle reflex

Every failed or degraded CI step is an obstacle candidate.

```text
run
  -> observe failure
  -> classify
  -> semantic-search obstacle memory
  -> record occurrence + evidence
  -> apply verified solution / repair
  -> rerun
  -> independently verify
  -> update obstacle resolution
```

Do not jump directly from a red CI result to editing application code.

## Execution

**Container/runtime first; ATAX public runner second.**

1. Clone ATAX into the container and attempt direct private-target cloning.
2. If direct cloning fails, use ATAX GitHub tools to provision an **ephemeral public repository** as a compute bridge.
3. Configure the bridge's encrypted Actions secret with least-privilege private-repository access. The secret is consumed by GitHub Actions at runtime; it is not expected to be visible to the agent's local process.
4. Clone the public bridge into the container when network access permits and work through it there. Otherwise execute through the bridge's public GitHub-hosted runner.
5. Validate the target ref/workflows and execute the selected workflow with pinned `act`.
6. Poll until terminal; capture logs, tests, typecheck/build output and artifacts.
7. On failure: classify → obstacle-search → record → repair smallest layer → rerun → independently verify.
8. Remove the private checkout, delete the ephemeral public repository, and independently verify deletion.

Never switch to direct private-repository CI. Never publish private source to the bridge.
## Failure classification

Distinguish:
- workflow infrastructure failure;
- clone/ref/token failure;
- dependency/toolchain failure;
- implementation failure;
- test-wiring/import failure;
- environment-dependent runtime failure;
- ATAX substrate defect.

The last category is important: when the runner itself caused the failure, improve the runner/skill/workflow rather than teaching the target repository to work around the defect.

## Known incidents

### Luth test-import drift

ATAX run `42039453905` cloned `dinilmusick/Luth@main`, validated workflows, installed dependencies, and passed typecheck, but failed because `tests/canonical-auth-contract.test.ts` imported `getSystemDatabaseUrl` from the wrong module. The canonical resolver lived in `src/backend/types.ts`. The error was `TypeError: getSystemDatabaseUrl is not a function`. The test was corrected and rerun successfully in ATAX run `42042564939`.

### ATAX act bootstrap transient failure

ATAX run `42043556266` failed while installing `act` because a single GitHub release download returned HTTP 504. Clone and target workflow execution were skipped. The substrate was hardened with bounded curl retries/timeouts while retaining SHA256 verification. Subsequent run `42043746694` reached successful act installation, clone, workflow validation, and target-workflow execution.

## Evidence

A successful result requires:
- a real ATAX Actions run;
- target verification evidence;
- independent verification where applicable;
- confirmed clone cleanup;
- obstacle records for material failures encountered during the run.

## Pattern

```text
request
 -> clone
 -> validate-ref
 -> inspect-test-wiring
 -> act
 -> classify
 -> obstacle-search
 -> obstacle-record
 -> repair
 -> rerun
 -> independent-verify
 -> evidence
 -> cleanup
 -> obstacle-resolution-update
```


## SUBSTRATE_PROTOCOL_V3
All agents are ephemeral workers. Supabase is canonical coordination state; chat is not durable state. Before acting, load the current Task Ledger and the narrowest applicable specialist skill. Persist every meaningful checkpoint: current_step, activity, progress, discoveries, blockers, evidence and next_action.
WORKER=discover->resolve->route->plan->persist->claim->execute->evidence->independentVerify->finalize. Claims MUST use the atomic ledger claim path. HEARTBEAT~2m->checkpoint+renew lease. OWNERSHIP_CHECK~5m->if fence is lost: append final handoff note, stop immediately, and never overwrite the new owner. Recovery is allowed after heartbeat silence>=5m; the new worker reads the task row, checkpoint and task events before continuing. Use fenced release for queued/blocked/abandoned work.
LOOPS=separateAuthor->readyContract->independentExecutor. A loop-authoring worker defines and validates success parameters/checkpoints, persists the loop contract, then releases/requeues the task. It MUST NOT execute the resulting task. An execution worker may claim only a ready contract authored by another agent and MUST execute against those persisted parameters. No worker may redefine its own success conditions. Verification is independent.
CODING=GitHubIssueCanonicalExecutionState; one independent coding task->one worker->one Issue->one PR. ASYNC=started->wait/poll->inspect->repair/retry->poll->verify; never stop while a started/pollable process remains. OBSTACLE=normalize->semanticSearch->reuseOrCreate->record->resolve->verify. Never keep essential context only in chat or secrets in task records/logs.
SKILL TIMING: use this skill when its trigger matches; load supporting skills before their required action, not after. Prefer the narrowest specialist skill plus only necessary support skills. If the substrate changes, update the canonical Supabase skill and repository copy, then independently verify parity.

## Mandatory private-CI routing invariant

This runner is the public-workspace bridge for private repositories. **Never execute CI directly in the private target repository.**

Required lifecycle:

provision ephemeral public workspace → configure least-privilege secret → clone private target at runtime → validate target workflow → execute on public GitHub runner → capture evidence → independently verify → delete workspace → verify deletion

The ephemeral public repository is a temporary **compute bridge**, not a source mirror. The private target source must never be committed or pushed into it, and must not appear in public artifacts or logs.

Use the ATAX disposable-workspace/repository-lifecycle tooling rather than inventing a separate repository lifecycle. Local execution is allowed for reproduction, but when GitHub Actions evidence is requested/required the public-workspace path is mandatory.

If the public-workspace path cannot be provisioned, classify the substrate obstacle and repair the substrate; do not silently switch to direct private-repository CI.