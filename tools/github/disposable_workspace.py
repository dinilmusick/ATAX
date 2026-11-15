#!/usr/bin/env python3
"""Provision an ephemeral public ATAX CI bridge for a private repository.

The private source is never copied into the public repository. The bridge
contains only a workflow, stores a least-privilege token as an Actions secret,
clones the private target at runtime, executes its workflow with act, and
removes the checkout before the job ends.
"""
from __future__ import annotations
import argparse, base64, json, os, shutil, subprocess
from urllib import error, request

API_ROOT = "https://api.github.com"
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atax-disposable-github-workspace",
}

WORKFLOW = """name: ATAX Private CI Bridge

on:
  workflow_dispatch:
    inputs:
      repository:
        description: Private repository owner/name
        required: true
        type: string
      ref:
        description: Branch, tag, or SHA
        required: false
        default: main
        type: string
      event:
        description: act event
        required: false
        default: push
        type: string
      workflow:
        description: Optional workflow filename
        required: false
        default: ""
        type: string

permissions:
  contents: read

jobs:
  private-ci:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - name: Clone private target at runtime
        env:
          PRIVATE_REPO_TOKEN: ${{ secrets.PRIVATE_REPO_TOKEN }}
          TARGET_REPOSITORY: ${{ inputs.repository }}
          TARGET_REF: ${{ inputs.ref }}
        shell: bash
        run: |
          set -euo pipefail
          test -n "$PRIVATE_REPO_TOKEN"
          rm -rf target
          git -c http.extraheader="AUTHORIZATION: bearer $PRIVATE_REPO_TOKEN" \
            clone --depth 1 --branch "$TARGET_REF" "https://github.com/$TARGET_REPOSITORY.git" target

      - name: Install pinned act
        shell: bash
        run: |
          set -euo pipefail
          curl -fsSL --retry 6 --retry-delay 4 --retry-all-errors --connect-timeout 20 --max-time 180 \
            https://github.com/nektos/act/releases/download/v0.2.89/act_Linux_x86_64.tar.gz -o /tmp/act.tar.gz
          echo "0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0  /tmp/act.tar.gz" | sha256sum -c -
          tar -xzf /tmp/act.tar.gz -C /tmp act
          sudo install -m 0755 /tmp/act /usr/local/bin/act

      - name: Execute target workflow
        env:
          TARGET_EVENT: ${{ inputs.event }}
          TARGET_WORKFLOW: ${{ inputs.workflow }}
          PRIVATE_REPO_TOKEN: ${{ secrets.PRIVATE_REPO_TOKEN }}
        shell: bash
        run: |
          set -euo pipefail
          cd target
          args=("$TARGET_EVENT" "--platform" "ubuntu-24.04=catthehacker/ubuntu:act-latest" "--artifact-server-path" "/tmp/atax-artifacts" "--secret" "GITHUB_TOKEN=$PRIVATE_REPO_TOKEN")
          if [[ -n "$TARGET_WORKFLOW" ]]; then
            args+=("-W" ".github/workflows/$TARGET_WORKFLOW")
          fi
          act "${args[@]}"

      - name: Remove private checkout
        if: always()
        run: rm -rf target
"""

def token() -> str:
    value = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not value:
        raise SystemExit("Missing GITHUB_TOKEN or GH_TOKEN.")
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
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {path} failed: {detail}") from exc

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Private source owner/name.")
    parser.add_argument("--target", required=True, help="New public repository name.")
    args = parser.parse_args()

    if args.source.count("/") != 1 or any(not p for p in args.source.split("/")):
        raise SystemExit("--source must be owner/name.")
    if not args.target or "/" in args.target:
        raise SystemExit("--target must be a repository name.")

    bearer = token()
    source = api(f"/repos/{args.source}", bearer)
    if not source.get("private", False):
        raise SystemExit("Source repository is not private; this tool is only for private-target CI.")

    created = api("/user/repos", bearer, "POST", {
        "name": args.target,
        "description": "Ephemeral ATAX public CI compute bridge.",
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

        if shutil.which("gh") is None:
            raise SystemExit("GitHub CLI (gh) is required to configure the encrypted Actions secret.")

        env = os.environ.copy()
        env["GH_TOKEN"] = bearer
        subprocess.run(
            ["gh", "secret", "set", "PRIVATE_REPO_TOKEN", "--repo", target, "--body", bearer],
            env=env,
            check=True,
        )

        verified = api(f"/repos/{target}", bearer)
        if verified.get("private") is not False:
            raise SystemExit("Public workspace verification failed.")

        print(json.dumps({
            "source": args.source,
            "disposable_repository": target,
            "url": verified["html_url"],
            "public": True,
            "private_source_published": False,
            "workflow": "atax-private-ci.yml",
            "run": f"gh workflow run atax-private-ci.yml --repo {target}",
            "cleanup": f"python3 tools/github/repository_lifecycle.py delete --repository {target}",
        }, indent=2))
        return 0
    except Exception:
        try:
            api(f"/repos/{target}", bearer, "DELETE")
        except Exception:
            pass
        raise

if __name__ == "__main__":
    raise SystemExit(main())
