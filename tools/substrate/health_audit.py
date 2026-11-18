#!/usr/bin/env python3
"""Read-only ledger diagnosis plus optional idempotent ATAX observation publication.

This is control-plane monitoring, not an agent or a task scheduler. It never
claims, finalizes, or changes task/goal state.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

TABLE_FIELDS = {
    "tasks": "id,status,goal_id,system_id,goal_context_version,verification_status,claim_token,claim_expires_at",
    "goals": "id,status,system_id,context_version",
    "system_github_repositories": "system_id,repository_full_name,sync_status,last_successful_sync_at",
    "system_constraints": "id",
    "agent_registry": "agent_id",
    "github_check_runs": "id",
    "github_sync_events": "id",
}

def utcnow():
    return datetime.now(timezone.utc)

class Postgrest:
    def __init__(self, url, key):
        if not url.startswith("https://") or not key:
            raise ValueError("Requires an HTTPS Supabase URL and server-side key")
        self.base = url.rstrip("/") + "/rest/v1"
        self.key = key

    def request(self, table, method="GET", params=None, data=None, prefer=None):
        path = self.base + "/" + table
        if params:
            path += "?" + urlencode(params)
        payload = None if data is None else json.dumps(data).encode("utf-8")
        headers = {"apikey": self.key, "Authorization": "Bearer " + self.key,
                   "Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer
        req = Request(path, data=payload, headers=headers, method=method)
        with urlopen(req, timeout=35) as response:
            body = response.read()
            return json.loads(body) if body else None

    def all(self, table, fields="*"):
        rows = []
        offset = 0
        while True:
            page = self.request(table, params={"select": fields, "limit": 500, "offset": offset})
            if not isinstance(page, list):
                raise RuntimeError("Unexpected PostgREST data for " + table)
            rows.extend(page)
            if len(page) < 500:
                return rows
            offset += len(page)
            if offset > 200000:
                raise RuntimeError("Safety cap exceeded while reading " + table)

def parse_instant(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

def analyse(data, now=None):
    """Return bounded, deterministic findings; never auto-repair ambiguous links."""
    now = now or utcnow()
    tasks = data["tasks"]
    goals = {g["id"]: g for g in data["goals"]}
    repos = data["system_github_repositories"]

    conditions = {
        "task_without_goal": [t["id"] for t in tasks if not t.get("goal_id")],
        "task_without_effective_system": [
            t["id"] for t in tasks if not (t.get("system_id") or (goals.get(t.get("goal_id")) or {}).get("system_id"))
        ],
        "goal_without_system": [g["id"] for g in goals.values() if not g.get("system_id")],
        "stale_goal_context": [
            t["id"] for t in tasks if t.get("goal_id") in goals
            and t.get("status") not in ("completed", "cancelled")
            and t.get("goal_context_version") != goals[t["goal_id"]].get("context_version")
        ],
        "completed_without_verification": [
            t["id"] for t in tasks if t.get("status") == "completed"
            and t.get("verification_status") != "verified"
        ],
        "running_without_claim": [
            t["id"] for t in tasks if t.get("status") == "running" and not t.get("claim_token")
        ],
        "running_with_expired_claim": [
            t["id"] for t in tasks if t.get("status") == "running"
            and t.get("claim_expires_at")
            and parse_instant(t["claim_expires_at"]) < now
        ],
        "github_not_synchronised": [
            r["repository_full_name"] for r in repos if not r.get("last_successful_sync_at")
        ],
        "missing_system_constraints": (["no system constraints"] if not data["system_constraints"] else []),
        "missing_github_check_projection": (["no GitHub check observations"] if not data["github_check_runs"] else []),
        "missing_github_event_projection": (["no GitHub sync observations"] if not data["github_sync_events"] else []),
    }
    # Do not infer an empty registry means no agents exist: transient agents are external.
    return [
        {"rule": k, "count": len(v), "samples": v[:20],
         "severity": ("critical" if k in ("completed_without_verification", "running_without_claim") else "warning")}
        for k, v in conditions.items() if v
    ]

def observation_key(rule):
    return "substrate-health-" + hashlib.sha256(rule.encode()).hexdigest()[:18]

def publish(db, system_id, findings, observed_at):
    """Upsert active findings, supersede only previously-published resolved findings."""
    for finding in findings:
        key = observation_key(finding["rule"])
        body = {"system_id": system_id, "memory_key": key,
                "title": "ATAX ledger check: " + finding["rule"],
                "content": json.dumps({"observed_at": observed_at, **finding}, sort_keys=True),
                "memory_type": "warning", "importance": 5 if finding["severity"] == "critical" else 4,
                "status": "active", "source_type": "github-actions-control-plane",
                "source_id": os.getenv("GITHUB_RUN_ID", "manual"),
                "metadata": {"origin": "substrate-health-audit", "rule": finding["rule"],
                             "severity": finding["severity"], "count": finding["count"]}}
        db.request("system_memories", method="POST",
                   params={"on_conflict": "system_id,memory_key"}, data=body,
                   prefer="resolution=merge-duplicates,return=minimal")
    known = {observation_key(f["rule"]) for f in findings}
    existing = db.request("system_memories", params={
        "select": "id,memory_key,status", "system_id": "eq." + system_id,
        "memory_key": "like.substrate-health-*"})
    for row in existing:
        if row["memory_key"] not in known and row["status"] == "active":
            db.request("system_memories", method="PATCH", params={"id": "eq." + row["id"]},
                       data={"status": "superseded"}, prefer="return=minimal")

def main():
    db = Postgrest(os.environ["ATAX_SUPABASE_URL"], os.environ["ATAX_SUPABASE_SERVICE_ROLE_KEY"])
    data = {name: db.all(name, fields) for name, fields in TABLE_FIELDS.items()}
    now = utcnow().isoformat()
    result = analyse(data)
    print(json.dumps({"checked_at": now, "findings": result}, indent=2))
    if os.getenv("ATAX_PUBLISH_OBSERVATIONS") == "true":
        system = db.request("systems", params={"select": "id", "system_key": "eq.atax", "limit": 1})
        if len(system) != 1:
            raise RuntimeError("ATAX system missing; refusing to publish observations")
        publish(db, system[0]["id"], result, now)
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("ATAX health audit failed: " + str(exc).splitlines()[0][:250], file=sys.stderr)
        sys.exit(1)
