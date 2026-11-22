#!/usr/bin/env python3
"""ATAX ledger bridge for a PRIVATE GitHub control repository.

The agent needs only its GitHub connector to create an issue and read its reply.
The secret-bearing private Actions runner invokes this allowlisted script;
no credentials, SQL, arbitrary RPC names, code or private data enter public ATAX.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "supabase-agent-client"))
from supabase_client import SupabaseAgentClient, SupabaseClientError  # noqa: E402

UUID = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
IDENT = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
MAX_REQUEST = 12000
MAX_REPLY = 28000
COMMAND_VERSION = "atax-github-bridge/v1"


class BridgeError(ValueError):
    pass


def require_fields(obj: object, required: set[str], optional: set[str] = frozenset()) -> dict:
    if not isinstance(obj, dict) or not required <= obj.keys() or set(obj) - required - optional:
        raise BridgeError("Invalid command fields")
    return obj


def uuid_arg(args: dict, key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise BridgeError(f"Invalid {key}")
    return value


def short_text(args: dict, key: str, maximum: int = 1000, default: str = "") -> str:
    value = args.get(key, default)
    if not isinstance(value, str) or len(value) > maximum:
        raise BridgeError(f"Invalid {key}")
    return value


def array_arg(args: dict, key: str, maximum: int = 40) -> list:
    value = args.get(key, [])
    if not isinstance(value, list) or len(value) > maximum:
        raise BridgeError(f"Invalid {key}")
    return value


def owner_identity(actor: str) -> str:
    # GitHub-authenticated issuer, not a user-supplied AI model/vendor identifier.
    if not re.fullmatch(r"[A-Za-z0-9-]{1,39}", actor):
        raise BridgeError("Invalid GitHub actor")
    return "atax-github:" + actor.lower()


def execute_command(command: dict, actor: str, db: SupabaseAgentClient):
    require_fields(command, {"protocol", "op", "args"})
    if command["protocol"] != COMMAND_VERSION:
        raise BridgeError("Invalid bridge protocol")
    op = command["op"]
    args = command["args"]
    if not isinstance(args, dict):
        raise BridgeError("Invalid operation arguments")
    identity = owner_identity(actor)

    if op == "context":
        require_fields(args, set())
        return db.rpc("agent_context_overview", {})
    if op == "goals":
        require_fields(args, set())
        return db.rpc("goal_ledger_overview", {"tags_in": None})
    if op == "skill":
        require_fields(args, {"slug"})
        slug = short_text(args, "slug", 80)
        if not IDENT.fullmatch(slug):
            raise BridgeError("Invalid skill slug")
        rows = db.table("skills", select="slug,name,current_version_id",
                        filters={"slug": f"eq.{slug}", "limit": "1"})
        if not rows:
            return {"found": False, "slug": slug}
        version_id = rows[0]["current_version_id"]
        versions = db.table("skill_versions", select="version,instructions,is_published",
                            filters={"id": f"eq.{version_id}", "is_published": "eq.true", "limit": "1"})
        if not versions:
            return {"found": False, "slug": slug}
        return {"slug": slug, "name": rows[0]["name"], "version": versions[0]["version"],
                "instructions": versions[0]["instructions"]}

    if op == "claim":
        require_fields(args, {"goal_id"}, {"capabilities"})
        caps = array_arg(args, "capabilities", 12)
        if any(not isinstance(v, str) or len(v) > 80 for v in caps):
            raise BridgeError("Invalid capabilities")
        return db.rpc("task_ledger_claim_goal_next", {
            "goal_id_in": uuid_arg(args, "goal_id"),
            "agent_id_in": identity, "agent_name_in": "GitHub bridge " + actor,
            "agent_type_in": "worker", "capabilities_in": caps, "lease_seconds_in": 120,
        })

    if op == "check_claim":
        require_fields(args, {"task_id", "claim_token"})
        return db.rpc("task_ledger_check_claim", {
            "task_id_in": uuid_arg(args, "task_id"),
            "claim_token_in": uuid_arg(args, "claim_token"),
            "agent_id_in": identity,
        })

    if op == "handoff":
        # This operation can only append an authenticated former-lease note;
        # it cannot submit results or release/reclaim the current socket.
        require_fields(args, {"task_id", "claim_token", "note"}, {"context"})
        context = args.get("context", {})
        if not isinstance(context, dict):
            raise BridgeError("Handoff context must be an object")
        return db.rpc("task_ledger_record_handoff", {
            "task_id_in": uuid_arg(args, "task_id"),
            "previous_claim_token_in": uuid_arg(args, "claim_token"),
            "previous_agent_id_in": identity,
            "handoff_note_in": short_text(args, "note", 3000),
            "context_in": context,
        })

    if op == "heartbeat":
        require_fields(args, {"task_id", "claim_token"}, {"current_step"})
        return db.rpc("task_ledger_heartbeat_claim", {
            "task_id_in": uuid_arg(args, "task_id"),
            "claim_token_in": uuid_arg(args, "claim_token"),
            "agent_id_in": identity, "lease_seconds_in": 120,
            "current_step_in": short_text(args, "current_step", 1200),
            "heartbeat_context_in": {"activity": "github-bridge", "progress": "Lease renewed",
                                     "next_action": "Continue finite external work"},
        })

    if op == "release":
        require_fields(args, {"task_id", "claim_token"}, {"reason"})
        return db.rpc("task_ledger_release_claim", {
            "task_id_in": uuid_arg(args, "task_id"),
            "claim_token_in": uuid_arg(args, "claim_token"),
            "agent_id_in": identity, "release_status_in": "queued",
            "reason_in": short_text(args, "reason", 1000),
        })

    if op == "submit":
        require_fields(args, {"task_id", "claim_token", "result", "evidence"}, {"summary", "status"})
        if not isinstance(args["result"], dict):
            raise BridgeError("Result must be an object")
        evidence = array_arg(args, "evidence", 30)
        status = args.get("status", "completed")
        if status not in ("completed", "failed", "blocked", "waiting"):
            raise BridgeError("Invalid submission status")
        return db.rpc("task_ledger_submit_result", {
            "task_id_in": uuid_arg(args, "task_id"),
            "claim_token_in": uuid_arg(args, "claim_token"),
            "agent_id_in": identity, "status_in": status,
            "result_in": args["result"], "evidence_in": evidence,
            "result_summary_in": short_text(args, "summary", 1500),
            "tools_used_in": ["github-only-ledger-bridge"],
        })

    if op == "handoff":
        # A lost task lease does not end this external agent's work session.
        # The old token is used only to annotate immutable history, NEVER
        # to release, submit, renew or mutate the new holder's task socket.
        require_fields(args, {"task_id", "old_claim_token", "note"}, {"context"})
        context = args.get("context", {})
        if not isinstance(context, dict) or len(json.dumps(context).encode("utf-8")) > 8000:
            raise BridgeError("Invalid handoff context")
        return db.rpc("task_ledger_record_handoff", {
            "task_id_in": uuid_arg(args, "task_id"),
            "previous_agent_id_in": identity,
            "previous_claim_token_in": uuid_arg(args, "old_claim_token"),
            "handoff_note_in": short_text(args, "note", 3000),
            "context_in": context,
        })

    if op == "verification_claim":
        require_fields(args, set())
        return db.rpc("task_ledger_claim_verification", {
            "verifier_agent_id_in": identity, "lease_seconds_in": 120,
        })

    if op == "verify":
        require_fields(args, {"task_id", "verification_token", "accepted", "report"})
        if not isinstance(args["accepted"], bool) or not isinstance(args["report"], dict):
            raise BridgeError("Invalid verification result")
        return db.rpc("task_ledger_verify_result_claimed", {
            "task_id_in": uuid_arg(args, "task_id"),
            "verification_claim_token_in": uuid_arg(args, "verification_token"),
            "verifier_agent_id_in": identity, "verified_in": args["accepted"],
            "verification_report_in": args["report"],
        })
    raise BridgeError("Operation is not allowlisted")


def issue_request(event: dict, allowed_actors: str) -> tuple[dict, str, str, int]:
    repo = event.get("repository", {})
    if repo.get("private") is not True:
        raise BridgeError("Private controller repository required")
    if event.get("action") != "opened":
        raise BridgeError("Only newly opened command issues are accepted")
    issue = event.get("issue", {})
    actor = issue.get("user", {}).get("login", "")
    sender = event.get("sender", {}).get("login", "")
    allowed = {s.strip().lower() for s in allowed_actors.split(",") if s.strip()}
    if not allowed or actor.lower() not in allowed or sender.lower() != actor.lower():
        raise BridgeError("Caller is not authorized")
    repository = repo.get("full_name", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise BridgeError("Invalid repository")
    body = issue.get("body") or ""
    if not isinstance(body, str) or len(body.encode()) > MAX_REQUEST:
        raise BridgeError("Command too large")
    try:
        command = json.loads(body)
    except ValueError as exc:
        raise BridgeError("Issue body must be a JSON command") from exc
    number = issue.get("number")
    if not isinstance(number, int) or number < 1:
        raise BridgeError("Invalid issue number")
    return command, actor, repository, number


def comment_issue(repository: str, number: int, result: object):
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        raise BridgeError("Private Actions comment token is unavailable")
    text = json.dumps(result, ensure_ascii=False, separators=(",", ":"), default=str)
    if len(text) > MAX_REPLY:
        text = json.dumps({"ok": False, "error": "Response exceeds private comment limit"})
    request = Request(
        "https://api.github.com/repos/" + repository + f"/issues/{number}/comments",
        data=json.dumps({"body": "ATAX_BRIDGE_RESULT_V1\n\n```json\n" + text + "\n```"}).encode(),
        method="POST",
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"},
    )
    with urlopen(request, timeout=30):
        pass


def main() -> int:
    try:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as stream:
            event = json.load(stream)
        command, actor, repository, number = issue_request(
            event, os.environ.get("ATAX_BRIDGE_ALLOWED_ACTORS", "")
        )
    except (BridgeError, KeyError, OSError, ValueError):
        # Denied events never receive secrets, SQL access or a disclosure comment.
        print("ATAX bridge: rejected request")
        return 2
    try:
        if not os.environ.get("SUPABASE_URL", "").startswith("https://") or not os.environ.get("SUPABASE_SECRET_KEY"):
            raise BridgeError("TLS Supabase endpoint and scoped server secret are required")
        db = SupabaseAgentClient.from_environment()
        result = execute_command(command, actor, db)
        comment_issue(repository, number, {"ok": True, "result": result})
    except (BridgeError, SupabaseClientError, KeyError, TypeError, ValueError):
        # Do not echo provider errors: database responses can contain private data.
        try:
            comment_issue(repository, number, {"ok": False, "error": "Command rejected by ledger policy"})
        except Exception:
            pass
        print("ATAX bridge: ledger command rejected")
        return 2
    except Exception:
        print("ATAX bridge: internal failure; no private error details emitted")
        return 2
    print("ATAX bridge: completed private command")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
