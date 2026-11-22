#!/usr/bin/env python3
"""Provision a disposable FMRL public bridge for private CI (ATAX is control-plane only).

The private source is never copied into the public repository. The bridge
contains only a workflow, stores a least-privilege token as an Actions secret,
clones the private target at runtime, executes its workflow with act, and
removes the checkout before the job ends.
"""
from __future__ import annotations
import argparse, base64, json, os, re, shutil, subprocess, time, uuid
from pathlib import Path
from urllib import error, request

API_ROOT = "https://api.github.com"
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atax-disposable-github-workspace",
}

WORKFLOW = """name: Disposable FMRL Private CI

on:
  push:
    branches: [main]
    paths: [.fmrl/execute]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  private-ci:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      FMRL_EXECUTION_MODE: ${{ secrets.FMRL_EXECUTION_MODE }}
    steps:
      - name: Checkout trusted static public FMRL writeback helper
        if: env.FMRL_EXECUTION_MODE == 'repair'
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false

      - name: Verify secret-bound private identity and exact commit
        env:
          TARGET_REPOSITORY: ${{ secrets.FMRL_TARGET_REPOSITORY }}
          TARGET_REF: ${{ secrets.FMRL_TARGET_REF }}
        shell: bash
        run: |
          set -euo pipefail
          [[ "$TARGET_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
          [[ "$TARGET_REF" =~ ^[0-9a-f]{40}$ ]]
          [[ "$FMRL_EXECUTION_MODE" =~ ^(direct|act|repair)$ ]]

      - name: Clone private target at runtime
        env:
          PRIVATE_REPO_TOKEN: ${{ secrets.PRIVATE_REPO_TOKEN }}
          TARGET_REPOSITORY: ${{ secrets.FMRL_TARGET_REPOSITORY }}
          TARGET_REF: ${{ secrets.FMRL_TARGET_REF }}
        shell: bash
        run: |
          set -euo pipefail
          test -n "$PRIVATE_REPO_TOKEN"
          rm -rf target
          # GitHub Git-over-HTTPS uses username/token credentials, not a REST API Bearer header.
          # Credentials are supplied only to this checkout step, never stored in a remote URL.
          askpass="$(mktemp)"
          trap 'rm -f "$askpass" /tmp/fmrl-clone-private.log' EXIT
          cat > "$askpass" <<'ASKPASS'
          #!/usr/bin/env bash
          case "$1" in
            *Username*) printf %s 'x-access-token' ;;
            *Password*) printf %s "$PRIVATE_REPO_TOKEN" ;;
            *) exit 1 ;;
          esac
          ASKPASS
          chmod 700 "$askpass"
          export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0
          # Even Git stderr can contain the private repository URL and SHA.
          # Suppress all raw clone/checkout output to a transient runner-only
          # file; only sanitized step status is allowed in public job logs.
          if ! git -c credential.helper= \
            clone --no-checkout "https://github.com/$TARGET_REPOSITORY.git" target \
            >/tmp/fmrl-clone-private.log 2>&1; then
            echo "FMRL private clone failed (details suppressed)" >&2
            exit 1
          fi
          if ! git -C target -c credential.helper= \
            fetch --no-tags origin "$TARGET_REF" \
            >>/tmp/fmrl-clone-private.log 2>&1; then
            echo "FMRL exact private SHA fetch failed (details suppressed)" >&2
            exit 1
          fi
          if ! git -C target checkout --detach FETCH_HEAD \
            >>/tmp/fmrl-clone-private.log 2>&1; then
            echo "FMRL exact private SHA checkout failed (details suppressed)" >&2
            exit 1
          fi
          test "$(git -C target rev-parse HEAD)" = "$TARGET_REF"
          rm -f /tmp/fmrl-clone-private.log
          echo "FMRL exact private SHA verified without exposing its value"

      - name: Install pinned act
        if: env.FMRL_EXECUTION_MODE == 'act'
        shell: bash
        run: |
          set -euo pipefail
          curl -fsSL --retry 6 --retry-delay 4 --retry-all-errors --connect-timeout 20 --max-time 180 \
            https://github.com/nektos/act/releases/download/v0.2.89/act_Linux_x86_64.tar.gz -o /tmp/act.tar.gz
          echo "0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0  /tmp/act.tar.gz" | sha256sum -c -
          tar -xzf /tmp/act.tar.gz -C /tmp act
          sudo install -m 0755 /tmp/act /usr/local/bin/act

      - name: Execute target workflow
        if: env.FMRL_EXECUTION_MODE == 'act'
        env:
          TARGET_EVENT: ${{ secrets.FMRL_TARGET_EVENT }}
          TARGET_WORKFLOW: ${{ secrets.FMRL_TARGET_WORKFLOW }}
        shell: bash
        run: |
          set -euo pipefail
          cd target
          test -d .git
          # Nested act on GitHub-hosted runners must mount the checked-out private worktree.
          # This mount exists only inside the ephemeral runner; no source is committed to FMRL.
          args=("$TARGET_EVENT" "--bind" "--directory" "$PWD" "--platform" "ubuntu-latest=catthehacker/ubuntu:act-latest" "--platform" "ubuntu-24.04=catthehacker/ubuntu:act-latest")
          if [[ -n "$TARGET_WORKFLOW" && "$TARGET_WORKFLOW" != "-" ]]; then
            [[ "$TARGET_WORKFLOW" =~ ^[A-Za-z0-9_.-]+\.ya?ml$ ]] || exit 2
            test -f ".github/workflows/$TARGET_WORKFLOW"
            args+=("-W" ".github/workflows/$TARGET_WORKFLOW")
          fi
          # Never stream private target test output into the public FMRL job log.
          # Retain raw output only in this transient runner and report safe
          # categories/codes, not paths, source fragments, or secret values.
          set +e
          act "${args[@]}" >/tmp/fmrl-nested-raw.log 2>&1
          nested_status=$?
          set -e
          python3 - <<'DIAGNOSTICS'
          import collections
          import re
          from pathlib import Path

          value = Path('/tmp/fmrl-nested-raw.log').read_text(errors='replace')
          counts = collections.Counter()
          signals = (
              ('typescript', r'TS[0-9]{4}'),
              ('npm-install', r'npm (?:ERR!|error) code [A-Za-z0-9_-]+'),
              ('dependency-resolution', r'ERESOLVE|ERR_PNPM_[A-Z0-9_]+'),
              ('missing-module', r'cannot find module|module not found'),
              ('docker-daemon', r'cannot connect to the docker daemon'),
              ('docker-image', r'failed to pull image|docker.*(?:denied|rate limit|error response)'),
              ('permission', r'permission denied|resource not accessible'),
              ('network', r'getaddrinfo|econnreset|etimedout|name resolution'),
              ('disk', r'no space left on device'),
              ('runtime-error', r'(?:typeerror|syntaxerror|referenceerror|assertionerror)'),
              ('act-error', r'(?:act).*?(?:error|failed|fatal)'),
          )
          for category, pattern in signals:
              counts[category] = len(re.findall(pattern, value, flags=re.I))
          codes = sorted(set(re.findall(r'TS[0-9]{4}|ERR_PNPM_[A-Z0-9_]+|(?<=npm error code )[A-Z0-9_-]+', value)))
          print('FMRL nested execution diagnostic: raw target output suppressed')
          print('Nested failure categories: ' + ', '.join(
              '%s=%d' % (key, num) for key, num in counts.items() if num
          ) if any(counts.values()) else 'No recognized safe failure categories')
          print('Safe error identifiers: ' + ', '.join(codes[:16]) if codes else 'No safe code identifier found')
          DIAGNOSTICS
          rm -f /tmp/fmrl-nested-raw.log
          exit "$nested_status"

      - name: Set up direct-suite Node host
        if: env.FMRL_EXECUTION_MODE == 'direct' || env.FMRL_EXECUTION_MODE == 'repair'
        uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Set up frozen pnpm host
        if: env.FMRL_EXECUTION_MODE == 'direct' || env.FMRL_EXECUTION_MODE == 'repair'
        uses: pnpm/action-setup@v4
        with:
          version: 10.33.0

      - name: Run portable private-suite checks (not full workflow parity)
        if: env.FMRL_EXECUTION_MODE == 'direct'
        shell: bash
        run: |
          set -euo pipefail
          set +e
          (
            set -euo pipefail
            cd target
            test -f package.json
            if [[ -f pnpm-lock.yaml ]]; then
              pnpm install --frozen-lockfile
              export FMRL_PACKAGE_MANAGER=pnpm
            elif [[ -f package-lock.json ]]; then
              npm ci --include=optional --no-audit --no-fund
              export FMRL_PACKAGE_MANAGER=npm
            else
              exit 42
            fi
            node --input-type=module <<'NODE'
            import fs from 'node:fs';
            import {spawnSync} from 'node:child_process';
            const p=JSON.parse(fs.readFileSync('package.json','utf8'));
            const scripts=p.scripts || {};
            const manager=process.env.FMRL_PACKAGE_MANAGER;
            if (!scripts.test || !scripts.build || !(scripts.typecheck || scripts.lint))
              throw new Error('Direct CI requires test, build and lint/typecheck');
            // Verify generated bundle/artifacts only AFTER building the app.
            // Running verify:bundle against a missing dist/ is a false CI failure.
            const ordered=['check:canonical-ui','lint','typecheck','validate:api',
              'verify:ecosystem-package-chain','verify:architecture','build',
              'verify:bundle','test','verify:build-artifacts'];
            const executed=[];
            for (const name of ordered) {
              if (!scripts[name]) continue;
              const r=spawnSync(manager,['run',name],{cwd:process.cwd(),
                stdio:'inherit',env:process.env});
              if (r.error) throw r.error;
              if (r.status !== 0) {
                // The mandatory gate has already failed. The diagnostic is
                // strictly additive, owner-scoped, and read-only. Its entire
                // output remains in the ephemeral private raw log; only the
                // static allowlisted categories below leave this runner.
                if (name === 'validate:api' && p.name === 'frnes' &&
                    scripts['validate:diagnostic'] === 'node scripts/frnes-validate-skipo.mjs') {
                  const diagnostic=spawnSync(manager,['run','validate:diagnostic'],{
                    cwd:process.cwd(),stdio:'inherit',env:process.env,timeout:40000,
                  });
                  if (diagnostic.error) console.log('FMRL diagnostic unavailable');
                }
                throw new Error('Direct CI failed: '+name+' exit='+r.status);
              }
              executed.push(name);
            }
            if (!executed.includes('test') || !executed.includes('build'))
              throw new Error('Missing mandatory direct CI gates');
            console.log('FMRL portable checks passed: '+executed.join(','));
          NODE
          ) >/tmp/fmrl-direct-raw.log 2>&1
          result=$?
          set -e
          python3 - "$result" <<'SAFE'
          from pathlib import Path
          import re,sys
          output=Path('/tmp/fmrl-direct-raw.log').read_text(errors='replace')
          code=int(sys.argv[1])
          print('FMRL direct suite: '+('PASS' if code==0 else 'FAIL')+'; exit='+str(code))
          print('FMRL coverage: frozen install plus portable package scripts; NOT full workflow parity')
          receipt=re.findall(r'FMRL portable checks passed: ([A-Za-z0-9:_, -]+)',output)
          if receipt: print('FMRL verified script names: '+receipt[-1][:250])
          if code:
              categories={
                'lockfile':r'ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|npm (?:error|ERR!) code EUSAGE|package-lock.json.*(?:in sync|out of sync)',
                'dependency':r'ERESOLVE|ERR_PNPM_[A-Z0-9_]+|npm (?:error|ERR!) code (?:ETARGET|E404)',
                'network':r'getaddrinfo|econnreset|etimedout|ENOTFOUND',
                'typescript':r'TS[0-9]{4}',
                'module':r'cannot find module|module not found',
                'runtime':r'typeerror|syntaxerror|referenceerror|assertionerror'}
              codes=sorted(set(re.findall(
                r'ERR_PNPM_[A-Z0-9_]+|(?<=npm error code )[A-Z0-9_]+|(?<=npm ERR! code )[A-Z0-9_]+',
                output,re.I)))
              summary=', '.join(
                key+'='+str(len(re.findall(pat,output,re.I))) for key,pat in categories.items()
                if re.search(pat,output,re.I))
              if codes: summary+=' codes='+','.join(codes[:8])
              print('FMRL failure categories: '+summary[:250])
              failed=re.search(r'Direct CI failed: ([A-Za-z0-9:._-]+) exit=([0-9]+)',output)
              print('FMRL failing gate: '+(failed.group(1) if failed else 'frozen-install-or-setup'))
              # Only fixed-format error identifiers and npm script names are public.
              # Source lines, paths, stack traces and arbitrary target stdout remain private.
              ts_codes=sorted(set(re.findall(r'TS[0-9]{4}',output)))
              if ts_codes:
                  print('FMRL TypeScript codes: '+','.join(ts_codes[:12]))
              nested=re.findall(
                  r'^> .{1,120} (test:[A-Za-z0-9:_-]+|verify:[A-Za-z0-9:_-]+|check:[A-Za-z0-9:_-]+|build(?::[A-Za-z0-9:_-]+)?|typecheck) *$',
                  output,re.M)
              if nested:
                  print('FMRL last observed nested script: '+nested[-1])
              # Restrict public diagnostics to package-manager error identifiers.
              # Do not print dependency names, private paths, source, or raw logs.
              codes=sorted(set(re.findall(
                r'ERR_PNPM_[A-Z0-9_]+|(?<=npm error code )[A-Z0-9_-]+|(?<=npm ERR! code )[A-Z0-9_-]+',
                output,re.I)))
              print('Safe error identifiers: '+(','.join(codes[:12]) if codes else 'none'))
              # Fixed-format error codes and allowlisted test-script stages only.
              ts_codes=sorted(set(re.findall(r'\\bTS[0-9]{4}\\b',output)))
              print('FMRL TypeScript codes: '+(','.join(ts_codes[:12]) if ts_codes else 'none'))
              # Only these audited Skipo invariant codes may leave the
              # private runner; no raw diagnostics, paths, strings or tokens.
              approved={
                  'SKIPO_CANONICAL_DEPENDENCY_MISMATCH',
                  'SKIPO_DEPENDENCY_STATE_MISMATCH',
                  'SKIPO_VERSION_MISMATCH',
                  'SKIPO_MIGRATION_NOT_APPLIED',
                  'SKIPO_MIGRATION_PENDING',
                  'SKIPO_MIGRATION_STATE_INVALID',
                  'SKIPO_GENERATED_MISSING',
                  'SKIPO_CHECKSUM_MISMATCH',
                  'SKIPO_PROVIDER_OWNERSHIP_MISMATCH',
                  'SKIPO_ARCHITECTURE_AMBIGUOUS',
                  'SKIPO_NONCANONICAL_SOURCE',
                  'SKIPO_CONSTRAINT_ENV-001',
                  'SKIPO_CONSTRAINT_VALIDATOR_FAILED',
                  'SKIPO_DEPENDENCY_MIGRATION_INCOMPLETE',
                  'SKIPO_FORBIDDEN_ENVIRONMENT_VARIABLE',
                  'SKIPO_CANONICAL_SHELL_INVALID',
                  'SKIPO_ARCHITECTURAL_DRIFT_RETIRE',
              }
              seen=set(re.findall(r'\\bSKIPO_[A-Z0-9_-]+\\b',output))
              safe=sorted(seen.intersection(approved))
              print('FMRL Skipo rule IDs: '+(','.join(safe) if safe else 'none'))
              # Frnes emits only fixed private migration error categories.
              allowed_categories={'missing-contract','unapplied','lockfile',
                  'installed','migration-path','unsafe-path','deprecated-pattern',
                  'integrity','version','unclassified',
                  'invalid-exact-version','unsupported-specifier',
                  'invalid-requirement','invalid-package-declaration',
                  'required-dependency','conflicting-constraints',
                  'incompatible-range','skipo-version-requirement',
                  'invalid-contract','missing-provider-declaration',
                  'invalid-baseline','version-other',
                  # Frnes read-only Skipo verification status classifier emits
                  # only these fixed enums (never raw input or rule text).
                  'cli-exit-nonzero','root-not-ok','operation-unexpected',
                  'root-status-unexpected','diagnostics-not-array',
                  'diagnostics-present','independent-absent',
                  'architecture-failed','maintenance-failed',
                  'capabilities-failed','environment-failed',
                  'dependency-failed','shell-failed','independent-failed',
                  'independent-unclassified','policy-diagnostics',
                  'semantic-diagnostics','skipo-diagnostics',
                  'other-diagnostics','policy-not-compliant',
                  'semantic-not-compliant','contract-status'}
              observed=re.findall(
                  r'(?m)^FMRL Skipo migration categories: ([a-z,-]{1,160})$',
                  output)
              items=set(observed[-1].split(',')) if observed else set()
              safe_classes=sorted(items.intersection(allowed_categories))
              print('FMRL Skipo migration categories: '+(
                  ','.join(safe_classes) if safe_classes else 'none'))
              subgates=re.findall(
                r'(?m)^>\\s*[^\\n\\s]+\\s+(test:(?:google-sdk-boundary|integration|system-env|architecture|ecosystem-hardening)|verify:ecosystem-package-chain)(?:\\s|$)',
                output)
              print('FMRL last observed nested script: '+(subgates[-1] if subgates else 'unknown'))
          SAFE
          rm -f /tmp/fmrl-direct-raw.log
          exit "$result"

      - name: Regenerate one lockfile without executing target scripts
        if: env.FMRL_EXECUTION_MODE == 'repair'
        shell: bash
        env:
          TARGET_REPOSITORY: ${{ secrets.FMRL_TARGET_REPOSITORY }}
        run: |
          set -euo pipefail
          test -d target/.git
          test ! -e target/.pnpmfile.cjs
          test ! -e target/.pnpmfile.mjs
          status=0
          if [[ "$TARGET_REPOSITORY" == dinilmusick/Luth || "$TARGET_REPOSITORY" == dinilmusick/Frnes ]]; then
            # Frnes may be introducing its first lockfile; the package manifest is authoritative.
            test -f target/package.json
            (cd target && pnpm install --lockfile-only --ignore-scripts --fix-lockfile --no-frozen-lockfile &&
               pnpm install --frozen-lockfile --ignore-scripts) >/tmp/fmrl-repair-raw.log 2>&1 || status=$?
          elif [[ "$TARGET_REPOSITORY" == dinilmusick/Aiko || "$TARGET_REPOSITORY" == dinilmusick/Srkl-Engine || "$TARGET_REPOSITORY" == dinilmusick/Embr ]]; then
            # Embr bootstraps its first lockfile in this isolated runner.
            test -f target/package.json
            if [[ "$TARGET_REPOSITORY" != dinilmusick/Embr ]]; then
              test -f target/package-lock.json
            fi
            (cd target && npm install --package-lock-only --ignore-scripts --no-audit --no-fund &&
               npm ci --ignore-scripts --no-audit --no-fund) >/tmp/fmrl-repair-raw.log 2>&1 || status=$?
          else
            echo 'FMRL repair denied for unapproved target'
            exit 1
          fi
          if [[ "$status" != 0 ]]; then
            echo 'FMRL lockfile regeneration failed; target output suppressed'
            grep -Eo 'ERR_PNPM_[A-Z0-9_]+|npm error code [A-Z0-9_]+' /tmp/fmrl-repair-raw.log \
              | sort -u | head -n 8 | sed 's/^/FMRL safe package error: /' || true
            rm -f /tmp/fmrl-repair-raw.log
            exit 1
          fi
          rm -f /tmp/fmrl-repair-raw.log
          git -C target diff --check >/dev/null
          echo 'FMRL lockfile regenerated and frozen install independently passed'

      - name: Atomically commit only the lockfile to exact private PR head
        if: env.FMRL_EXECUTION_MODE == 'repair'
        shell: bash
        env:
          FMRL_TARGET_REPOSITORY: ${{ secrets.FMRL_TARGET_REPOSITORY }}
          FMRL_TARGET_REF: ${{ secrets.FMRL_TARGET_REF }}
          FMRL_TARGET_BRANCH: ${{ secrets.FMRL_TARGET_BRANCH }}
          FMRL_REPAIR_WRITE_TOKEN: ${{ secrets.FMRL_REPAIR_WRITE_TOKEN }}
        run: |
          set -euo pipefail
          python3 tools/github/fmrl_lock_writer.py

      - name: Remove private checkout
        if: always()
        run: |
          set -euo pipefail
          # Nested act containers can create root-owned files in a bind-mounted checkout.
          # Use the host runner sudo to remove the checkout even after a failing target job.
          sudo rm -rf -- target
          test ! -e target
"""

def token() -> str:
    value = os.environ.get("CODING_REPO_TOKEN")
    if not value:
        raise SystemExit("Missing CODING_REPO_TOKEN for repository provisioning.")
    return value

def secrets_token() -> str:
    """Use a separate Secrets:write credential; never fall back to the provisioning token."""
    value = os.environ.get("FMRL_SECRETS_TOKEN")
    if not value:
        raise SystemExit("Missing FMRL_SECRETS_TOKEN for disposable repository Actions secret creation.")
    return value

def api(path: str, bearer: str, method: str = "GET", payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = request.Request(
        API_ROOT + path,
        data=body,
        method=method,
        headers={**HEADERS, "Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            if response.status == 204:
                return None
            return json.load(response)
    except error.HTTPError as exc:
        # The source repository path or API error body can contain private
        # target metadata. Never print it into public ATAX workflow logs.
        raise RuntimeError(f"GitHub API {method} operation failed (HTTP {exc.code}); target redacted") from None

def verify_deleted_public_bridge(repository: str) -> None:
    """Check public repository absence without reusing the provisioning token."""
    req = request.Request(API_ROOT + f"/repos/{repository}", headers=HEADERS)
    for attempt in range(5):
        try:
            with request.urlopen(req, timeout=20):
                pass
        except error.HTTPError as exc:
            if exc.code == 404:
                return
            raise RuntimeError(f"Independent FMRL deletion check failed: HTTP {exc.code}") from None
        if attempt < 4:
            time.sleep(2)
    raise RuntimeError(f"FMRL deletion not confirmed by anonymous GitHub GET: {repository}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Private source owner/name.")
    parser.add_argument("--target", default=None, help="FMRL-prefixed temporary public repo name.")
    parser.add_argument("--ref", default="", help="Exact target SHA or safe branch/tag to test.")
    parser.add_argument("--event", default="push", choices=("push", "pull_request", "workflow_dispatch"))
    parser.add_argument("--workflow", default="", help="Optional target workflow filename.")
    parser.add_argument("--mode", choices=("direct", "act", "repair"), default="direct", help="Portable exact-SHA direct CI or legacy nested act.")
    parser.add_argument("--branch", default="", help="Exact private PR branch for lockfile repair.")
    args = parser.parse_args()

    if args.source.count("/") != 1 or any(not p for p in args.source.split("/")):
        raise SystemExit("--source must be owner/name.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.source):
        raise SystemExit("--source must be a safe owner/name.")
    target_name = args.target or ("FMRL-" + uuid.uuid4().hex[:12])
    if not re.fullmatch(r"FMRL-[A-Za-z0-9-]+", target_name):
        raise SystemExit("--target must be an FMRL-prefixed repository name.")
    if args.source.lower() == "dinilmusick/atax":
        raise SystemExit("ATAX is control plane, never target checkout or runner.")

    if args.ref and not re.fullmatch(r"[A-Za-z0-9_./-]+", args.ref):
        raise SystemExit("Unsafe target ref.")
    if args.mode == "repair":
        if args.source not in ("dinilmusick/Luth", "dinilmusick/Aiko", "dinilmusick/Srkl-Engine", "dinilmusick/Frnes", "dinilmusick/Embr"):
            raise SystemExit("Repair target must be an allowlisted private repository.")
        if not re.fullmatch(r"[A-Za-z0-9_./-]{1,180}", args.branch) or ".." in args.branch:
            raise SystemExit("Repair requires a safe exact PR head branch.")

    if args.workflow and not re.fullmatch(r"[A-Za-z0-9_.-]+\.ya?ml", args.workflow):
        raise SystemExit("Unsafe workflow file.")

    bearer = token()
    clone_token = os.environ.get("PRIVATE_REPO_TOKEN")
    if not clone_token:
        raise SystemExit("Missing separate PRIVATE_REPO_TOKEN (read-only source access).")
    secret_writer = secrets_token()
    source = api(f"/repos/{args.source}", clone_token)
    if not re.fullmatch(r"[A-Za-z0-9_./-]+", source["default_branch"]):
        raise SystemExit("Unsafe source default branch.")
    target_ref = args.ref
    if not re.fullmatch(r"[0-9a-f]{40}", target_ref):
        raise SystemExit("Exact 40-character commit SHA is required for every private execution.")
    if not source.get("private", False):
        raise SystemExit("Source repository is not private; this tool is only for private-target CI.")

    created = api("/user/repos", bearer, "POST", {
        "name": target_name,
        "description": "Ephemeral FMRL public CI bridge, no source code.",
        "private": False,
        "auto_init": True,
    })
    target = created["full_name"]

    try:
        api(f"/repos/{target}/contents/.github/workflows/atax-private-ci.yml", bearer, "PUT", {
            "message": "chore: add ATAX private CI bridge",
            "content": base64.b64encode(WORKFLOW.encode()).decode(),
            "branch": "main",
        })

        if args.mode == "repair":
            writer = Path(__file__).with_name("fmrl_lock_writer.py").read_bytes()
            api(f"/repos/{target}/contents/tools/github/fmrl_lock_writer.py", bearer, "PUT", {
                "message": "chore: add static lockfile writeback helper",
                "content": base64.b64encode(writer).decode(),
                "branch": "main",
            })

        if shutil.which("gh") is None:
            raise SystemExit("GitHub CLI (gh) is required to configure the encrypted Actions secret.")

        env = os.environ.copy()
        # The gh subprocess needs only its secret-writer token; source access is passed via stdin.
        for credential in ("CODING_REPO_TOKEN", "PRIVATE_REPO_TOKEN", "FMRL_SECRETS_TOKEN", "GITHUB_TOKEN"):
            env.pop(credential, None)
        env["GH_TOKEN"] = secret_writer
        # Private repository name, exact SHA, and clone credential remain
        # encrypted runtime secrets, never public Git commit content.
        repair_secrets = (
            (("FMRL_TARGET_BRANCH", args.branch),
             ("FMRL_REPAIR_WRITE_TOKEN", bearer)) if args.mode == "repair" else ()
        )
        for secret_name, secret_value in (
            ("PRIVATE_REPO_TOKEN", clone_token),
            ("FMRL_TARGET_REPOSITORY", args.source),
            ("FMRL_TARGET_REF", target_ref),
            ("FMRL_TARGET_EVENT", args.event),
            ("FMRL_TARGET_WORKFLOW", args.workflow or "-"),
            ("FMRL_EXECUTION_MODE", args.mode),
        ) + repair_secrets:
          for attempt in range(4):
            try:
                subprocess.run(
                    ["gh", "secret", "set", secret_name, "--repo", target],
                    input=secret_value,
                    text=True,
                    env=env,
                    capture_output=True,
                    check=True,
                )
                break
            except subprocess.CalledProcessError as exc:
                # A newly provisioned repo may not yet expose its Actions
                # encryption public key. Surface the actual failure safely.
                diagnostic = (exc.stderr or "GitHub CLI returned a nonzero status")
                for private_value in (clone_token, bearer, secret_writer, args.source, target_ref, args.workflow):
                    if private_value:
                        diagnostic = diagnostic.replace(private_value, "[redacted]")
                if "Resource not accessible by personal access token" in diagnostic:
                    raise RuntimeError(
                        "FMRL requires FMRL_SECRETS_TOKEN with repository Secrets: write "
                        "access to newly created disposable repositories (GitHub HTTP 403). "
                        "Reauthorize its scope; never expose clone credentials in public workflow inputs."
                    ) from None
                if attempt == 3:
                    raise RuntimeError(
                        "Cannot install required encrypted FMRL binding after 4 attempts: " + diagnostic[:500]
                    ) from None
                time.sleep(3 * (attempt + 1))

        verified = api(f"/repos/{target}", bearer)
        if verified.get("private") is not False:
            raise SystemExit("Public workspace verification failed.")

        print(json.dumps({
            "source": args.source,
            "disposable_repository": target,
            "url": verified["html_url"],
            "public": True,
            "private_source_published": False,
            "private_target_metadata_published": False,
            "default_ref": source["default_branch"],
            "verified_target_ref": target_ref,
            "push_fallback_path": ".fmrl/execute",
            "workflow": "atax-private-ci.yml",
            "execution_mode": args.mode,
            "coverage": ("lockfile-only repair and frozen install" if args.mode == "repair" else
                         "portable scripts only; not full workflow parity" if args.mode == "direct" else "nested act"),
            "run": f"gh workflow run atax-private-ci.yml --repo {target}",
            "cleanup": f"python3 tools/github/repository_lifecycle.py delete --repository {target}",
        }, indent=2))
        return 0
    except Exception:
        try:
            api(f"/repos/{target}", bearer, "DELETE")
            verify_deleted_public_bridge(target)
        except Exception as cleanup_error:
            raise RuntimeError(
                f"FMRL provisioning failed and cleanup is unverified for {target}: {cleanup_error}"
            ) from None
        raise

if __name__ == "__main__":
    raise SystemExit(main())
