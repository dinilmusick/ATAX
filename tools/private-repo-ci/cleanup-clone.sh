#!/usr/bin/env bash
set -euo pipefail
: "${CLONE_ROOT:?CLONE_ROOT is required}"
: "${RUN_ROOT:?RUN_ROOT is required}"
mkdir -p "$CLONE_ROOT"
if [[ -n "${CLONED_REPO:-}" ]]; then
  case "$CLONED_REPO" in "$CLONE_ROOT"/*) ;; *) echo "Refusing to remove path outside this run's clone root" >&2; exit 2 ;; esac
  [[ ! -e "$CLONED_REPO" ]] || rm -rf -- "$CLONED_REPO"
fi
if [[ -n "$(find "$CLONE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Clone root is not empty after cleanup:" >&2
  find "$CLONE_ROOT" -mindepth 1 -maxdepth 1 -print >&2
  exit 3
fi
# Independently recheck after deletion; this root belongs only to this run.
[[ -z "$(find "$CLONE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo "Empty clone-root verification failed" >&2; exit 4; }
rm -rf -- "${ARTIFACT_ROOT:-$RUN_ROOT/artifacts}"
echo "Cleanup verified: this run's clone root is empty: $CLONE_ROOT"
