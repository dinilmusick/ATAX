#!/usr/bin/env bash
# ATAX: PR-only source reconciliation. No default-branch writes or source artifacts.
set -euo pipefail
: "${CODING_REPO_TOKEN:?Missing CODING_REPO_TOKEN}"
export GH_TOKEN="$CODING_REPO_TOKEN"
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$CODING_REPO_TOKEN" | base64 -w0)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --no-tags https://github.com/dinilmusick/ULTRST-Armada.git "$tmp/armada"
cd "$tmp/armada"
git config user.name 'ATAX Sync'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
upstream_branch() { gh api "repos/dinilmusick/$1" --jq '.default_branch'; }
pr_open() { [[ "$(gh pr list -R "$1" --state open --head "$2" --json number --jq 'length')" != 0 ]]; }
branch_exists() { gh api "repos/$1/git/ref/heads/$2" >/dev/null 2>&1; }
sync_one() {
  local name="$1" prefix="$2" source="$3"
  local remote="dinilmusick/$source"
  git clone --quiet --no-tags "https://github.com/$remote.git" "$tmp/$name"
  local src_branch
  src_branch="$(upstream_branch "$source")"
  local upstream_sha
  upstream_sha="$(git -C "$tmp/$name" rev-parse HEAD)"
  local base_sha
  base_sha="$(git rev-parse origin/main)"
  local upstream_tree armada_tree
  upstream_tree="$(git -C "$tmp/$name" rev-parse 'HEAD^{tree}')"
  if ! armada_tree="$(git rev-parse "${base_sha}:${prefix}" 2>/dev/null)"; then
    echo "::error::Missing canonical Armada prefix $prefix for $name" >&2
    return 1
  fi
  # Identical source trees need no synthetic subtree split, empty PR, or merge.
  if [[ "$armada_tree" == "$upstream_tree" ]]; then
    echo "Inbound current: $name"
    echo "Outbound current: $name"
    return 0
  fi
  local inbranch="armada-in-${name,,}-${upstream_sha:0:12}"
  git checkout -q -B "$inbranch" "$base_sha"
  if git subtree pull --prefix="$prefix" "$tmp/$name" HEAD --squash >/dev/null 2>"$tmp/inbound-error"; then
    if [[ "$(git rev-parse HEAD)" != "$base_sha" ]]; then
      if ! branch_exists 'dinilmusick/ULTRST-Armada' "$inbranch"; then
        git push -q origin "HEAD:refs/heads/$inbranch"
      fi
      if ! pr_open 'dinilmusick/ULTRST-Armada' "$inbranch"; then
        gh pr create -R dinilmusick/ULTRST-Armada --base main --head "$inbranch" \
          --title "sync: import $name upstream ${upstream_sha:0:12}" \
          --body "ATAX inbound sync from $remote at $upstream_sha. Review changes and verify CI before merge." >/dev/null
      fi
      echo "Inbound PR: $name ${upstream_sha:0:12}"
    else
      echo "Inbound current: $name"
    fi
  else
    echo "::warning::Inbound conflict: $name; manual reconciliation required"
    git reset --hard -q "$base_sha"
  fi
  git checkout -q -B armada-export "$base_sha"
  local split_sha
  if ! split_sha="$(git subtree split --prefix="$prefix" 2>"$tmp/outbound-error")"; then
    echo "::warning::Outbound split failed: $name"
    return 0
  fi
  local split_tree
  split_tree="$(git rev-parse "${split_sha}^{tree}")"
  if [[ "$split_tree" == "$upstream_tree" ]]; then
    echo "Outbound current: $name"
    return 0
  fi
  git fetch -q "$tmp/$name" HEAD
  if ! git merge-base --is-ancestor "$upstream_sha" "$split_sha"; then
    echo "::warning::Outbound divergent: $name; reconcile source first"
    return 0
  fi
  local outbranch="armada-out-${name,,}-${split_sha:0:12}"
  if ! branch_exists "$remote" "$outbranch"; then
    git push -q "https://github.com/$remote.git" "$split_sha:refs/heads/$outbranch"
  fi
  if ! pr_open "$remote" "$outbranch"; then
    gh pr create -R "$remote" --base "$src_branch" --head "$outbranch" \
      --title "sync: export Armada $name ${split_sha:0:12}" \
      --body "ATAX outbound subtree export from dinilmusick/ULTRST-Armada $prefix at $split_sha. Review changes and CI before merge." >/dev/null
  fi
  echo "Outbound PR: $name ${split_sha:0:12}"
}
# Canonical final locations only: a missing prefix is a hard error.
for prefix in \
  libraries/TypeScript-React/GutTS \
  libraries/TypeScript-React/KrnlTS \
  libraries/TypeScript-React/FrnlTS \
  libraries/TypeScript-React/Kloks \
  libraries/TypeScript-React/Floks \
  libraries/PHP-WordPress/GutWP \
  libraries/PHP-WordPress/KrnlWP \
  libraries/PHP-WordPress/FrnlWP \
  libraries/PHP-WordPress/KloksWP \
  libraries/PHP-WordPress/FloksWP \
  framework/Skipo framework/SkipoWP \
  apps/Aiko apps/SRKL apps/Kone; do
  [[ -d "$prefix" ]] || { echo "::error::Missing canonical prefix $prefix" >&2; exit 1; }
done
sync_one GutTS libraries/TypeScript-React/GutTS GutTS
sync_one KrnlTS libraries/TypeScript-React/KrnlTS KrnlTS
sync_one FrnlTS libraries/TypeScript-React/FrnlTS FrnlTS
sync_one Kloks libraries/TypeScript-React/Kloks Kloks
sync_one Floks libraries/TypeScript-React/Floks Floks
sync_one GutWP libraries/PHP-WordPress/GutWP GutWP
sync_one KrnlWP libraries/PHP-WordPress/KrnlWP KrnlWP
sync_one FrnlWP libraries/PHP-WordPress/FrnlWP FrnlWP
sync_one KloksWP libraries/PHP-WordPress/KloksWP KloksWP
sync_one FloksWP libraries/PHP-WordPress/FloksWP FloksWP
sync_one Skipo framework/Skipo Skipo
sync_one SkipoWP framework/SkipoWP SkipoWP
sync_one Aiko apps/Aiko Aiko
sync_one SRKL apps/SRKL Srkl-Engine
sync_one Kone apps/Kone Kone
echo 'ATAX Armada reconciliation scan finished.'
