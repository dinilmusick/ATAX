#!/usr/bin/env bash
set -euo pipefail

: "${CLONED_REPO:?CLONED_REPO is required}"

EVENT="${CI_EVENT:-push}"
REF="${TARGET_REF:-}"
WORKFLOW="${CI_WORKFLOW:-}"
ACT_BIN="${ACT_BIN:-act}"
# Build a small runner image from the act-24.04 base with git installed.
# The stock medium image omits git, while the full hosted-runner image is ~18GB compressed.
ATAX_ROOT="${ATAX_ROOT:-${GITHUB_WORKSPACE:-}}"
ACT_RUNNER_IMAGE="${ACT_RUNNER_IMAGE:-atax/act-runner:ubuntu-24.04}"
if [[ -n "$ATAX_ROOT" && -f "$ATAX_ROOT/tools/private-repo-ci/act-runner/Dockerfile" ]]; then
  if ! docker image inspect "$ACT_RUNNER_IMAGE" >/dev/null 2>&1; then
    docker build --pull \
      --file "$ATAX_ROOT/tools/private-repo-ci/act-runner/Dockerfile" \
      --tag "$ACT_RUNNER_IMAGE" \
      "$ATAX_ROOT/tools/private-repo-ci/act-runner"
  fi
fi
ACT_PLATFORM_ARGS=()
if [[ -n "${ACT_PLATFORM:-}" ]]; then
  IFS=',' read -r -a platform_overrides <<< "$ACT_PLATFORM"
  for platform in "${platform_overrides[@]}"; do
    [[ -n "$platform" ]] && ACT_PLATFORM_ARGS+=(--platform "$platform")
  done
else
  # GitHub-hosted workflows commonly use ubuntu-latest; act otherwise maps
  # that label to node:16-buster-slim, which omits git and diverges from Actions.
  ACT_PLATFORM_ARGS+=(--platform "ubuntu-latest=$ACT_RUNNER_IMAGE")
  ACT_PLATFORM_ARGS+=(--platform "ubuntu-24.04=$ACT_RUNNER_IMAGE")
fi
ACT_GITHUB_TOKEN="${ACT_GITHUB_TOKEN:-}"
ACT_SECRET_ARGS=()

if [[ -n "$ACT_GITHUB_TOKEN" ]]; then
  ACT_SECRET_ARGS+=(--secret "GITHUB_TOKEN=$ACT_GITHUB_TOKEN")
fi

cd "$CLONED_REPO"
if [[ -n "$REF" ]]; then
  actual="$(git rev-parse HEAD)"
  expected="$(git rev-parse "$REF" 2>/dev/null || true)"
  if [[ -n "$expected" && "$actual" != "$expected" ]]; then
    echo "Clone ref verification failed: expected $REF ($expected), got $actual" >&2
    exit 3
  fi
fi

if ! command -v "$ACT_BIN" >/dev/null 2>&1; then
  echo "act is required. Install it on local agents or use the public ATAX CI workflow." >&2
  exit 127
fi

mapfile -t workflows < <(find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)

if [[ ${#workflows[@]} -eq 0 ]]; then
  echo "No GitHub Actions workflow definitions found."
  exit 0
fi

run_one() {
  local wf="$1"
  echo "::group::CI workflow $wf"
  "$ACT_BIN" "$EVENT" \
    -W "$wf" \
    "${ACT_PLATFORM_ARGS[@]}" \
    --artifact-server-path /tmp/agent-workspace-artifacts \
    "${ACT_SECRET_ARGS[@]}"
  echo "::endgroup::"
}

if [[ -n "$WORKFLOW" ]]; then
  [[ -f ".github/workflows/$WORKFLOW" ]] || { echo "Workflow not found: $WORKFLOW" >&2; exit 2; }
  run_one ".github/workflows/$WORKFLOW"
else
  for wf in "${workflows[@]}"; do
    run_one "$wf"
  done
fi
