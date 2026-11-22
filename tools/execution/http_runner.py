"""Execute one registered HTTP operation. Designed for trusted disposable FMRL runner.

Requires a pinned, operator-approved registry supplied as secret configuration.
Do not expose payload, token, endpoint credentials, or response body in logs.
"""
import hashlib
import ipaddress
import json
import os
import socket
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from tools.execution.http_contract import ContractError, validate_contract, validate_payload

def _public_ip(host: str) -> str:
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses:
        raise ContractError("DNS resolution failed")
    ips = [ipaddress.ip_address(item[4][0]) for item in addresses]
    if any(not ip.is_global for ip in ips):
        raise ContractError("non-public DNS result")
    return str(ips[0])

def execute(contract: dict, payload: object, registry: dict, secrets: dict) -> dict:
    definition = validate_contract(contract, registry)
    method = definition["method"]
    if method not in ("POST", "PUT", "PATCH"):
        raise ContractError("effectful operation requires explicit implementation")
    data, digest = validate_payload(payload, max_bytes=min(int(definition.get("max_bytes", 4096)),4096))
    if definition.get("idempotent") is not True:
        raise ContractError("operation must explicitly support idempotency")
    if not isinstance(payload, dict) or not isinstance(payload.get("idempotency_key"), str):
        raise ContractError("idempotency key required")
    url = definition["endpoint"]
    parsed = urlsplit(url)
    ip = _public_ip(parsed.hostname)
    secret_name = definition.get("secret_ref")
    token = secrets.get(secret_name)
    if not secret_name or not token:
        raise ContractError("missing registered credential")
    # --resolve pins the TLS-verified host to the previously vetted public IP;
    # --max-redirs 0 and no -L ensure redirect destinations are never followed.
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        body = root / "request.json"
        response = root / "response.txt"
        headers = root / "headers.txt"
        body.write_bytes(data)
        os.chmod(body, 0o600)
        cmd = ["curl", "--silent", "--show-error", "--fail-with-body",
               "--proto", "=https", "--max-redirs", "0", "--noproxy", "*",
               "--resolve", f"{parsed.hostname}:443:{ip}",
               "--connect-timeout", "5", "--max-time", "20",
               "--max-filesize", "8192", "-X", method,
               "-H", "Content-Type: application/json",
               "-H", f"Authorization: Bearer {token}",
               "-H", f"Idempotency-Key: {payload['idempotency_key']}",
               "--data-binary", f"@{body}", "-D", str(headers),
               "-o", str(response), "-w", "%{http_code}", url]
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=25, check=False)
        except subprocess.TimeoutExpired:
            return {"outcome": "outcome_unknown", "reason": "timeout", "payload_sha256": digest}
        status_text = result.stdout.decode("ascii", errors="replace").strip()
        try:
            status = int(status_text)
        except ValueError:
            status = 0
        if response.exists() and response.stat().st_size > 8192:
            raise ContractError("response exceeds limit")
        # A transport error may occur after the remote service applied the effect.
        outcome = "executed" if result.returncode == 0 and 200 <= status < 300 else "outcome_unknown"
        return {"outcome": outcome, "http_status": status,
                "payload_sha256": digest, "response_sha256":
                hashlib.sha256(response.read_bytes() if response.exists() else b"").hexdigest()}
