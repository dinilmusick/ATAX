#!/usr/bin/env python3
"""Create a disposable public repository from an authorized private repository.

This intentionally publishes the selected source repository's contents into a
new public repository. Use only for repositories whose contents are authorized
to become public for the duration of the disposable workspace.

The source is never modified. The disposable repository is created under the
authenticated user account and can be deleted with repository_lifecycle.py.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib import error, request

API_ROOT = "https://api.github.com"
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atax-disposable-github-workspace",
}


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
        headers={
            **HEADERS,
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            if response.status == 204:
                return None
            return json.load(response)
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {path} failed: {detail}") from exc


def run_git(args, cwd=None, env=None):
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Private source owner/name.")
    parser.add_argument("--target", required=True, help="New public repository name.")
    parser.add_argument("--source-ref", default="main")
    parser.add_argument("--description", default="Disposable ATAX development workspace.")
    parser.add_argument("--no-cleanup", action="store_true")
    args = parser.parse_args()

    if "/" not in args.source or args.source.count("/") != 1:
        raise SystemExit("--source must be owner/name.")
    if not args.target or "/" in args.target:
        raise SystemExit("--target must be a repository name.")

    bearer = token()

    # Verify source access before creating anything.
    source = api(f"/repos/{args.source}", bearer)
    if not source.get("private", False):
        raise SystemExit("Source repository is not private; use an explicit public workflow instead.")
    source_branch = args.source_ref
    if not source_branch:
        source_branch = source.get("default_branch") or "main"

    # Create an empty public repository under the authenticated account.
    created = api(
        "/user/repos",
        bearer,
        "POST",
        {
            "name": args.target,
            "description": args.description,
            "private": False,
            "auto_init": False,
        },
    )
    target = created["full_name"]

    temp = Path(tempfile.mkdtemp(prefix="atax-disposable-"))
    try:
        # Use an authenticated HTTP header instead of embedding the token in a URL.
        git_env = os.environ.copy()
        git_env["GIT_CONFIG_COUNT"] = "1"
        git_env["GIT_CONFIG_KEY_0"] = "http.extraheader"
        git_env["GIT_CONFIG_VALUE_0"] = (
            "AUTHORIZATION: basic "
            + subprocess.check_output(
                ["python3", "-c",
                 "import base64,sys; print(base64.b64encode(('x-access-token:'+sys.argv[1]).encode()).decode())",
                 bearer],
                text=True,
            ).strip()
        )

        run_git(
            ["clone", "--origin", "source", "--branch", source_branch,
             "--single-branch", source["clone_url"], str(temp / "workspace")],
            env=git_env,
        )
        worktree = temp / "workspace"
        shutil.rmtree(worktree / ".git")

        run_git(["init", "-b", "main"], cwd=worktree)
        run_git(["config", "user.name", "ATAX Disposable Workspace"], cwd=worktree)
        run_git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], cwd=worktree)
        run_git(["remote", "add", "origin", created["clone_url"]], cwd=worktree)

        # Reapply authentication only for the push operation.
        push_env = os.environ.copy()
        push_env["GIT_CONFIG_COUNT"] = "1"
        push_env["GIT_CONFIG_KEY_0"] = "http.extraheader"
        push_env["GIT_CONFIG_VALUE_0"] = git_env["GIT_CONFIG_VALUE_0"]

        run_git(["add", "-A"], cwd=worktree)
        run_git(["commit", "-m", f"chore: disposable workspace from {args.source}"], cwd=worktree)
        run_git(["push", "-u", "origin", "main"], cwd=worktree, env=push_env)

        print(json.dumps({
            "source": args.source,
            "source_ref": source_branch,
            "disposable_repository": target,
            "url": created["html_url"],
            "public": True,
            "source_unchanged": True,
            "cleanup": "delete with tools/github/repository_lifecycle.py delete --repository " + target,
        }, indent=2))
        return 0
    except Exception:
        if not args.no_cleanup:
            try:
                api(f"/repos/{target}", bearer, "DELETE")
            except Exception:
                pass
        raise
    finally:
        shutil.rmtree(temp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
