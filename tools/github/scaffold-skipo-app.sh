#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${SKIPO_REPOSITORY:=dinilmusick/Skipo}"
APP_REPOSITORY="${1:?target owner/name is required}"
APP_NAME="${2:?application name is required}"
REF="${3:-main}"
WORK="${RUNNER_TEMP:-/tmp}/skipo-app-${APP_NAME}"

rm -rf -- "$WORK"
mkdir -p "$WORK"
trap 'rm -rf -- "$WORK"' EXIT

# Repository creation is a narrowly scoped provisioning operation, not a
# generic execution workspace. Never persist tokens in .git/config or remotes.
auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
git -c http.extraheader="$auth_header" clone --depth 1 --branch "$REF" "https://github.com/${SKIPO_REPOSITORY}.git" "$WORK/skipo"
git -c http.extraheader="$auth_header" clone --depth 1 "https://github.com/${APP_REPOSITORY}.git" "$WORK/app"

cd "$WORK/skipo"
# Skipo generator is pure Python stdlib and does not require package-manager bootstrap.
# Avoid external registry downloads in repository creation.
python3 assistant.py generate scaffold "$WORK/app" --name "$APP_NAME" --force

cd "$WORK/app"
if [[ "$REF" != "main" ]]; then git switch -c "$REF"; fi

python3 "$WORK/skipo/assistant.py" validate . --json > "$WORK/validation.json"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add .
if ! git diff --cached --quiet; then
  git commit -m "feat: scaffold $APP_NAME from Skipo"
  git -c http.extraheader="$auth_header" push origin "HEAD:${REF}"
fi

cat "$WORK/validation.json"
