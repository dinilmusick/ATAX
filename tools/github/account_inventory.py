#!/usr/bin/env python3
"""Discover the authenticated GitHub account, organizations, and repositories.

Authentication is read only from GITHUB_TOKEN or GH_TOKEN.
No token is printed, persisted, or embedded in clone URLs.
"""
from __future__ import annotations

import argparse
import json
import os
from urllib import error, request

API_ROOT = "https://api.github.com"
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atax-github-account-inventory",
}


def token() -> str:
    value = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not value:
        raise SystemExit("Missing GITHUB_TOKEN or GH_TOKEN.")
    return value


def api(path: str, bearer: str):
    req = request.Request(
        API_ROOT + path,
        headers={**HEADERS, "Authorization": f"Bearer {bearer}"},
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API GET {path} failed: {detail}") from exc


def pages(path: str, bearer: str, per_page: int = 100):
    page = 1
    while True:
        separator = "&" if "?" in path else "?"
        values = api(f"{path}{separator}per_page={per_page}&page={page}", bearer)
        if not values:
            return
        yield from values
        if len(values) < per_page:
            return
        page += 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--org", help="Only list repositories in this organization.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    bearer = token()
    user = api("/user", bearer)

    if args.org:
        orgs = [args.org]
    else:
        orgs = [item["login"] for item in pages("/user/orgs", bearer)]

    result = {
        "account": {
            "login": user.get("login"),
            "id": user.get("id"),
            "name": user.get("name"),
        },
        "organizations": [],
    }

    for org in orgs:
        repos = []
        for repo in pages(f"/orgs/{org}/repos?type=all&sort=full_name", bearer):
            repos.append({
                "full_name": repo["full_name"],
                "private": repo["private"],
                "default_branch": repo.get("default_branch"),
                "archived": repo.get("archived", False),
                "clone_url": repo["clone_url"],
                "permissions": repo.get("permissions", {}),
            })
        result["organizations"].append({"login": org, "repositories": repos})

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
