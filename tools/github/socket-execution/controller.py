"""ATAX socket controller: relay only, never checkout/execute target code.

Use in a GitHub workflow with repository secrets. Only opaque IDs cross the
Supabase-originated GitHub dispatch boundary. A task-bound agent never receives
these credentials. The authoritative SQL RPC enforces the *current* fence.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from contract import ContractError, ExecutionRequest, bounded_receipt

API_VERSION = "2022-11-28"


class RemoteError(RuntimeError):
    def __init__(self, category: str):
        super().__init__(category)
        self.category = category


class Http:
    def request(self, method: str, url: str, token: str, payload: Any = None, headers: dict | None = None) -> tuple[int, Any]:
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        h = {"Accept": "application/json", "Authorization": "Bearer " + token, "User-Agent": "atax-socket-controller"}
        if payload is not None:
            h["Content-Type"] = "application/json"
        if headers:
            h.update(headers)
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                content = response.read(512 * 1024)
                return response.status, json.loads(content) if content else None
        except urllib.error.HTTPError as exc:
            # Never echo provider bodies: they can contain sensitive information.
            if exc.code in (401, 403):
                raise RemoteError("credentials_or_scope") from None
            if exc.code == 404:
                return 404, None
            if exc.code == 429 or exc.code >= 500:
                raise RemoteError("retryable_provider") from None
            raise RemoteError("provider_rejected") from None
        except (TimeoutError, urllib.error.URLError) as exc:
            raise RemoteError("delivery_uncertain") from None


    def anonymous_status(self, url: str) -> int:
        """Independently observe public FMRL deletion without any bearer token."""
        request = urllib.request.Request(url, method="GET", headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "atax-socket-cleanup-auditor",
        })
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return 404
            raise RemoteError("fmrl_cleanup_not_verified") from None
        except (TimeoutError, urllib.error.URLError):
            raise RemoteError("fmrl_cleanup_not_verified") from None


class Supabase:
    def __init__(self, url: str, token: str, http: Http):
        if not url.startswith("https://") or not token:
            raise RemoteError("missing_credentials")
        self.url, self.token, self.http = url.rstrip("/"), token, http

    def rpc(self, name: str, args: dict[str, Any]) -> Any:
        code, data = self.http.request("POST", f"{self.url}/rest/v1/rpc/{name}", self.token, args, {"apikey": self.token})
        if code != 200:
            raise RemoteError("ledger_rpc_rejected")
        return data

    def rows(self, table: str, filters: dict[str, str]) -> list[dict]:
        qs = urllib.parse.urlencode({key: (value if value.startswith("in.(") else "eq." + value) for key, value in filters.items()})
        ordering = "&order=created_at.asc" if table == "socket_dispatch_requests" else ""
        code, data = self.http.request("GET", f"{self.url}/rest/v1/{table}?{qs}&select=*&limit=25{ordering}", self.token, headers={"apikey": self.token})
        if code != 200 or not isinstance(data, list):
            raise RemoteError("ledger_read_failed")
        return data


class Github:
    def __init__(self, token: str, http: Http):
        if not token:
            raise RemoteError("missing_credentials")
        self.token, self.http = token, http

    def api(self, method: str, path: str, data: dict | None = None) -> tuple[int, Any]:
        if not path.startswith("repos/") or ".." in path or "?" in path.split("/", 3)[0]:
            raise RemoteError("invalid_github_path")
        return self.http.request(method, "https://api.github.com/" + path, self.token, data,
                                 {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION})

    def dispatch(self, request: ExecutionRequest) -> None:
        # Only allowlisted workflow + repository selected by server-side ledger.
        owner_repo = request.runner_repository
        code, _ = self.api("POST", f"repos/{owner_repo}/actions/workflows/{request.workflow_file}/dispatches", {
            "ref": "main",  # trusted workflow on runner's default branch; target SHA is pinned input
            "inputs": {"request_id": request.id, "correlation_id": request.correlation_id,
                       "task_id": request.task_id, "claim_fence": request.claim_fence,
                       "target_sha": request.target_sha, "operation": request.operation},
        })
        if code != 204:
            raise RemoteError("dispatch_unacknowledged")

    def runs(self, request: ExecutionRequest) -> list[dict]:
        code, data = self.api("GET", f"repos/{request.runner_repository}/actions/workflows/{request.workflow_file}/runs?event=workflow_dispatch&per_page=100")
        if code != 200 or not isinstance(data, dict):
            raise RemoteError("run_observation_failed")
        expected = "atax-socket/" + request.correlation_id
        return [r for r in data.get("workflow_runs", []) if r.get("display_title") == expected and
                r.get("event") == "workflow_dispatch" and r.get("repository", {}).get("full_name") == request.runner_repository]

    def delete_fmrl(self, request: ExecutionRequest) -> str:
        # The FMRL is disposable; deletion must match a correlation-bound name.
        owner, name = request.runner_repository.split("/")
        expected = "FMRL-" + request.correlation_id.replace("-", "")[:20]
        if request.mode != "fmrl" or name != expected or owner != request.target_repository.split("/")[0]:
            raise RemoteError("fmrl_identity_mismatch")
        code, _ = self.api("DELETE", f"repos/{request.runner_repository}")
        if code not in (204, 404):
            raise RemoteError("fmrl_delete_failed")
        # A token-free GET, not the DELETE response or a same-token GET,
        # independently proves that the PUBLIC disposable repository is gone.
        check = self.http.anonymous_status("https://api.github.com/repos/" + request.runner_repository)
        if check != 404:
            raise RemoteError("fmrl_cleanup_not_verified")
        return "independent_404"


class Controller:
    def __init__(self, db: Supabase, gh: Github):
        self.db, self.gh = db, gh

    def _load(self, rid: str, correlation: str | None = None) -> ExecutionRequest:
        rows = self.db.rows("socket_dispatch_requests", {"id": rid})
        if len(rows) != 1:
            raise RemoteError("request_not_found")
        req = ExecutionRequest.from_record(rows[0])
        if correlation and req.correlation_id != correlation:
            raise RemoteError("correlation_mismatch")
        allowed = self.db.rows("socket_dispatch_allowed_targets", {"target_repository": req.target_repository,
                                                                      "runner_repository": req.runner_repository,
                                                                      "workflow_file": req.workflow_file, "operation": req.operation,
                                                                      "mode": req.mode, "enabled": "true"})
        if len(allowed) != 1:
            raise RemoteError("target_not_allowlisted")
        return req

    def dispatch(self, rid: str, correlation: str) -> str:
        req = self._load(rid, correlation)
        # Begin is an atomic SQL compare-and-swap: valid claim, session, fencing,
        # and exactly one caller can transition queued => dispatching.
        acquired = self.db.rpc("socket_dispatch_begin", {"p_request_id": req.id, "p_fence": req.claim_fence,
                                                          "p_agent": req.agent_id, "p_session": req.session_id})
        if acquired is not True:
            return "already_started_or_fence_invalid"
        try:
            self.gh.dispatch(req)
        except RemoteError as exc:
            # Network ambiguity must NEVER retry a side-effect blindly.
            self.db.rpc("socket_dispatch_delivery_result", {"p_request_id": req.id,
                "p_state": "uncertain" if exc.category in {"delivery_uncertain", "retryable_provider"} else "failed",
                "p_error_class": exc.category})
            raise
        self.db.rpc("socket_dispatch_delivery_result", {"p_request_id": req.id,
                                                              "p_state": "accepted", "p_error_class": None})
        return "relay_accepted"

    def reconcile(self, limit: int = 20) -> dict[str, int]:
        if limit < 1 or limit > 25:
            raise ContractError("reconciliation bound")
        summary = {"observed": 0, "terminal": 0, "pending": 0, "failed_closed": 0}
        rows = self.db.rows("socket_dispatch_requests", {"status": "in.(dispatching,accepted,uncertain,running)"})
        for row in rows[:limit]:
            if row.get("status") not in {"dispatching", "accepted", "uncertain", "running"}:
                continue
            req = self._load(row["id"])
            summary["observed"] += 1
            journal = self.db.rows("socket_dispatch_cleanup_journal", {"request_id": req.id}) if req.mode == "fmrl" else []
            if len(journal) > 1:
                summary["failed_closed"] += 1
                continue
            if journal:
                # Run history may be gone after cleanup; use the durable observation.
                frozen = journal[0]
                run_id, conclusion = frozen["run_id"], frozen["conclusion"]
                receipt = bounded_receipt(frozen["receipt"])
            else:
                runs = self.gh.runs(req)
                if len(runs) != 1:
                    summary["pending" if not runs else "failed_closed"] += 1
                    continue  # Never infer success from an ambiguous/missing run.
                run = runs[0]
                if run.get("status") != "completed":
                    summary["pending"] += 1
                    continue
                conclusion = run.get("conclusion")
                if conclusion not in {"success", "failure", "cancelled", "timed_out", "action_required"}:
                    summary["failed_closed"] += 1
                    continue
                run_id = str(run["id"])
                receipt = bounded_receipt({"request_id": req.id, "correlation_id": req.correlation_id,
                    "run_id": run_id, "conclusion": conclusion,
                    "cleanup": "pending" if req.mode == "fmrl" else "not_required",
                    "target_sha": req.target_sha, "observed_at": datetime.now(timezone.utc).isoformat()})
                if req.mode == "fmrl":
                    self.db.rpc("socket_dispatch_prepare_cleanup", {"p_request_id": req.id,
                        "p_run_id": run_id, "p_conclusion": conclusion, "p_receipt": receipt})
            if req.mode == "fmrl":
                try:
                    deletion = self.gh.delete_fmrl(req)
                except RemoteError as exc:
                    # Journal already holds the observed terminal run; persist why
                    # deletion could not be attested so repeated failures are visible.
                    recorded = self.db.rpc("socket_dispatch_cleanup_failed", {
                        "p_request_id": req.id, "p_error_class": exc.category,
                    })
                    if recorded is not True:
                        raise RemoteError("cleanup_failure_not_recorded") from None
                    raise
                receipt = bounded_receipt(dict(receipt, cleanup=deletion))
            applied = self.db.rpc("socket_dispatch_finish_observed", {"p_request_id": req.id,
                "p_run_id": run_id, "p_conclusion": conclusion, "p_receipt": receipt})
            if applied:
                summary["terminal"] += 1
        return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["dispatch", "reconcile"])
    parser.add_argument("--request-id")
    parser.add_argument("--correlation-id")
    args = parser.parse_args()
    try:
        db = Supabase(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""), Http())
        gh = Github(os.environ.get("SOCKET_GITHUB_TOKEN", ""), Http())
        c = Controller(db, gh)
        if args.command == "dispatch":
            if not args.request_id or not args.correlation_id:
                raise ContractError("dispatch identifiers required")
            print(c.dispatch(args.request_id, args.correlation_id))
        else:
            print(json.dumps(c.reconcile(), sort_keys=True))
        return 0
    except (ContractError, RemoteError) as exc:
        # Fixed error categories only. Never serialize request, credentials or provider output.
        print("socket execution denied: " + (exc.category if isinstance(exc, RemoteError) else "invalid_contract"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
