#!/usr/bin/env bash
set -euo pipefail

: "${PRIVATE_REPO_TOKEN:?PRIVATE_REPO_TOKEN is required}"
: "${TARGET_REPOSITORY:?TARGET_REPOSITORY must be owner/name or a GitHub URL}"

ROOT="${CLONE_ROOT:-${GITHUB_WORKSPACE}/clones}"
REF="${TARGET_REF:-}"
mkdir -p "$ROOT"

repo="$TARGET_REPOSITORY"
repo="${repo#https://github.com/}"
repo="${repo#git@github.com:}"
repo="${repo%.git}"
repo="${repo%%/*}/${repo#*/}"
owner="${repo%%/*}"
name="${repo#*/}"
slug="${owner}__${name}"

if [[ -z "$owner" || -z "$name" || "$owner" == "$name" ]]; then
  echo "Invalid TARGET_REPOSITORY: $TARGET_REPOSITORY" >&2
  exit 2
fi

DEST="$ROOT/$slug"
rm -rf "$DEST"

URL="https://x-access-token:${PRIVATE_REPO_TOKEN}@github.com/$owner/$name.git"
if [[ -n "$REF" ]]; then
  git clone --no-single-branch --branch "$REF" "$URL" "$DEST"
else
  git clone --no-single-branch "$URL" "$DEST"
fi

# Keep the complete target history and remote base refs available for checks such as
# git merge-base origin/main HEAD; never leave the access token in git config.
git -C "$DEST" remote set-url origin "https://github.com/$owner/$name.git"
git -C "$DEST" remote set-url --push origin "https://github.com/$owner/$name.git"

printf '%s\n' "$DEST"
