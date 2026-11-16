#!/usr/bin/env bash
set -euo pipefail
: "${CLONED_REPO:?CLONED_REPO is required}"
: "${RUN_ROOT:?RUN_ROOT is required}"
: "${ARTIFACT_ROOT:?ARTIFACT_ROOT is required}"
EVENT="${CI_EVENT:-push}"
WORKFLOW="${CI_WORKFLOW:-}"
ACT_BIN="${ACT_BIN:-act}"
ATAX_ROOT="${ATAX_ROOT:-${GITHUB_WORKSPACE:-}}"
ACT_RUNNER_IMAGE="${ACT_RUNNER_IMAGE:-atax/act-runner:ubuntu-24.04}"
# No repository credential crosses into the target workflow execution process.
unset PRIVATE_REPO_TOKEN ACT_GITHUB_TOKEN GITHUB_TOKEN GH_TOKEN || true

docker build --pull --file "$ATAX_ROOT/tools/private-repo-ci/act-runner/Dockerfile" --tag "$ACT_RUNNER_IMAGE" "$ATAX_ROOT/tools/private-repo-ci/act-runner"
ACT_PLATFORM_ARGS=(--platform "ubuntu-latest=$ACT_RUNNER_IMAGE" --platform "ubuntu-24.04=$ACT_RUNNER_IMAGE")
cd "$CLONED_REPO"
if [[ -n "${TARGET_REF:-}" ]] && git rev-parse --verify "$TARGET_REF^{commit}" >/dev/null 2>&1; then
  expected="$(git rev-parse "$TARGET_REF^{commit}")"; actual="$(git rev-parse HEAD)"
  [[ "$actual" == "$expected" ]] || { echo "Clone ref verification failed: expected $expected, got $actual" >&2; exit 3; }
fi
command -v "$ACT_BIN" >/dev/null 2>&1 || { echo "act is required on the ATAX runner" >&2; exit 127; }
mapfile -t workflows < <(find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)
if [[ ${#workflows[@]} -eq 0 ]]; then echo "No GitHub Actions workflow definitions found."; exit 0; fi
run_one() {
  local wf="$1"
  echo "::group::CI workflow $wf"
  # No act artifact server is configured and no target artifacts are uploaded.
  "$ACT_BIN" "$EVENT" --pull=false -W "$wf" "${ACT_PLATFORM_ARGS[@]}"
  echo "::endgroup::"
}
if [[ -n "$WORKFLOW" ]]; then
  [[ -f ".github/workflows/$WORKFLOW" ]] || { echo "Workflow not found: $WORKFLOW" >&2; exit 2; }
  run_one ".github/workflows/$WORKFLOW"
else
  for wf in "${workflows[@]}"; do run_one "$wf"; done
fi
