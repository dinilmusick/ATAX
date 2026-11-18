"""Offline contract tests for GitHub source-of-truth projection."""
import unittest
from unittest import mock

import github_sync as sync

SHA = "a" * 40

def pr(gh_id, number, state="open"):
    return {"id": gh_id, "number": number, "state": state,
            "title": "PR", "html_url": "https://github.com/x/y/pull/" + str(number),
            "head": {"sha": SHA, "ref": "feature"},
            "base": {"sha": "b"*40, "ref": "main"},
            "labels": [], "assignees": [], "requested_reviewers": []}

class FakeDb:
    def __init__(self):
        self.writes = []
    def request(self, table, method="GET", params=None, data=None, prefer=None):
        self.writes.append((table,method,data))
        if method == "GET":
            if table == "github_work_items":
                return [{"github_id": 90, "number": 3, "state": "open"}]
            return []
        return None

class ReconciliationTests(unittest.TestCase):
    def test_rejects_fabricated_git_check_ids(self):
        with self.assertRaises(ValueError):
            sync.normalise_check({"id": "not-an-int"}, "s", SHA, "main", "2026-11-18T00:00:00Z")

    def test_verified_branch_and_closed_pr_resolved(self):
        db = FakeDb()
        with mock.patch.object(sync, "gh_get") as gh, mock.patch.object(sync, "paged") as pages:
            gh.side_effect = lambda token,path: (
                {"commit":{"sha":SHA}} if "/branches/" in path else pr(90,3,"closed"))
            pages.side_effect = [
                [{"id":11,"name":"build","status":"completed","conclusion":"success"}],
                [pr(91,4,"open")]]
            result = sync.reconcile(db, "read-only-token",
                                    {"repository_full_name":"x/y","system_id":"s",
                                     "default_branch":"main"})
        self.assertEqual(result["sha"], SHA)
        self.assertEqual(result["checks"], 1)
        self.assertEqual(result["open_prs"], 2)  # 1 current open, 1 corrected closure
        data=[d for table,method,d in db.writes if table=="github_work_items" and method=="POST"]
        self.assertEqual({d["state"] for d in data}, {"open","closed"})
        projections=[d for table,method,d in db.writes if table=="system_github_repositories" and method=="PATCH"]
        self.assertEqual(len(projections),1)
        self.assertEqual(projections[0]["last_observed_default_branch_sha"],SHA)
        self.assertEqual(projections[0]["sync_status"],"healthy")

    def test_pagination_must_not_silently_truncate(self):
        with mock.patch.object(sync,"gh_get",return_value=[{}]*100):
            with self.assertRaisesRegex(RuntimeError,"safety cap"):
                sync.paged("token","/repos/x/y/pulls?state=open")

    def test_bad_repository_mapping_fails_closed(self):
        with self.assertRaisesRegex(ValueError,"Invalid"):
            sync.reconcile(FakeDb(),"read-only-token",{
                "repository_full_name":"bad/../repo","system_id":"s","default_branch":"main"})

if __name__ == "__main__":
    unittest.main()
