#!/usr/bin/env python3
"""Standard-library unit tests: run without credentials or a network."""
import importlib.util
import pathlib
import unittest

SPEC = importlib.util.spec_from_file_location("atax_bridge", pathlib.Path(__file__).with_name("bridge.py"))
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class FakeDB:
    def __init__(self):
        self.calls = []

    def rpc(self, name, args):
        self.calls.append((name, args))
        return {"success": True}

    def table(self, name, **kwargs):
        self.calls.append((name, kwargs))
        if name == "skills":
            return [{"slug": "task-ledger", "name": "Task Ledger", "current_version_id": "V"}]
        return [{"version": "2.8.1", "instructions": "Safe skill", "is_published": True}]


class BridgeTests(unittest.TestCase):
    def command(self, op, args, actor="trusted-agent"):
        db = FakeDB()
        outcome = BRIDGE.execute_command(
            {"protocol": BRIDGE.COMMAND_VERSION, "op": op, "args": args}, actor, db
        )
        return outcome, db.calls

    def test_authenticated_actor_not_supplied_agent_id(self):
        goal = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        _, calls = self.command("claim", {"goal_id": goal}, "ResearchAgent")
        self.assertEqual(calls[0][0], "task_ledger_claim_goal_next")
        self.assertEqual(calls[0][1]["agent_id_in"], "atax-github:researchagent")
        self.assertEqual(calls[0][1]["lease_seconds_in"], 120)

    def test_no_arbitrary_sql_or_rpc(self):
        for op in ("execute_sql", "rpc", "table", "workflow_dispatch"):
            with self.subTest(op=op):
                with self.assertRaises(BRIDGE.BridgeError):
                    self.command(op, {"name": "dangerous"})
        with self.assertRaises(BRIDGE.BridgeError):
            self.command("context", {"table": "secrets"})
        with self.assertRaises(BRIDGE.BridgeError):
            self.command("claim", {"goal_id": "bad", "agent_id": "impersonated"})

    def test_fenced_executor_calls(self):
        task = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        fence = "11111111-2222-4333-8444-555555555555"
        _, heartbeat = self.command("heartbeat", {"task_id": task, "claim_token": fence})
        self.assertEqual(heartbeat[0][1]["claim_token_in"], fence)
        self.assertEqual(heartbeat[0][1]["agent_id_in"], "atax-github:trusted-agent")
        _, submit = self.command("submit", {"task_id": task, "claim_token": fence, "result": {}, "evidence": [{"url": "https://example.org"}]})
        self.assertEqual(submit[0][0], "task_ledger_submit_result")
        self.assertEqual(submit[0][1]["evidence_in"][0]["url"], "https://example.org")

    def test_loss_handoff_does_not_mutate_socket_and_agent_can_claim_again(self):
        task = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        fence = "11111111-2222-4333-8444-555555555555"
        _, checked = self.command("check_claim", {"task_id": task, "claim_token": fence})
        self.assertEqual(checked[0][0], "task_ledger_check_claim")
        self.assertEqual(checked[0][1]["agent_id_in"], "atax-github:trusted-agent")

        _, handoff = self.command("handoff", {
            "task_id": task, "claim_token": fence,
            "note": "Expired lease; changes committed; pending review",
            "context": {"evidence": [{"url": "https://example.org/commit"}]},
        })
        self.assertEqual(handoff[0][0], "task_ledger_record_handoff")
        self.assertEqual(handoff[0][1]["previous_agent_id_in"], "atax-github:trusted-agent")
        self.assertEqual(handoff[0][1]["previous_claim_token_in"], fence)
        self.assertEqual(len(handoff), 1)  # Handoff is not a submit/release/new-claim.
        with self.assertRaises(BRIDGE.BridgeError):
            self.command("handoff", {"task_id": task, "claim_token": fence, "note": "x", "agent_id": "spoofed"})

        goal = "11111111-2222-4333-8444-555555555555"
        _, next_claim = self.command("claim", {"goal_id": goal})
        self.assertEqual(next_claim[0][0], "task_ledger_claim_goal_next")

    def test_fenced_out_holder_can_leave_note_and_claim_other_work(self):
        task = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        old = "11111111-2222-4333-8444-555555555555"
        result, calls = self.command("handoff", {
            "task_id": task, "old_claim_token": old,
            "note": "Lease was lost; partial output saved, remaining validation pending.",
            "context": {"progress": "completed implementation",
                        "evidence": ["https://example.org/verified-pr"],
                        "next_action": "New holder must independently check tests"},
        }, "researcher")
        self.assertEqual(result, {"success": True})
        self.assertEqual(calls[0][0], "task_ledger_record_handoff")
        self.assertEqual(calls[0][1]["previous_claim_token_in"], old)
        self.assertEqual(calls[0][1]["previous_agent_id_in"], "atax-github:researcher")
        self.assertEqual(len(calls), 1, "Handoff must not mutate or release the task")
        another, new_claim = self.command("claim", {"goal_id": task}, "researcher")
        self.assertEqual(another, {"success": True})
        self.assertEqual(new_claim[0][0], "task_ledger_claim_goal_next")
        self.assertEqual(new_claim[0][1]["agent_id_in"], "atax-github:researcher")
        with self.assertRaises(BRIDGE.BridgeError):
            self.command("handoff", {"task_id": task, "old_claim_token": "bad", "note": "fake"})

    def test_verification_uses_actor_principal(self):
        _, claim = self.command("verification_claim", {}, "auditor")
        self.assertEqual(claim[0][1]["verifier_agent_id_in"], "atax-github:auditor")
        task = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        token = "11111111-2222-4333-8444-555555555555"
        _, verify = self.command("verify", {"task_id": task, "verification_token": token,
                                             "accepted": True, "report": {}}, "auditor")
        self.assertEqual(verify[0][0], "task_ledger_verify_result_claimed")
        self.assertEqual(verify[0][1]["verifier_agent_id_in"], "atax-github:auditor")

    def test_skill_reads_only_published_version(self):
        result, calls = self.command("skill", {"slug": "task-ledger"})
        self.assertEqual(result["instructions"], "Safe skill")
        self.assertEqual([call[0] for call in calls], ["skills", "skill_versions"])
        self.assertEqual(calls[1][1]["filters"]["is_published"], "eq.true")

    def test_private_issue_and_actor_allowlist(self):
        event = {"action": "opened", "repository": {"private": True, "full_name": "owner/private-control"},
                 "sender": {"login": "ResearchAgent"},
                 "issue": {"number": 9, "body": '{"protocol":"atax-github-bridge/v1","op":"context","args":{}}',
                           "user": {"login": "ResearchAgent"}}}
        command, actor, repository, number = BRIDGE.issue_request(event, "ResearchAgent, auditor")
        self.assertEqual((actor, repository, number), ("ResearchAgent", "owner/private-control", 9))
        self.assertEqual(command["op"], "context")
        event["repository"]["private"] = False
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE.issue_request(event, "ResearchAgent")
        event["repository"]["private"] = True
        event["sender"]["login"] = "evil"
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE.issue_request(event, "ResearchAgent")

    def test_no_untrusted_protocol_fields(self):
        with self.assertRaises(BRIDGE.BridgeError):
            self.command("context", {"unexpected": "argument"})
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE.execute_command({"protocol": "other", "op": "context", "args": {}},
                                   "trusted-agent", FakeDB())

if __name__ == "__main__":
    unittest.main()
