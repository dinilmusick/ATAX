# ATAX Private Repository CI

ATAX (dinilmusick/ATAX) is the active private-repository CI execution repository. Agent-Workspace-1 is historical only and is not an execution target, secret destination, or workflow authority.

## Execution contract

- .github/workflows/private-repo-ci.yml is the canonical runner.
- workflow_dispatch always resolves only that run's explicit inputs.
- push resolves .agent/ci-request.json.
- Dispatch never reads or edits the shared request file.
- Each Actions run uses github.workspace/.private-ci/<run_id>-<run_attempt> for its clone and temporary artifact directories.
- The clone is full-history and isolated to that run.
- PRIVATE_REPO_TOKEN exists only in the clone step and is removed from the clone process after use.
- Target workflows run with no repository token. The default and only supported credential policy is clone-only.
- ATAX does not configure an artifact server or upload target artifacts/private source.
- Cleanup removes only the current run's clone and independently verifies that its clone root is empty.
- Target workflow definitions execute from the private clone; they are never copied into ATAX workflow paths.

## Request contract

Dispatch inputs: repository (owner/name), optional ref, event (defaults to push), and optional workflow filename.

Push request: .agent/ci-request.json with repository, optional ref, optional event, and optional workflow.

The resolver is tools/private-repo-ci/resolve-request.sh. It deliberately has disjoint trigger branches: dispatch inputs are authoritative, while only push reads the request file.

## Runtime

The runner installs pinned act v0.2.89 with SHA256 verification. It always builds tools/private-repo-ci/act-runner/Dockerfile locally and uses that image with --pull=false for both ubuntu-latest and ubuntu-24.04. The image includes Git for target checks such as merge-base and diff validation.

## Tests

Run: bash tools/private-repo-ci/tests/test-private-repo-ci.sh

The regression suite resolves Kloks and KONE dispatch payloads concurrently while the shared request file names SRKL, verifies push request-file behavior, checks run-scoped cleanup/empty-root verification, validates clone-only token scope and no artifact upload, checks full-history cloning and platform mappings, and parses shell/YAML syntax.

## Evidence and privacy

GitHub Actions run IDs, attempt numbers, target/ref metadata, and cleanup verification are written to that run's Actions summary. ATAX intentionally does not upload target workflow artifacts or private source. GitHub Actions logs remain scoped to the individual run. Only run metadata and test output should be used as evidence; never add private source or credentials to artifacts, caches, commits, or summaries.
