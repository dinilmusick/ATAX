#!/usr/bin/env bash
set -euo pipefail
: "${PRIVATE_REPO_TOKEN:?PRIVATE_REPO_TOKEN is required for cloning only}"
: "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}"
: "${CLONE_ROOT:?CLONE_ROOT must be run-specific}"
: "${RUN_ROOT:?RUN_ROOT must be run-specific}"
if [[ ! "$TARGET_REPOSITORY" =~ ^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then
  echo "Invalid target repository: $TARGET_REPOSITORY" >&2; exit 2
fi
owner="${BASH_REMATCH[1]}"; name="${BASH_REMATCH[2]}"
mkdir -p "$CLONE_ROOT"
DEST="$CLONE_ROOT/${owner}__${name}"
[[ ! -e "$DEST" ]] || { echo "Clone destination already exists: $DEST" >&2; exit 2; }

# Publish the cleanup target before clone starts so an interrupted/failed clone is removable.
{
  echo "CLONED_REPO=$DEST"
  echo "CLONED_REPOSITORY=$TARGET_REPOSITORY"
} >> "${GITHUB_ENV:?GITHUB_ENV is required}"

auth="$(printf 'x-access-token:%s' "$PRIVATE_REPO_TOKEN" | base64 | tr -d '\n')"
(
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=http.extraheader
  export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
  git clone --no-single-branch "https://github.com/$TARGET_REPOSITORY.git" "$DEST"
)
unset auth PRIVATE_REPO_TOKEN

git -C "$DEST" remote set-url origin "https://github.com/$TARGET_REPOSITORY.git"
git -C "$DEST" remote set-url --push origin "https://github.com/$TARGET_REPOSITORY.git"
if [[ -n "${TARGET_REF:-}" ]]; then
  git -C "$DEST" fetch --no-tags origin "$TARGET_REF"
  git -C "$DEST" checkout --detach FETCH_HEAD
fi
if git -C "$DEST" config --local --get-regexp 'http\..*extraheader' >/dev/null 2>&1; then
  echo "Credential residue detected in clone git configuration" >&2; exit 3
fi
