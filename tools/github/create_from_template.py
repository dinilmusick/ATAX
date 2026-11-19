#!/usr/bin/env python3
"""Create a permanent repository from a GitHub template, with verification."""
import argparse
import json
import os
import re
import sys
import time
from urllib import request, error

def api(path, token, method="GET", payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = request.Request("https://api.github.com" + path, data=body, method=method,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "atax-template-generator"})
    try:
        with request.urlopen(req, timeout=30) as res:
            return json.load(res) if res.status != 204 else {}
    except error.HTTPError as exc:
        raise RuntimeError(f"GitHub {method} {path}: HTTP {exc.code}") from None

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--template", required=True, help="Existing owner/repo marked as template")
    p.add_argument("--owner", required=True, help="Destination owner")
    p.add_argument("--name", required=True, help="New repository name")
    p.add_argument("--visibility", choices=["private"], default="private", help="Meditation repositories are always private")
    p.add_argument("--description", default="")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    valid = r"[A-Za-z0-9_.-]+"
    if not re.fullmatch(valid + "/" + valid, a.template) or not all(
        re.fullmatch(valid, v) for v in (a.owner, a.name)):
        p.error("Invalid repository identifier")
    payload = {"owner": a.owner, "name": a.name,
               "private": True, "include_all_branches": False}
    if a.description:
        payload["description"] = a.description
    endpoint = f"/repos/{a.template}/generate"
    if a.dry_run:
        print(json.dumps({"method": "POST", "endpoint": endpoint, "payload": payload}))
        return
    token = os.environ.get("CODING_REPO_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("Missing CODING_REPO_TOKEN or GH_TOKEN")
    source = api(f"/repos/{a.template}", token)
    if source.get("is_template") is not True:
        raise SystemExit("Source is not configured as a GitHub template")
    target_path = f"/repos/{a.owner}/{a.name}"
    try:
        api(target_path, token)
    except RuntimeError as exc:
        if "HTTP 404" not in str(exc):
            raise
    else:
        raise SystemExit("Destination already exists; refusing to overwrite")
    created = api(endpoint, token, "POST", payload)
    if created.get("full_name", "").lower() != f"{a.owner}/{a.name}".lower():
        raise SystemExit("Unexpected generated repository identity")
    if created.get("private") is not True:
        raise SystemExit("SECURITY: generated repository is not private; inspect and restrict immediately")
    for attempt in range(20):
        try:
            target = api(target_path, token)
            if target.get("private") is not True:
                raise SystemExit("SECURITY: destination repository is not private")
            if target.get("default_branch") and not target.get("empty", False):
                branch = api(target_path + "/branches/" + target["default_branch"], token)
                if branch.get("commit", {}).get("sha"):
                    print(json.dumps({"repository": target["full_name"],
                                      "url": target["html_url"],
                                      "commit": branch["commit"]["sha"],
                                      "template": a.template}))
                    return
        except RuntimeError as exc:
            if "HTTP 404" not in str(exc):
                raise
        time.sleep(3)
    raise SystemExit("Repository created but branch not ready; inspect manually (not deleted)")

if __name__ == "__main__":
    main()
