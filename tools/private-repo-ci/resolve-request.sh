#!/usr/bin/env bash
set -euo pipefail
: "${CI_TRIGGER:?CI_TRIGGER is required}"
REQUEST_FILE="${CI_REQUEST_FILE:-.agent/ci-request.json}"
OUTPUT_FILE="${GITHUB_ENV:?GITHUB_ENV is required}"

if [[ "$CI_TRIGGER" == "workflow_dispatch" ]]; then
  # Dispatch inputs belong to this run and always win. Do not read the request file.
  repository="${INPUT_REPOSITORY:-}"
  ref="${INPUT_REF:-}"
  event="${INPUT_EVENT:-push}"
  workflow="${INPUT_WORKFLOW:-}"
elif [[ "$CI_TRIGGER" == "push" ]]; then
  [[ -f "$REQUEST_FILE" ]] || { echo "Push request file not found: $REQUEST_FILE" >&2; exit 2; }
  repository="$(jq -er '.repository' "$REQUEST_FILE")"
  ref="$(jq -er '.ref // ""' "$REQUEST_FILE")"
  event="$(jq -er '.event // "push"' "$REQUEST_FILE")"
  workflow="$(jq -er '.workflow // ""' "$REQUEST_FILE")"
else
  echo "Unsupported trigger: $CI_TRIGGER" >&2
  exit 2
fi

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid repository (expected owner/name): $repository" >&2; exit 2; }
[[ "$event" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || { echo "Invalid act event: $event" >&2; exit 2; }
if [[ -n "$workflow" ]]; then
  [[ "$workflow" =~ ^[A-Za-z0-9_.-]+\.ya?ml$ ]] || { echo "Invalid workflow filename: $workflow" >&2; exit 2; }
fi
{
  printf 'TARGET_REPOSITORY=%s\n' "$repository"
  printf 'TARGET_REF=%s\n' "$ref"
  printf 'CI_EVENT=%s\n' "$event"
  printf 'CI_WORKFLOW=%s\n' "$workflow"
  printf 'TOKEN_MODE=clone-only\n'
  printf 'CI_TRIGGER=%s\n' "$CI_TRIGGER"
} >> "$OUTPUT_FILE"
