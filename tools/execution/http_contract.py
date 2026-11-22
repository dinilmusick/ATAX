"""Pure validation for typed HTTP contracts. No network side effects."""
from __future__ import annotations
import hashlib
import ipaddress
import json
import re
from urllib.parse import urlsplit

class ContractError(ValueError):
    pass

def validate_endpoint(url: str) -> str:
    """Static gate only: network runner must enforce DNS/IP on actual connection."""
    if not isinstance(url, str) or len(url) > 2048 or any(ord(c) < 33 for c in url):
        raise ContractError("invalid endpoint")
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ContractError("invalid endpoint syntax") from exc
    if (parsed.scheme != "https" or not host or parsed.username is not None
        or parsed.password is not None or parsed.fragment or parsed.query
        or port not in (None, 443)):
        raise ContractError("registered HTTPS endpoint required")
    host = host.lower().rstrip(".")
    if (host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost")
        or not re.fullmatch(r"[a-z0-9.-]+", host) and ":" not in host):
        raise ContractError("invalid public hostname")
    if "." not in host and ":" not in host:
        raise ContractError("public DNS name required")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not ip.is_global:
            raise ContractError("non-public IP forbidden")
    return url

def validate_payload(payload: object, *, max_bytes: int = 4096) -> tuple[bytes, str]:
    """Canonical JSON bytes/hash. Schema and pinned tokenizer are separate mandatory gates."""
    if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or not 1 <= max_bytes <= 65536:
        raise ContractError("invalid byte budget")
    try:
        data = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                          allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as exc:
        raise ContractError("invalid JSON payload") from exc
    if len(data) > max_bytes:
        raise ContractError("payload exceeds byte budget")
    return data, hashlib.sha256(data).hexdigest()

def validate_contract(contract: dict, registry: dict) -> dict:
    """Require registered operation; reject untrusted endpoint and credential overrides."""
    if not isinstance(contract, dict) or not isinstance(registry, dict):
        raise ContractError("contract and registry must be objects")
    if any(k in contract for k in ("endpoint", "url", "headers", "credential", "secret", "method")):
        raise ContractError("operation overrides forbidden")
    op = contract.get("operation")
    if not isinstance(op, str) or op not in registry:
        raise ContractError("operation not registered")
    definition = registry[op]
    if not isinstance(definition, dict):
        raise ContractError("invalid registered operation")
    if definition.get("method") not in {"POST", "PUT", "PATCH", "DELETE", "GET"}:
        raise ContractError("unsupported registered method")
    validate_endpoint(definition.get("endpoint", ""))
    if contract.get("target_ref") != definition.get("target_ref"):
        raise ContractError("target mismatch")
    if contract.get("schema_version") != definition.get("schema_version"):
        raise ContractError("schema mismatch")
    return definition
