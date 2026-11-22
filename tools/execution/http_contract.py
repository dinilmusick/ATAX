"""Pure validation for ATAX typed HTTP task contracts; no network side effects."""
from __future__ import annotations
import hashlib
import ipaddress
import json
from urllib.parse import urlsplit

class ContractError(ValueError):
    pass

def validate_endpoint(url: str) -> str:
    """Static first gate; runner must additionally enforce DNS/IP egress on every connection."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ContractError("registered HTTPS endpoint required")
    if parsed.fragment or parsed.query:
        raise ContractError("endpoint registration cannot contain query or fragment")
    host = parsed.hostname.lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
        raise ContractError("local endpoint forbidden")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not ip.is_global:
            raise ContractError("non-public IP forbidden")
    if parsed.port not in (None, 443):
        raise ContractError("nonstandard port forbidden")
    return url

def validate_payload(payload: object, *, max_bytes: int = 4096) -> tuple[bytes, str]:
    """Canonical bytes/hash; token count and JSON schema MUST be checked by pinned runtime."""
    if max_bytes < 1 or max_bytes > 65536:
        raise ContractError("invalid byte budget")
    try:
        data = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                          allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ContractError("invalid JSON payload") from exc
    if len(data) > max_bytes:
        raise ContractError("payload exceeds byte budget")
    return data, hashlib.sha256(data).hexdigest()

def validate_contract(contract: dict, registry: dict) -> dict:
    """Require registered operation; do not trust agent-supplied URL/credentials."""
    if not isinstance(contract, dict):
        raise ContractError("contract must be object")
    op = contract.get("operation")
    if not isinstance(op, str) or op not in registry:
        raise ContractError("operation not registered")
    definition = registry[op]
    if definition.get("method") not in {"POST", "PUT", "PATCH", "DELETE", "GET"}:
        raise ContractError("unsupported registered method")
    validate_endpoint(definition.get("endpoint", ""))
    if contract.get("target_ref") != definition.get("target_ref"):
        raise ContractError("target mismatch")
    if contract.get("schema_version") != definition.get("schema_version"):
        raise ContractError("schema mismatch")
    return definition
