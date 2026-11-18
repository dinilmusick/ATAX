#!/usr/bin/env python3
"""Idempotent GitHub reconciliation of canonical ATAX repo/PR/check projections.

Runs on trusted GitHub Actions main only, using a read-only GitHub token.
Not an agent runner. It never clones repositories or mutates source.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

from health_audit import Postgrest, utcnow

API = "https://api.github.com"
MAX_PAGES = 5

def gh_get(token, path):
    req = Request(API + path, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ATAX-GitHub-reconciler"})
    with urlopen(req, timeout=40) as response:
        return json.load(response)

def paged(token, path, field=None):
    values = []
    for page in range(1, MAX_PAGES + 1):
        sep = "&" if "?" in path else "?"
        result = gh_get(token, path + sep + "per_page=100&page=" + str(page))
        batch = result[field] if field else result
        if not isinstance(batch, list):
            raise RuntimeError("Unexpected GitHub list response")
        values.extend(batch)
        if len(batch) < 100:
            return values
    raise RuntimeError("GitHub pagination safety cap exceeded; no healthy projection")

def normalise_check(check, system_id, sha, branch, now):
    if not isinstance(check.get("id"), int):
        raise ValueError("GitHub check missing integer ID")
    return {
        "system_id": system_id, "github_id": check["id"],
        "name": check.get("name"), "workflow_name": (check.get("app") or {}).get("name"),
        "status": check.get("status"), "conclusion": check.get("conclusion"),
        "sha": sha, "branch": branch,
        "url": check.get("html_url") or check.get("details_url"),
        "started_at": check.get("started_at"), "completed_at": check.get("completed_at"),
        "source_updated_at": check.get("completed_at") or check.get("started_at"),
        "synced_at": now,
        "raw": {"external_id": check.get("external_id"),
                "output": {"title": (check.get("output") or {}).get("title")},
                "pull_requests": [x.get("number") for x in check.get("pull_requests", [])]},
    }

def normalise_pr(pr, system_id, now):
    if not isinstance(pr.get("id"), int) or not isinstance(pr.get("number"), int):
        raise ValueError("GitHub PR missing integer id/number")
    head, base = pr.get("head") or {}, pr.get("base") or {}
    return {
        "system_id": system_id, "github_id": pr["id"],
        "item_type": "pull_request", "number": pr["number"],
        "state": pr.get("state") or "unknown", "title": pr.get("title"),
        "url": pr.get("html_url"), "author_login": (pr.get("user") or {}).get("login"),
        "draft": pr.get("draft"), "locked": pr.get("locked"),
        "merged": pr.get("merged"), "mergeable": str(pr["mergeable"]).lower()
        if pr.get("mergeable") is not None else None,
        "head_sha": head.get("sha"), "base_sha": base.get("sha"),
        "head_branch": head.get("ref"), "base_branch": base.get("ref"),
        "labels": [x.get("name") for x in pr.get("labels", [])],
        "assignees": [x.get("login") for x in pr.get("assignees", [])],
        "reviewers": [x.get("login") for x in pr.get("requested_reviewers", [])],
        "source_updated_at": pr.get("updated_at"), "closed_at": pr.get("closed_at"),
        "merged_at": pr.get("merged_at"), "synced_at": now,
        "raw": {"body_present": bool(pr.get("body")),
                "draft": pr.get("draft"), "diff_url": pr.get("diff_url")},
    }

def upsert(db, table, records, conflicts):
    for row in records:
        db.request(table, method="POST", params={"on_conflict": conflicts},
                   data=row, prefer="resolution=merge-duplicates,return=minimal")

def valid_repo(name):
    return bool(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name))

def reconcile(db, token, mapping):
    name, system_id, branch = mapping["repository_full_name"], mapping["system_id"], mapping["default_branch"]
    if not valid_repo(name) or not re.fullmatch(r"[A-Za-z0-9_./-]+", branch):
        raise ValueError("Invalid canonical repository mapping")
    repo = quote(name, safe="/")
    # All reads must succeed *before* the repository is marked healthy.
    ref = gh_get(token, "/repos/" + repo + "/branches/" + quote(branch, safe=""))
    sha = (ref.get("commit") or {}).get("sha")
    if not sha or not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
        raise RuntimeError("GitHub returned no canonical branch SHA")
    checks = paged(token, "/repos/" + repo + "/commits/" + sha + "/check-runs", "check_runs")
    prs = paged(token, "/repos/" + repo + "/pulls?state=open")
    # An open-only PR poll cannot tell whether an old open PR was merged or
    # closed. Resolve previously open entries that disappeared before syncing.
    previously_open = db.request("github_work_items", params={
        "select": "github_id,number,state", "system_id": "eq." + system_id,
        "item_type": "eq.pull_request", "state": "eq.open"})
    seen = {p.get("id") for p in prs}
    for prior in previously_open:
        if prior.get("github_id") not in seen:
            prs.append(gh_get(token, "/repos/" + repo + "/pulls/" + str(prior["number"])))
    now = utcnow().isoformat()
    checks = [normalise_check(x, system_id, sha, branch, now) for x in checks]
    prs = [normalise_pr(x, system_id, now) for x in prs]
    upsert(db, "github_check_runs", checks, "system_id,github_id")
    upsert(db, "github_work_items", prs, "system_id,item_type,github_id")
    digest = hashlib.sha256((name + ":" + sha).encode()).hexdigest()[:32]
    event = {
        "system_id": system_id, "delivery_id": "reconcile-" + digest,
        "event_name": "reconciliation", "action": "snapshot",
        "repository_full_name": name,
        "received_at": now, "processed_at": now, "status": "processed",
        "payload": {"sha": sha, "branch": branch,
                    "check_count": len(checks), "open_pr_count": len(prs),
                    "source": "authenticated_github_rest", "verified_at": now},
    }
    upsert(db, "github_sync_events", [event], "delivery_id")
    db.request("system_github_repositories", method="PATCH",
               params={"system_id": "eq." + system_id},
               data={"sync_status": "healthy", "last_reconciled_at": now,
                     "last_successful_sync_at": now, "last_observed_remote_at": now,
                     "last_observed_default_branch_sha": sha, "sync_error": None,
                     "updated_at": now},
               prefer="return=minimal")
    return {"repo": name, "sha": sha, "checks": len(checks), "open_prs": len(prs)}

def main():
    token = os.environ["GITHUB_SYNC_TOKEN"]
    if not token:
        raise RuntimeError("Read-only GitHub token required")
    db = Postgrest(os.environ["ATAX_SUPABASE_URL"],
                   os.environ["ATAX_SUPABASE_SERVICE_ROLE_KEY"])
    mappings = db.all("system_github_repositories",
                      "system_id,repository_full_name,default_branch")
    ok, errors = [], []
    for row in mappings:
        try:
            ok.append(reconcile(db, token, row))
        except Exception as exc:
            message = str(exc).splitlines()[0][:180]
            errors.append({"repo": row["repository_full_name"], "reason": message})
            # UNKNOWN/ERROR, never report a prior green snapshot as current.
            try:
                db.request("system_github_repositories", method="PATCH",
                           params={"system_id": "eq." + row["system_id"]},
                           data={"sync_status": "error", "sync_error": message,
                                 "last_reconciled_at": utcnow().isoformat()},
                           prefer="return=minimal")
            except Exception:
                pass
    print(json.dumps({"successful": len(ok), "failed": len(errors),
                      "repositories": ok, "errors": errors}, indent=2))
    return 1 if errors else 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("GitHub reconciliation failed: " + str(exc).splitlines()[0][:200],
              file=sys.stderr)
        sys.exit(1)
