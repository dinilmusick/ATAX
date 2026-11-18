#!/usr/bin/env python3
"""Offline, credential-free control-plane tests. Safe on ATAX own GitHub Actions."""
import sys
import unittest
from datetime import datetime, timezone

from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from health_audit import analyse, observation_key
from cloudflare_builds import account_choices, build_failed, failure_category

NOW = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)

class AuditTests(unittest.TestCase):
    def sample(self):
        return {
            "goals": [{"id": "g1", "status": "active", "system_id": "s1", "context_version": 4}],
            "tasks": [
                {"id": "t1", "status": "running", "goal_id": "g1", "system_id": None,
                 "goal_context_version": 3, "verification_status": "pending",
                 "claim_token": None, "claim_expires_at": "2026-11-18T11:00:00+00:00"},
                {"id": "t2", "status": "completed", "goal_id": "g1", "system_id": None,
                 "goal_context_version": 3, "verification_status": "not_started"}
            ],
            "system_github_repositories": [
                {"repository_full_name": "test/repo", "last_successful_sync_at": None}
            ],
            "system_constraints": [], "agent_registry": [],
            "github_check_runs": [], "github_sync_events": []
        }

    def test_report_detects_material_inconsistency(self):
        findings = {x["rule"]: x for x in analyse(self.sample(), NOW)}
        self.assertEqual(findings["stale_goal_context"]["count"], 1)
        self.assertEqual(findings["completed_without_verification"]["samples"], ["t2"])
        self.assertEqual(findings["running_without_claim"]["samples"], ["t1"])
        self.assertEqual(findings["running_with_expired_claim"]["count"], 1)
        self.assertEqual(findings["github_not_synchronised"]["count"], 1)
        self.assertEqual(findings["missing_system_constraints"]["count"], 1)
        self.assertNotIn("task_without_effective_system", findings)

    def test_empty_healthy_snapshot_not_marked_unhealthy(self):
        snapshot = self.sample()
        snapshot["tasks"] = []
        snapshot["system_github_repositories"] = []
        snapshot["system_constraints"] = [{"id": "c1"}]
        snapshot["github_check_runs"] = [{"id": "r1"}]
        snapshot["github_sync_events"] = [{"id": "e1"}]
        self.assertEqual(analyse(snapshot, NOW), [])

    def test_bad_datetime_is_not_silently_treated_as_valid(self):
        snapshot = self.sample()
        snapshot["tasks"][0]["claim_expires_at"] = "bad"
        with self.assertRaises(ValueError):
            analyse(snapshot, NOW)

    def test_finding_key_deterministic(self):
        self.assertEqual(observation_key("x"), observation_key("x"))
        self.assertNotEqual(observation_key("x"), observation_key("y"))

class CloudflareTests(unittest.TestCase):
    def test_account_selection_requires_verified_meter(self):
        items = [
            {"account_id": "a", "usage_source": "estimate",
             "monthly_budget_minutes": 3000, "monthly_used_minutes": 0,
             "concurrency_available": True},
            {"account_id": "b", "usage_source": "verified",
             "monthly_budget_minutes": 3000, "monthly_used_minutes": 500,
             "concurrency_available": True},
            {"account_id": "c", "usage_source": "verified",
             "monthly_budget_minutes": 3000, "monthly_used_minutes": 2999,
             "concurrency_available": True},
        ]
        self.assertEqual([x["account_id"] for x in account_choices(items)], ["b"])

    def test_unknown_usage_must_not_trigger_rotation(self):
        self.assertEqual(account_choices([{"account_id": "unknown",
            "monthly_budget_minutes": 3000, "monthly_used_minutes": 0,
            "concurrency_available": True}]), [])

    def test_failure_taxonomy(self):
        self.assertTrue(build_failed({"build_outcome": "failure"}))
        self.assertFalse(build_failed({"build_outcome": "success"}))
        self.assertEqual(failure_category({"status": "failed"}, "TS2304: cannot find name"),
                         "types")
        self.assertEqual(failure_category({"status": "failed"}, "ENOENT file"), "dependencies")

if __name__ == "__main__":
    unittest.main()
