#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REQUEST="$TMP/ci-request.json"
export CI_REQUEST_FILE="$REQUEST"
cat > "$REQUEST" <<'JSON'
{"repository":"dinilmusick/SRKL","ref":"decoy-ref","event":"pull_request","workflow":"decoy.yml","token_mode":"workflow"}
JSON
resolve() {
  local trigger="$1" repo="$2" ref="$3" event="$4" workflow="$5" out="$6"
  : > "$out"
  CI_TRIGGER="$trigger" INPUT_REPOSITORY="$repo" INPUT_REF="$ref" INPUT_EVENT="$event" INPUT_WORKFLOW="$workflow" GITHUB_ENV="$out" bash "$ROOT/tools/private-repo-ci/resolve-request.sh"
}
resolve workflow_dispatch dinilmusick/Kloks feature/parallel-a pull_request ci.yml "$TMP/a.env" & pid_a=$!
resolve workflow_dispatch dinilmusick/KONE feature/parallel-b push checks.yml "$TMP/b.env" & pid_b=$!
wait "$pid_a"; wait "$pid_b"
grep -qx 'TARGET_REPOSITORY=dinilmusick/Kloks' "$TMP/a.env"
grep -qx 'TARGET_REF=feature/parallel-a' "$TMP/a.env"
grep -qx 'TARGET_REPOSITORY=dinilmusick/KONE' "$TMP/b.env"
grep -qx 'TARGET_REF=feature/parallel-b' "$TMP/b.env"
! grep -q SRKL "$TMP/a.env"; ! grep -q SRKL "$TMP/b.env"
echo "PASS: concurrent Kloks and KONE dispatch requests independently ignore decoy request file"

resolve push ignored/dispatch ignored-ref ignored-event ignored.yml "$TMP/push.env"
grep -qx 'TARGET_REPOSITORY=dinilmusick/SRKL' "$TMP/push.env"
grep -qx 'TARGET_REF=decoy-ref' "$TMP/push.env"
grep -qx 'CI_EVENT=pull_request' "$TMP/push.env"
grep -qx 'CI_WORKFLOW=decoy.yml' "$TMP/push.env"
grep -qx 'TOKEN_MODE=clone-only' "$TMP/push.env"
echo "PASS: push reads request file and enforces clone-only"

export RUN_ROOT="$TMP/run-1" CLONE_ROOT="$TMP/run-1/clones" TARGET_REPOSITORY=dinilmusick/Kloks
export CLONED_REPO="$CLONE_ROOT/dinilmusick__Kloks"
mkdir -p "$CLONED_REPO/.git" "$TMP/run-2/clones/other-repo"
touch "$CLONED_REPO/source.txt" "$TMP/run-2/clones/other-repo/keep.txt"
bash "$ROOT/tools/private-repo-ci/cleanup-clone.sh"
test ! -e "$CLONED_REPO"
test -f "$TMP/run-2/clones/other-repo/keep.txt"
test -z "$(find "$CLONE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)"
echo "PASS: cleanup is run-scoped and clone root independently verified empty"

WF="$ROOT/.github/workflows/private-repo-ci.yml"
! grep -Eq '^[[:space:]]+PRIVATE_REPO_TOKEN:' "$WF"
grep -qF 'PRIVATE_REPO_TOKEN: ${{ secrets.PRIVATE_REPO_TOKEN }}' "$WF"
! grep -q 'actions/upload-artifact' "$WF"
grep -q 'unset PRIVATE_REPO_TOKEN ACT_GITHUB_TOKEN GITHUB_TOKEN GH_TOKEN' "$ROOT/tools/private-repo-ci/run-workflows.sh"
grep -q 'git clone --no-single-branch' "$ROOT/tools/private-repo-ci/clone-private-repo.sh"
grep -q 'ubuntu-latest=' "$ROOT/tools/private-repo-ci/run-workflows.sh"
grep -q 'ubuntu-24.04=' "$ROOT/tools/private-repo-ci/run-workflows.sh"
echo "PASS: clone-only token scope, no target artifact upload, complete history clone, both runner mappings"

# Exercise the clone script with a fake Git binary: the raw secret must not reach
# Git's environment, while the process-local authorization header must be present.
mkdir -p "$TMP/fakebin"
cat > "$TMP/fakebin/git" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "clone" ]]; then
  [[ -z "${PRIVATE_REPO_TOKEN:-}" ]] || exit 91
  [[ "${GIT_CONFIG_VALUE_0:-}" == AUTHORIZATION:* ]] || exit 92
  dest="${@: -1}"
  mkdir -p "$dest/.git"
  printf '[remote "origin"]\n\turl = https://github.com/dinilmusick/Kloks.git\n' > "$dest/.git/config"
  exit 0
fi
if [[ "${1:-}" == "-C" ]]; then
  shift; shift
  if [[ "${1:-}" == "config" ]]; then exit 1; fi
  exit 0
fi
exit 0
MOCK
chmod +x "$TMP/fakebin/git"
export PATH="$TMP/fakebin:$PATH"
export PRIVATE_REPO_TOKEN="test-secret-must-not-reach-git"
export TARGET_REPOSITORY=dinilmusick/Kloks
export TARGET_REF=""
export RUN_ROOT="$TMP/clone-run"
export CLONE_ROOT="$RUN_ROOT/clones"
export GITHUB_ENV="$TMP/clone.env"
mkdir -p "$CLONE_ROOT"
bash "$ROOT/tools/private-repo-ci/clone-private-repo.sh"
grep -qx "CLONED_REPO=$CLONE_ROOT/dinilmusick__Kloks" "$GITHUB_ENV"
! grep -q 'test-secret-must-not-reach-git' "$CLONE_ROOT/dinilmusick__Kloks/.git/config"
unset PRIVATE_REPO_TOKEN
echo "PASS: clone uses ephemeral auth header and raw token is absent from Git subprocess and clone config"

# Per-run path and runtime assertions.
grep -q 'github.run_id' "$WF"
grep -q 'github.run_attempt' "$WF"
grep -q 'docker build --pull' "$ROOT/tools/private-repo-ci/run-workflows.sh"
grep -q -- '--pull=false' "$ROOT/tools/private-repo-ci/run-workflows.sh"
grep -q 'apt-get install --yes --no-install-recommends git' "$ROOT/tools/private-repo-ci/act-runner/Dockerfile"
! grep -q 'actions/cache' "$WF"
! grep -q -- '--depth' "$ROOT/tools/private-repo-ci/clone-private-repo.sh"
echo "PASS: per-run path isolation, locally built Git-enabled act image, no source cache"

for f in resolve-request.sh clone-private-repo.sh run-workflows.sh cleanup-clone.sh; do bash -n "$ROOT/tools/private-repo-ci/$f"; done
ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0), aliases: true)' "$WF"
echo "PASS: shell syntax and workflow YAML parse"
