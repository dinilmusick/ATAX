"""Fail-closed, dependency-free task-socket workflow execution contract.

This module intentionally has no GitHub or Supabase client implementation. Agent C
may call the authorizer independently; every transition is rechecked by SQL.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Protocol

REPO = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
SHA = re.compile(r"^[0-9a-f]{40}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
KEY = re.compile(r"^[A-Za-z0-9_.:/-]{8,128}$")
WORKFLOW = re.compile(r"^[A-Za-z0-9_.-]{1,100}\.ya?ml$")
OPERATIONS = frozenset({"test", "build", "automation", "change_request"})
MODES = frozenset({"target", "fmrl"})
MAX_INPUT_BYTES = 8192
MAX_EXPECTED_BYTES = 2048
MAX_RECEIPT_BYTES = 4096
MAX_ARTIFACT_REF = 256
RESTRICTED = re.compile(r"(secret|password|token|private.key|credential|authorization|api.key)", re.I)


class ContractError(ValueError):
    """Denial without leaking request contents."""


class FencedAuthorizer(Protocol):
    def authorize(self, task_id: str, agent_id: str, session_id: str, fence: str) -> bool: ...


def canonical(value: Any, maximum: int) -> str:
    try:
        s = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ContractError("invalid JSON payload") from exc
    if len(s.encode("utf-8")) > maximum:
        raise ContractError("payload budget exceeded")
    return s


def reject_sensitive(value: Any, depth: int = 0) -> None:
    if depth > 8:
        raise ContractError("nested input limit")
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str) or RESTRICTED.search(k):
                raise ContractError("restricted payload field")
            reject_sensitive(v, depth + 1)
    elif isinstance(value, list):
        if len(value) > 64:
            raise ContractError("list limit")
        for item in value:
            reject_sensitive(item, depth + 1)
    elif isinstance(value, str):
        if len(value) > 1024 or value.startswith(("ghp_", "ghs_", "github_pat_", "sk-")):
            raise ContractError("restricted payload value")


@dataclass(frozen=True)
class ExecutionRequest:
    id: str
    task_id: str
    agent_id: str
    session_id: str
    claim_fence: str
    correlation_id: str
    idempotency_key: str
    operation: str
    target_repository: str
    runner_repository: str
    target_sha: str
    workflow_file: str
    mode: str
    input_payload: dict[str, Any]
    expected_output: dict[str, Any]

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "ExecutionRequest":
        fields = cls.__dataclass_fields__
        try:
            r = cls(**{key: record[key] for key in fields})
        except (KeyError, TypeError) as exc:
            raise ContractError("required execution contract fields missing") from exc
        for key in ("id", "task_id", "claim_fence", "correlation_id"):
            if not isinstance(getattr(r, key), str) or not UUID.fullmatch(getattr(r, key)):
                raise ContractError("invalid identifier")
        if not isinstance(r.agent_id, str) or not (1 <= len(r.agent_id) <= 128):
            raise ContractError("invalid identity")
        if not isinstance(r.session_id, str) or not (1 <= len(r.session_id) <= 128):
            raise ContractError("invalid session")
        if not isinstance(r.idempotency_key, str) or not KEY.fullmatch(r.idempotency_key):
            raise ContractError("invalid idempotency key")
        if r.operation not in OPERATIONS or r.mode not in MODES:
            raise ContractError("operation or mode not authorised")
        if not isinstance(r.target_repository, str) or not REPO.fullmatch(r.target_repository):
            raise ContractError("invalid target")
        if not isinstance(r.runner_repository, str) or not REPO.fullmatch(r.runner_repository):
            raise ContractError("invalid runner")
        if not isinstance(r.target_sha, str) or not SHA.fullmatch(r.target_sha):
            raise ContractError("target revision must be a full immutable commit SHA")
        if not isinstance(r.workflow_file, str) or not WORKFLOW.fullmatch(r.workflow_file):
            raise ContractError("invalid workflow filename")
        if r.mode == "target" and r.runner_repository != r.target_repository:
            raise ContractError("target runner mismatch")
        if r.mode == "fmrl":
            expected = r.target_repository.split("/")[0] + "/FMRL-" + r.correlation_id.replace("-", "")[:20]
            if r.runner_repository != expected:
                raise ContractError("FMRL runner identity must be correlation-bound and canonical")
        if not isinstance(r.input_payload, dict) or not isinstance(r.expected_output, dict):
            raise ContractError("payload and expected output must be objects")
        canonical(r.input_payload, MAX_INPUT_BYTES)
        canonical(r.expected_output, MAX_EXPECTED_BYTES)
        reject_sensitive(r.input_payload)
        return r

    def fingerprint(self) -> str:
        # Idempotency binds the entire immutable request, excluding DB-generated id.
        doc = {field: getattr(self, field) for field in self.__dataclass_fields__ if field != "id"}
        return hashlib.sha256(canonical(doc, 16384).encode()).hexdigest()


def bounded_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    allowed = {"correlation_id", "request_id", "run_id", "conclusion", "error_class", "artifact_ref", "cleanup", "observed_at", "target_sha"}
    if not isinstance(receipt, dict) or set(receipt) - allowed:
        raise ContractError("non-allowlisted receipt fields")
    if receipt.get("conclusion") not in {"success", "failure", "cancelled", "timed_out", "action_required", "startup_denied", "unknown"}:
        raise ContractError("invalid terminal result")
    if "artifact_ref" in receipt and (not isinstance(receipt["artifact_ref"], str) or len(receipt["artifact_ref"]) > MAX_ARTIFACT_REF or not receipt["artifact_ref"].startswith("github-artifact://")):
        raise ContractError("artifact reference must be immutable and controlled")
    if receipt.get("cleanup", "not_required") not in {"not_required", "pending", "independent_404"}:
        raise ContractError("invalid cleanup attestation")
    canonical(receipt, MAX_RECEIPT_BYTES)
    reject_sensitive(receipt)
    return receipt
