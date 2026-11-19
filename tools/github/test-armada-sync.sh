#!/usr/bin/env bash
set -euo pipefail
script="${ARMADA_SYNC_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/armada-sync.sh}"
root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT
mkdir "$root/source" "$root/armada"
git init -q --bare "$root/GutWP.git"; git init -q --bare "$root/ULTRST-Armada.git"
for repo in source armada; do git -C "$root/$repo" init -q -b main; git -C "$root/$repo" config user.name fixture;git -C "$root/$repo" config user.email fixture@example.com;done
printf 'base\n' > "$root/source/file.txt"; git -C "$root/source" add .;git -C "$root/source" commit -qm source-base;git -C "$root/source" remote add origin "$root/GutWP.git";git -C "$root/source" push -q -u origin main;git -C "$root/GutWP.git" symbolic-ref HEAD refs/heads/main
mkdir -p "$root/armada/scripts";cat > "$root/armada/scripts/armada-components.json" <<'JSON'
{"schema":1,"components":[{"name":"GutWP","prefix":"libraries/PHP-WordPress/GutWP","repository":"dinilmusick/GutWP"}]}
JSON
printf 'Armada fixture\n' > "$root/armada/README.md";git -C "$root/armada" add .;git -C "$root/armada" commit -qm armada-base; git -C "$root/armada" subtree add --prefix=libraries/PHP-WordPress/GutWP "$root/GutWP.git" main --squash >/dev/null
git -C "$root/armada" remote add origin "$root/ULTRST-Armada.git";git -C "$root/armada" push -q -u origin main;git -C "$root/ULTRST-Armada.git" symbolic-ref HEAD refs/heads/main
printf 'source advance\n' > "$root/source/new.txt";git -C "$root/source" add .;git -C "$root/source" commit -qm source-new;git -C "$root/source" push -q origin main
export ARMADA_SYNC_DRY_RUN=1 ARMADA_SYNC_TEST_REPO_ROOT="$root"
output="$(bash "$script")"
printf 'inbound: %s\n' "$output"
[[ "$output" == *'DRY_RUN inbound'* ]] || { echo 'Expected dry-run inbound';exit 1; }
# Now update Armada with a real subtree import and verify exact-current idempotency.
git -C "$root/armada" subtree pull --prefix=libraries/PHP-WordPress/GutWP "$root/GutWP.git" main --squash -m fixture-sync >/dev/null
git -C "$root/armada" push -q origin main
output="$(bash "$script")"
printf 'parity: %s\n' "$output"
[[ "$output" == *'PARITY GutWP'* ]] || { echo 'Expected parity';exit 1; }
# Armada-owned edit should propose only an upstream source PR (never push in dry-run).
printf 'armada-only\n' > "$root/armada/libraries/PHP-WordPress/GutWP/local.txt"; git -C "$root/armada" add .;git -C "$root/armada" commit -qm armada-local;git -C "$root/armada" push -q origin main
output="$(bash "$script")"
printf 'outbound: %s\n' "$output"
[[ "$output" == *'DRY_RUN outbound'* ]] || { echo 'Expected outbound';exit 1; }
# Source diverges independently; no candidate should be proposed from either direction.
printf 'remote\n' > "$root/source/file.txt";git -C "$root/source" add .;git -C "$root/source" commit -qm remote-divergence;git -C "$root/source" push -q origin main
set +e
output="$(bash "$script" 2>&1)";rc=$?
set -e
printf 'divergent: rc=%s output=%s\n' "$rc" "$output"
[[ $rc -ne 0 && "$output" == *'BLOCKED unsafe/non-exact inbound'* ]] || { echo 'Expected divergence blocked';exit 1; }
# Source and Armada default refs remain untouched by both dry runs.
[[ "$(git -C "$root/source" rev-parse HEAD)" == "$(git -C "$root/GutWP.git" rev-parse refs/heads/main)" ]]
[[ "$(git -C "$root/armada" rev-parse HEAD)" == "$(git -C "$root/ULTRST-Armada.git" rev-parse refs/heads/main)" ]]
echo 'PASS controller: inbound/parity/outbound/divergence + no remote writes'
