#!/usr/bin/env python3
"""ATAX FMRL: commit only a regenerated lockfile to its exact private PR head.

This script runs only after a static no-scripts lock generation step.
The write credential is scoped to this one trusted step, never to npm/pnpm.
"""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib import error, parse, request

ALLOWED = {
    "dinilmusick/Luth": "pnpm-lock.yaml",
    "dinilmusick/Aiko": "package-lock.json",
    "dinilmusick/Srkl-Engine": "package-lock.json",
}
ROOT = Path("target")
API = "https://api.github.com"


def fail(reason: str) -> None:
    raise RuntimeError(reason)


def api(path: str, token: str, method: str = "GET", payload=None, stage: str = "unspecified"):
    body = json.dumps(payload).encode() if payload is not None else None
    url = API + path
    req = request.Request(url, data=body, method=method, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "atax-fmrl-lockfile-writer",
    })
    try:
        with request.urlopen(req, timeout=30) as response:
            return json.load(response) if response.status != 204 else None
    except error.HTTPError as exc:
        raise RuntimeError("GitHub gate " + stage + " failed: HTTP " + str(exc.code)) from None


def main() -> None:
    repo = os.environ.get("FMRL_TARGET_REPOSITORY", "")
    branch = os.environ.get("FMRL_TARGET_BRANCH", "")
    expected = os.environ.get("FMRL_TARGET_REF", "")
    token = os.environ.get("FMRL_REPAIR_WRITE_TOKEN", "")
    if repo not in ALLOWED:
        fail("Repository is outside the reviewed lockfile repair allowlist")
    if not re.fullmatch(r"[a-zA-Z0-9_./-]{1,180}", branch) or ".." in branch or branch.startswith("/"):
        fail("Unsafe branch reference")
    if not re.fullmatch(r"[a-f0-9]{40}", expected) or not token:
        fail("Missing exact SHA or independent write authority")
    path = ALLOWED[repo]
    target = ROOT / path
    if target.is_symlink() or not target.is_file() or target.stat().st_size > 3_000_000:
        fail("Lockfile missing, symbolic, or exceeds bounded size")
    head = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    if head != expected:
        fail("Private checkout does not match approved PR head")
    changed = subprocess.check_output(
        ["git", "-C", str(ROOT), "diff", "--name-only", "HEAD", "--"],
        text=True,
    ).splitlines()
    if any(item != path for item in changed):
        fail("Lockfile repair mutated a non-allowlisted source file")
    branch_path = "/repos/" + repo + "/git/ref/heads/" + parse.quote(branch, safe="/")
    old_ref = api(branch_path, token, stage="private-branch-preflight")
    if old_ref["object"]["sha"] != expected:
        fail("Private PR head advanced: refuse stale update")
    if not changed:
        print("FMRL lockfile repair: no content change; exact branch verified")
        return

    contents = target.read_bytes()
    local_digest = hashlib.sha256(contents).hexdigest()
    fileblob = api("/repos/" + repo + "/git/blobs", token, "POST", {
        "content": base64.b64encode(contents).decode("ascii"),
        "encoding": "base64",
    }, stage="create-lock-blob")["sha"]
    base_commit = api("/repos/" + repo + "/git/commits/" + expected, token, stage="base-commit-read")
    base_tree = base_commit["tree"]["sha"]
    new_tree = api("/repos/" + repo + "/git/trees", token, "POST", {
        "base_tree": base_tree,
        "tree": [{"path": path, "mode": "100644", "type": "blob", "sha": fileblob}],
    }, stage="create-lock-tree")["sha"]
    new_commit = api("/repos/" + repo + "/git/commits", token, "POST", {
        "message": "fix(auth): regenerate frozen dependency lockfile via isolated ATAX FMRL",
        "tree": new_tree,
        "parents": [expected],
    }, stage="create-lock-commit")["sha"]
    # Non-forced atomic fast-forward: fail instead of overwriting a concurrent PR update.
    api(branch_path.replace("/git/ref/", "/git/refs/"), token, "PATCH", {"sha": new_commit, "force": False}, stage="atomic-branch-update")
    updated = api(branch_path, token, stage="branch-readback")
    if updated["object"]["sha"] != new_commit:
        fail("Independent branch readback differs from committed SHA")
    published_blob = api("/repos/" + repo + "/git/blobs/" + fileblob, token, stage="blob-readback")
    if published_blob.get("encoding") != "base64":
        fail("Independent blob readback encoding invalid")
    if hashlib.sha256(base64.b64decode(published_blob["content"])).hexdigest() != local_digest:
        fail("Independent lockfile readback digest mismatch")
    print("FMRL lockfile repair: atomic private PR commit and content digest verified")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # No private names, branch, SHA, paths or API payloads in public logs.
        print("FMRL lockfile repair blocked: " + str(exc), file=sys.stderr)
        sys.exit(1)
