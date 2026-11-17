#!/usr/bin/env bash
# Run only in a disposable FMRL runner, on private source checkouts.
# All code moves occur on a fresh branch, never on Armada main.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP required}"
root="$RUNNER_TEMP/armada-layout"
armada="$root/armada"
[[ -d "$armada/.git" ]] || { echo 'Armada checkout missing' >&2; exit 2; }
cd "$armada"
[[ "$(git branch --show-current)" == main ]] || { echo 'Checkout must start on main' >&2; exit 2; }
git config user.name 'ATAX Armada Migration'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
core_names=(GutTS KrnlTS FrnlTS Kloks Floks Skipo)
core_old=(libraries/GutTS libraries/KrnlTS libraries/FrnlTS libraries/Kloks libraries/Floks scaffold/Skipo)
core_new=(libraries/TypeScript-React/GutTS libraries/TypeScript-React/KrnlTS libraries/TypeScript-React/FrnlTS libraries/TypeScript-React/Kloks libraries/TypeScript-React/Floks framework/Skipo)
wp_names=(GutWP KrnlWP FrnlWP KloksWP FloksWP SkipoWP)
wp_new=(libraries/PHP-WordPress/GutWP libraries/PHP-WordPress/KrnlWP libraries/PHP-WordPress/FrnlWP libraries/PHP-WordPress/KloksWP libraries/PHP-WordPress/FloksWP framework/SkipoWP)
# Independently compare *all* six legacy directories before deleting any.
for i in "${!core_names[@]}"; do
  name="${core_names[$i]}"
  old="${core_old[$i]}"
  new="${core_new[$i]}"
  test -d "$old" || { echo "Missing legacy source: $old" >&2; exit 1; }
  test ! -e "$new" || { echo "Destination exists already: $new" >&2; exit 1; }
  test -d "$root/source-$name/.git" || { echo "Clone missing: $name" >&2; exit 1; }
  if ! diff -qr --exclude=.git "$old" "$root/source-$name" > "$root/diff-$name.log"; then
    echo "Local changes detected in $old; refusing to overwrite. Diff summary:" >&2
    head -25 "$root/diff-$name.log" >&2
    exit 1
  fi
  echo "Verified $old identical to $name"
done
for i in "${!wp_names[@]}"; do
  new="${wp_new[$i]}"
  test ! -e "$new" || { echo "WP destination exists already: $new" >&2; exit 1; }
  test -d "$root/source-${wp_names[$i]}/.git"
done
git switch -q -c "layout/stack-folders-$GITHUB_RUN_ID"
git rm -qr -- "${core_old[@]}"
git commit -qm 'refactor: retire legacy library and scaffold paths before subtree imports'
for i in "${!core_names[@]}"; do
  name="${core_names[$i]}"
  new="${core_new[$i]}"
  git subtree add --prefix="$new" "$root/source-$name" HEAD --squash -m "refactor: import $name into language-stack layout"
  diff -qr --exclude=.git "$new" "$root/source-$name" > "$root/verify-$name.log" || { echo "Post-import $name mismatch" >&2; exit 1; }
  echo "Imported $name => $new"
done
for i in "${!wp_names[@]}"; do
  name="${wp_names[$i]}"
  new="${wp_new[$i]}"
  git subtree add --prefix="$new" "$root/source-$name" HEAD --squash -m "feat: import WordPress/PHP $name subtree"
  diff -qr --exclude=.git "$new" "$root/source-$name" > "$root/verify-$name.log" || { echo "Post-import $name mismatch" >&2; exit 1; }
  echo "Imported $name => $new"
done
for i in "${!core_names[@]}"; do
  test ! -e "${core_old[$i]}" || { echo 'Legacy path retained' >&2; exit 1; }
done
for new in "${core_new[@]}" "${wp_new[@]}"; do
  test -d "$new" || exit 1
done
test -z "$(git status --porcelain)" || { git status --short; exit 1; }
git fsck --no-reflogs --connectivity-only
printf 'MIGRATION_COMPLETE branch=%s commit=%s\n' "$(git branch --show-current)" "$(git rev-parse HEAD)"
