#!/usr/bin/env bash
# ATAX external runner: deterministic PR-only ULTRST Armada subtree synchronization.
set -euo pipefail

ARMADA='dinilmusick/ULTRST-Armada'
DRY_RUN="${ARMADA_SYNC_DRY_RUN:-0}"
TEST_ROOT="${ARMADA_SYNC_TEST_REPO_ROOT:-}"
[[ "$DRY_RUN" == 0 || "$DRY_RUN" == 1 ]] || { echo 'Invalid ARMADA_SYNC_DRY_RUN' >&2; exit 2; }
if [[ -n "$TEST_ROOT" ]]; then
  [[ "$DRY_RUN" == 1 ]] || { echo 'Local repository fixtures require dry run' >&2; exit 2; }
  ARMADA_URL="${TEST_ROOT%/}/ULTRST-Armada.git"
else
  : "${CODING_REPO_TOKEN:?Missing CODING_REPO_TOKEN}"
  export GH_TOKEN="$CODING_REPO_TOKEN" GIT_TERMINAL_PROMPT=0
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$CODING_REPO_TOKEN" | base64 -w0)"
  export GIT_CONFIG_VALUE_0
  ARMADA_URL="https://github.com/$ARMADA.git"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone -q --no-tags "$ARMADA_URL" "$TMP/armada"
cd "$TMP/armada"
git config user.name 'ATAX Sync Review'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
BASE_SHA="$(git rev-parse --verify refs/remotes/origin/main^{commit})"
MANIFEST="$TMP/armada/scripts/armada-components.json"
[[ -f "$MANIFEST" ]] || { echo 'Missing canonical Armada component manifest' >&2; exit 1; }

# This is the only mapping authority. Fail before any outbound mutation on bad input.
python3 - "$MANIFEST" >"$TMP/mappings.tsv" <<'PY'
import json, pathlib, re, sys
j = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
if j.get('schema') != 1 or not isinstance(j.get('components'), list) or not j['components']:
    sys.exit('Invalid Armada mapping schema')
seen_n, seen_p, seen_r = set(), set(), set()
for x in j['components']:
    n,p,r=(x.get(k) for k in ('name','prefix','repository'))
    if not all(isinstance(v,str) for v in (n,p,r)) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9]*',n) or not re.fullmatch(r'(?:apps|framework)/[A-Za-z0-9_.-]+|libraries/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',p) or not re.fullmatch(r'dinilmusick/[A-Za-z0-9_.-]+',r):
        sys.exit('Invalid component mapping: '+str(x))
    if n in seen_n or p in seen_p or r in seen_r:
        sys.exit('Duplicate component name/prefix/repository')
    seen_n.add(n);seen_p.add(p);seen_r.add(r)
    print('\t'.join((n,p,r)))
PY

remote_head() {
  local url="$1" branch="$2" result
  result="$(git ls-remote --exit-code "$url" "refs/heads/$branch")" || return 1
  printf '%s\n' "$result" | awk 'NR == 1 {print $1}'
}
default_branch() {
  local url="$1" line
  line="$(git ls-remote --symref "$url" HEAD | awk '$1 == "ref:" && $3 == "HEAD" {print $2;exit}')" || return 1
  line="${line#refs/heads/}"
  [[ "$line" =~ ^[A-Za-z0-9._/-]+$ && "$line" != -* && "$line" != *..* ]] || return 1
  printf '%s' "$line"
}

# Must be called immediately before publishing any candidate; never accept stale heads.
verify_frozen_heads() {
  local src_url="$1" src_branch="$2" src_sha="$3" base_sha="$4" now_src now_arm
  now_src="$(remote_head "$src_url" "$src_branch")" || return 1
  now_arm="$(remote_head "$ARMADA_URL" main)" || return 1
  [[ "$now_src" == "$src_sha" && "$now_arm" == "$base_sha" ]]
}

# An existing open sync proposal for the same component blocks another proposal;
# we never accumulate duplicate snapshots or overwrite a moving branch.
pending_sync_pr() {
  local repo="$1" name="$2" direction="$3" titles
  titles="$(gh api --paginate "repos/$repo/pulls?state=open&per_page=100" --jq '.[].title')" || return 2
  if [[ "$direction" == inbound ]]; then
    grep -Eq "^sync(: import ${name} upstream |\\(${name}\\):)" <<< "$titles"
  else
    grep -Eq "^sync: export Armada ${name} " <<< "$titles"
  fi
}
branch_exists() {
  local response
  response="$(gh api "repos/$1/git/ref/heads/$2" 2>&1)" && return 0
  if [[ "$response" == *'HTTP 404'* || "$response" == *'Not Found'* ]]; then return 1; fi
  echo "::warning::Unable to verify remote branch existence ($1:$2): $response" >&2
  return 2
}

propose_inbound() {
  local name="$1" prefix="$2" remote="$3" url="$4" src_branch="$5" src_sha="$6" src_tree="$7" base="$8"
  local work="$TMP/inbound-$name" candidate arm_tree changes removed out branch status
  git worktree add -q --detach "$work" "$base"
  if ! (cd "$work" && git -c user.name='ATAX Sync Review' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      subtree pull --prefix="$prefix" "$url" "$src_sha" --squash >"$TMP/$name.inbound.log" 2>&1); then
    echo "::warning::BLOCKED inbound conflict $name ($src_sha); original main unchanged" >&2
    git worktree remove --force "$work" >/dev/null 2>&1 || true
    return 1
  fi
  candidate="$(git -C "$work" rev-parse HEAD)"
  arm_tree="$(git -C "$work" rev-parse "HEAD:$prefix")"
  changes="$(git diff --name-only "$base" "$candidate")"
  removed="$(git diff --name-only --diff-filter=D "$base" "$candidate" -- "$prefix")"
  if [[ "$candidate" == "$base" || "$arm_tree" != "$src_tree" || -n "$removed" ]] ||
      { [[ -n "$changes" ]] && grep -Ev "^${prefix}/" <<< "$changes"; }; then
    echo "::warning::BLOCKED unsafe/non-exact inbound $name (deletions, divergence, outside-prefix changes or no commit)" >&2
    git worktree remove --force "$work" >/dev/null 2>&1 || true
    return 1
  fi
  git worktree remove --force "$work" >/dev/null 2>&1 || true
  branch="armada-in-${name,,}-${src_sha:0:12}"
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "DRY_RUN inbound component=$name base=$base upstream=$src_sha tree=$src_tree candidate=$candidate"
    return 0
  fi
  if ! verify_frozen_heads "$url" "$src_branch" "$src_sha" "$base"; then
    echo "::warning::BLOCKED moved source/Armada head during inbound $name" >&2; return 1
  fi
  if pending_sync_pr "$ARMADA" "$name" inbound; then
    echo "::notice::Existing inbound $name PR requires resolution; no duplicate"; return 0
  fi
  if branch_exists "$ARMADA" "$branch"; then
    echo "::warning::BLOCKED existing inbound branch $branch; no replacement/duplicate" >&2; return 1
  fi
  git push -q origin "$candidate:refs/heads/$branch"
  gh pr create -R "$ARMADA" --base main --head "$branch" \
     --title "sync: import $name upstream ${src_sha:0:12}" \
     --body "Canonical source: $remote\nUpstream-Commit: $src_sha\nUpstream-Tree: $src_tree\nArmada-Base: $base\nCandidate-Commit: $candidate\n\nExact tree, no deleted files, and only $prefix paths changed. Review CI before merge." >/dev/null
  echo "INBOUND_PR component=$name upstream=$src_sha base=$base branch=$branch"
}

propose_outbound() {
  local name="$1" prefix="$2" remote="$3" url="$4" src_branch="$5" src_sha="$6" src_tree="$7" base="$8" split="$9"
  local branch="armada-out-${name,,}-${split:0:12}"
  local split_tree status
  split_tree="$(git rev-parse "$split^{tree}")"
  [[ "$split_tree" == "$(git rev-parse "$base:$prefix")" ]] || { echo "::warning::BLOCKED split tree mismatch $name" >&2; return 1; }
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "DRY_RUN outbound component=$name base=$base upstream=$src_sha split=$split tree=$split_tree"
    return 0
  fi
  if ! verify_frozen_heads "$url" "$src_branch" "$src_sha" "$base"; then
    echo "::warning::BLOCKED moved source/Armada head during outbound $name" >&2; return 1
  fi
  if pending_sync_pr "$remote" "$name" outbound; then
    echo "::notice::Existing outbound $name PR requires resolution; no duplicate"; return 0
  fi
  if branch_exists "$remote" "$branch"; then
    echo "::warning::BLOCKED existing outbound branch $branch; no replacement/duplicate" >&2; return 1
  fi
  git push -q "$url" "$split:refs/heads/$branch"
  # The PR remains reviewed in the canonical source repository; default branch untouched.
  gh pr create -R "$remote" --base "$src_branch" --head "$branch" \
    --title "sync: export Armada $name ${split:0:12}" \
    --body "Armada-Base: $base\nArmada-Prefix: $prefix\nCanonical-Source: $remote\nCanonical-Before: $src_sha\nCandidate-Split: $split\nCandidate-Tree: $split_tree\n\nCanonical source SHA was confirmed ancestor of the split. Review CI and authorization before merge; no default branch write." >/dev/null
  echo "OUTBOUND_PR component=$name upstream=$src_sha split=$split base=$base branch=$branch"
}

sync_one() {
  local name="$1" prefix="$2" remote="$3" source="$4" branch head source_tree arm_tree split split_tree
  if [[ -n "$TEST_ROOT" ]]; then source="${TEST_ROOT%/}/${remote##*/}.git"; fi
  [[ -d "$TMP/armada/$prefix" ]] || { echo "::error::Missing Armada subtree $prefix" >&2; return 1; }
  branch="$(default_branch "$source")" || { echo "::error::Unable to determine default branch for $remote" >&2; return 1; }
  head="$(remote_head "$source" "$branch")" || { echo "::error::Unable to resolve source head $remote:$branch" >&2; return 1; }
  git clone -q --no-tags --single-branch --branch "$branch" "$source" "$TMP/src-$name"
  [[ "$(git -C "$TMP/src-$name" rev-parse HEAD)" == "$head" ]] || { echo "::warning::Source moved while cloning $remote" >&2; return 1; }
  source_tree="$(git -C "$TMP/src-$name" rev-parse 'HEAD^{tree}')"
  arm_tree="$(git rev-parse "$BASE_SHA:$prefix")"
  echo "OBSERVE component=$name upstream=$head source_tree=$source_tree armada_base=$BASE_SHA armada_tree=$arm_tree"
  if [[ "$source_tree" == "$arm_tree" ]]; then echo "PARITY $name"; return 0; fi
  # Fetch canonical commit ancestry before splitting; never force or fabricate source parentage.
  git fetch -q --no-tags "$TMP/src-$name" "$branch"
  if ! split="$(git subtree split --prefix="$prefix" "$BASE_SHA" 2>"$TMP/$name.split.log")"; then
    echo "::warning::BLOCKED unable to calculate subtree split $name" >&2; return 1
  fi
  split_tree="$(git rev-parse "$split^{tree}")"
  [[ "$split_tree" == "$arm_tree" ]] || { echo "::warning::BLOCKED non-identical subtree split $name" >&2; return 1; }
  if git merge-base --is-ancestor "$head" "$split"; then
    propose_outbound "$name" "$prefix" "$remote" "$source" "$branch" "$head" "$source_tree" "$BASE_SHA" "$split"
  else
    propose_inbound "$name" "$prefix" "$remote" "$source" "$branch" "$head" "$source_tree" "$BASE_SHA"
  fi
}

# Only fixtures may limit the number of components, to avoid a production partial scan.
FAILURES=0
while IFS=$'\t' read -r name prefix remote; do
  source_url="https://github.com/$remote.git"
  if ! sync_one "$name" "$prefix" "$remote" "$source_url"; then FAILURES=$((FAILURES + 1)); fi
done <"$TMP/mappings.tsv"
echo "ATAX_ARMADA_SYNC_RESULT base=$BASE_SHA failures=$FAILURES"
[[ "$FAILURES" == 0 ]]
