---
name: ATAX Private Repository CI Runner
slug: private-repo-ci-workspace-runner
version: 1.4.0
source: ATAX repository
status: active
---

# Canonical execution authority

ATAX (dinilmusick/ATAX) is the active private-repository CI execution repository. Agent-Workspace-1 is historical only. Never dispatch its old workflow or configure it as an execution target.

## Request routing

- For workflow_dispatch, resolve only the inputs supplied to that specific workflow run. The existence or content of .agent/ci-request.json must have no effect.
- For push, resolve .agent/ci-request.json.
- Do not edit the shared request file to coordinate independent agents.
- Each run is isolated by github.run_id and github.run_attempt.

## Security invariants

- Clone private source only into the current run's ephemeral clone root.
- PRIVATE_REPO_TOKEN is available only to the clone step, used for Git authentication, and never passed to act or target workflow processes.
- The only supported token mode is clone-only.
- Never persist credentials in remote URLs or Git config.
- Never commit, cache, or upload private source. Do not configure an act artifact server or upload target workflow artifacts.
- Target workflow definitions execute from the runtime clone; do not copy them into ATAX.
- Cleanup is unconditional, run-scoped, and independently verifies the current clone root is empty.

## Runtime

ATAX installs pinned act v0.2.89 with SHA256 verification, builds the local Git-enabled image from tools/private-repo-ci/act-runner/Dockerfile, and maps both ubuntu-latest and ubuntu-24.04 to that image. Cloning is full-history so merge-base checks can inspect target history.

## Regression tests

Run bash tools/private-repo-ci/tests/test-private-repo-ci.sh. The suite tests concurrent Kloks/KONE request resolution against a conflicting request file, push request-file routing, run-scoped cleanup and empty-root verification, clone-only token scope, no target artifact upload, complete history clone, platform mappings, shell syntax and workflow YAML parsing.

## Evidence

Persist the ATAX Actions run ID/attempt, resolved target/ref, test results, and cleanup verification in the run summary and canonical Supabase task evidence. Never put private source or credentials in task evidence. GitHub Actions run logs are independent per run.

## Failure handling

Classify failures as request-resolution, token/clone, workflow-validation, act/runtime, target-workflow, or cleanup failures. Repair the ATAX substrate when the runner caused the failure. Rerun and independently verify cleanup before declaring success.
