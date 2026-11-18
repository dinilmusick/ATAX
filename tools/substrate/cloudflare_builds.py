#!/usr/bin/env python3
"""Cloudflare Workers Builds signal ingestion into canonical ATAX system memories.

Set CLOUDFLARE_BUILD_ACCOUNTS_JSON only as a GitHub Actions secret:
[{"account_id":"...","api_token":"...","workers":[{"tag":"immutable-worker-tag",
"system_key":"aiko","repository":"owner/repo"}]}]
Never persist credentials or raw build logs. Logs may contain secrets.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from urllib.request import Request, urlopen
from urllib.parse import quote

from health_audit import Postgrest, utcnow

API_ROOT = "https://api.cloudflare.com/client/v4"
FAILURES = {"fail", "failure", "failed", "error", "cancelled", "canceled"}
CATEGORIES = (
    ("types", r"typescript|ts\d{4}|typecheck|tsc:"),
    ("lint", r"eslint|lint error|prettier"),
    ("dependencies", r"module not found|cannot find module|npm err|pnpm err|enoent"),
    ("authentication", r"unauthori[sz]ed|invalid token|permission denied|403 forbidden"),
    ("configuration", r"missing environment|not configured|env var|no database url"),
    ("bundle", r"build failed|esbuild|webpack|vite build|failed to compile"),
)

def cloudflare_get(account, path):
    req = Request(API_ROOT + "/accounts/" + quote(account["account_id"], safe="") + path,
                  headers={"Authorization": "Bearer " + account["api_token"],
                           "Accept": "application/json",
                           "User-Agent": "ATAX-Cloudflare-telemetry"})
    with urlopen(req, timeout=35) as response:
        body = json.load(response)
    if not body.get("success") or not isinstance(body.get("result"), (dict, list)):
        raise RuntimeError("Cloudflare API failed; refusing to infer healthy state")
    return body["result"]

def failure_category(build, logs=None):
    data = (json.dumps({"status": build.get("status"),
                        "build_outcome": build.get("build_outcome")}) +
            "\n" + (json.dumps(logs)[:120000] if logs else "")).lower()
    for name, pattern in CATEGORIES:
        if re.search(pattern, data):
            return name
    return "unknown"

def build_failed(build):
    outcome = str(build.get("build_outcome") or build.get("status") or "").lower()
    return outcome in FAILURES

def account_choices(candidates, minimum_minutes=20):
    """Recommend only accounts with VERIFIED usage and explicitly configured budgets.

    A sum over the 90-day Builds API retention window is not an authoritative
    monthly quota meter; never use such a sum to assert available capacity.
    """
    eligible = []
    for item in candidates:
        if item.get("usage_source") != "verified":
            continue
        budget, used = item.get("monthly_budget_minutes"), item.get("monthly_used_minutes")
        if not isinstance(budget, (int, float)) or not isinstance(used, (int, float)):
            continue
        if budget <= 0 or used < 0 or used > budget:
            continue
        reserve = max(minimum_minutes, budget * 0.10)
        available = budget - used - reserve
        if available >= minimum_minutes and item.get("concurrency_available") is True:
            eligible.append({"account_id": item["account_id"], "available_minutes": available})
    return sorted(eligible, key=lambda x: -x["available_minutes"])

def upsert_build_observation(db, account, worker, build, system_id, category):
    identifier = account["account_id"] + ":" + worker["tag"]
    key = "cloudflare-build-" + hashlib.sha256(identifier.encode()).hexdigest()[:20]
    failed = build_failed(build)
    meta = build.get("build_trigger_metadata") or {}
    payload = {
        "account_id": account["account_id"],
        "worker_tag": worker["tag"], "repository": worker.get("repository"),
        "build_uuid": build.get("build_uuid"), "branch": meta.get("branch"),
        "commit_sha": meta.get("commit_hash") or meta.get("commit_sha"),
        "status": build.get("status"), "build_outcome": build.get("build_outcome"),
        "category": category if failed else None, "failed": failed,
        "observed_at": utcnow().isoformat(),
    }
    row = {
        "system_id": system_id, "memory_key": key,
        "title": "Cloudflare build signal: " + worker.get("repository", worker["tag"]),
        "content": json.dumps(payload, sort_keys=True),
        "memory_type": "warning" if failed else "observation",
        "importance": 5 if failed else 2, "status": "active",
        "source_type": "cloudflare-workers-builds",
        "source_id": str(build.get("build_uuid") or "unknown"),
        "metadata": {"origin": "github-actions-cloudflare-poller",
                     "failed": failed, "category": category if failed else None,
                     "repository": worker.get("repository"), "commit_sha": payload["commit_sha"]},
    }
    db.request("system_memories", method="POST",
               params={"on_conflict": "system_id,memory_key"}, data=row,
               prefer="resolution=merge-duplicates,return=minimal")
    return payload

def main():
    accounts = json.loads(os.environ["CLOUDFLARE_BUILD_ACCOUNTS_JSON"])
    if not isinstance(accounts, list) or not accounts:
        raise ValueError("Cloudflare accounts must be a nonempty JSON array")
    db = Postgrest(os.environ["ATAX_SUPABASE_URL"],
                   os.environ["ATAX_SUPABASE_SERVICE_ROLE_KEY"])
    systems = {r["system_key"]: r["id"] for r in db.all("systems", "id,system_key")}
    observations = []
    for account in accounts:
        if not account.get("account_id") or not account.get("api_token"):
            raise ValueError("Account is missing ID or token")
        for worker in account.get("workers", []):
            if not worker.get("tag") or worker.get("system_key") not in systems:
                raise ValueError("Missing worker tag or unregistered target system")
            builds = cloudflare_get(account, "/builds/workers/" +
                                   quote(worker["tag"], safe="") + "/builds")
            if not isinstance(builds, list):
                raise RuntimeError("Unexpected Cloudflare builds response")
            if not builds:
                continue
            newest = max(builds, key=lambda b: b.get("created_on") or "")
            if not newest.get("build_uuid"):
                raise RuntimeError("Build is missing build_uuid")
            # Error taxonomy only: never store raw logs or headers in ATAX.
            logs = None
            if build_failed(newest):
                logs = cloudflare_get(account, "/builds/builds/" +
                                      quote(newest["build_uuid"], safe="") + "/logs")
            category = failure_category(newest, logs)
            observations.append(upsert_build_observation(
                db, account, worker, newest, systems[worker["system_key"]], category))
    print(json.dumps({"observed_builds": len(observations),
                      "failed": sum(o["failed"] for o in observations),
                      "events": observations}, indent=2))
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("Cloudflare telemetry failed: " + str(exc).splitlines()[0][:200],
              file=sys.stderr)
        sys.exit(1)
