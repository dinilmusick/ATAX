#!/usr/bin/env python3
"""Provision a disposable FMRL public bridge for private CI (ATAX is control-plane only).

The private source is never copied into the public repository. The bridge
contains only a workflow, stores a least-privilege token as an Actions secret,
clones the private target at runtime, executes its workflow with act, and
removes the checkout before the job ends.
"""
from __future__ import annotations
import argparse, base64, json, os, re, shutil, subprocess, time, uuid
from urllib import error, request

API_ROOT = "https://api.github.com"
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atax-disposable-github-workspace",
}

WORKFLOW = """name: Disposable FMRL Private CI

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
        default: "%%DEFAULT_REF%%"
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
      - name: Refuse any target other than the provisioned private repository
        env:
          REQUESTED_REPOSITORY: ${{ inputs.repository }}
        shell: bash
        run: test "$REQUESTED_REPOSITORY" = "%%TARGET_SOURCE%%"

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
          # GitHub Git-over-HTTPS uses username/token credentials, not a REST API Bearer header.
          # Credentials are supplied only to this checkout step, never stored in a remote URL.
          askpass="$(mktemp)"
          trap 'rm -f "$askpass"' EXIT
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
          git -c credential.helper= \
            clone --no-checkout "https://github.com/$TARGET_REPOSITORY.git" target
          git -C target -c credential.helper= \
            fetch --no-tags origin "$TARGET_REF"
          git -C target checkout --detach FETCH_HEAD

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
        shell: bash
        run: |
          set -euo pipefail
          cd target
          test -d .git
          # Nested act on GitHub-hosted runners must mount the checked-out private worktree.
          # This mount exists only inside the ephemeral runner; no source is committed to FMRL.
          args=("$TARGET_EVENT" "--bind" "--directory" "$PWD" "--platform" "ubuntu-latest=catthehacker/ubuntu:act-latest" "--platform" "ubuntu-24.04=catthehacker/ubuntu:act-latest")
          if [[ -n "$TARGET_WORKFLOW" ]]; then
            [[ "$TARGET_WORKFLOW" =~ ^[A-Za-z0-9_.-]+\.ya?ml$ ]] || exit 2
            test -f ".github/workflows/$TARGET_WORKFLOW"
            args+=("-W" ".github/workflows/$TARGET_WORKFLOW")
          fi
          act "${args[@]}"

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
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {path} failed: {detail}") from exc

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

    bearer = token()
    clone_token = os.environ.get("PRIVATE_REPO_TOKEN")
    if not clone_token:
        raise SystemExit("Missing separate PRIVATE_REPO_TOKEN (read-only source access).")
    secret_writer = secrets_token()
    source = api(f"/repos/{args.source}", clone_token)
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
            "content": base64.b64encode(WORKFLOW.replace("%%TARGET_SOURCE%%", args.source).replace("%%DEFAULT_REF%%", source["default_branch"]).encode()).decode(),
            "branch": "main",
        })

        if shutil.which("gh") is None:
            raise SystemExit("GitHub CLI (gh) is required to configure the encrypted Actions secret.")

        env = os.environ.copy()
        # The gh subprocess needs only its secret-writer token; source access is passed via stdin.
        for credential in ("CODING_REPO_TOKEN", "PRIVATE_REPO_TOKEN", "FMRL_SECRETS_TOKEN", "GITHUB_TOKEN"):
            env.pop(credential, None)
        env["GH_TOKEN"] = secret_writer
        for attempt in range(4):
            try:
                subprocess.run(
                    ["gh", "secret", "set", "PRIVATE_REPO_TOKEN", "--repo", target],
                    input=clone_token,
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
                diagnostic = diagnostic.replace(clone_token, "[redacted]").replace(bearer, "[redacted]").replace(secret_writer, "[redacted]")
                if "Resource not accessible by personal access token" in diagnostic:
                    raise RuntimeError(
                        "FMRL requires FMRL_SECRETS_TOKEN with repository Secrets: write "
                        "access to newly created disposable repositories (GitHub HTTP 403). "
                        "Reauthorize its scope; never expose clone credentials in public workflow inputs."
                    ) from None
                if attempt == 3:
                    raise RuntimeError(
                        "Cannot install clone-only secret on FMRL after 4 attempts: " + diagnostic[:500]
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
            "default_ref": source["default_branch"],
            "workflow": "atax-private-ci.yml",
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
