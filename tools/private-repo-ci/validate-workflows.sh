#!/usr/bin/env bash
set -euo pipefail
: "${CLONED_REPO:?CLONED_REPO is required}"
cd "$CLONED_REPO"
dir=".github/workflows"
[[ -d "$dir" ]] || { echo "No .github/workflows directory."; exit 0; }
mapfile -t workflows < <(find "$dir" -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)
[[ ${#workflows[@]} -gt 0 ]] || { echo "No workflow definitions."; exit 0; }
status=0
for wf in "${workflows[@]}"; do
  echo "::group::Validate $wf"
  echo "workflow=$wf"
  grep -E '^[[:space:]]*(runs-on|uses|container):' "$wf" || true
  if grep -Eq "runs-on:[[:space:]]*(macos|windows)" "$wf"; then
    echo "::warning file=$wf::Non-Linux runner requested; this ATAX Linux runner cannot faithfully execute it."
    status=1
  fi
  if grep -Eq '\.github/workflows/[^[:space:]]+@[A-Za-z0-9._/-]+' "$wf"; then
    echo "::notice file=$wf::Workflow references reusable workflows; act support depends on target workflow structure."
  fi
  if grep -Eq '\$\{\{[[:space:]]*secrets\.' "$wf"; then
    echo "::warning file=$wf::Target secrets are not forwarded by ATAX clone-only execution."
  fi
  echo "::endgroup::"
done
exit "$status"
