#!/usr/bin/env python3
"""Emit a small, redacted failure summary from an ephemeral FMRL runner log.

This intentionally does not persist raw nested logs or artifacts containing
private repository output. Only diagnostic-looking lines are selected.
"""
from __future__ import annotations

import re
import sys

ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ERROR_LINE = re.compile(
    r"\b(error|failed|failure|exception|traceback|assertionerror|"
    r"typeerror|referenceerror|syntaxerror|err_[a-z0-9_]+|err!|"
    r"cannot find module|not found|exit code|exitcode|"
    r"econnrefused|eaddrinuse|unhandled rejection)\b",
    re.IGNORECASE,
)
SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|COOKIE|AUTHORIZATION|API[_-]?KEY|CREDENTIAL)[A-Z0-9_]*)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*")
GITHUB_TOKEN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")
AWS_KEY = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
DATABASE_URL = re.compile(r"(?i)\bpostgres(?:ql)?://[^\s'\"<>]+")
URL_CREDENTIALS = re.compile(r"(https?://)[^/@\s]+:[^/@\s]+@")

def redact(value: str) -> str:
    value = ANSI.sub("", value)
    # Redact structured Authorization headers before the generic assignment
    # rule so the word "Bearer" cannot hide the credential that follows it.
    value = BEARER.sub("Bearer [redacted]", value)
    value = SECRET_ASSIGNMENT.sub(lambda m: m.group(1) + m.group(2) + "[redacted]", value)
    value = GITHUB_TOKEN.sub("[redacted-github-token]", value)
    value = AWS_KEY.sub("[redacted-aws-key]", value)
    value = JWT.sub("[redacted-jwt]", value)
    value = DATABASE_URL.sub("[redacted-database-url]", value)
    value = URL_CREDENTIALS.sub(r"\1[redacted]@", value)
    return value.strip()

def main() -> int:
    selected: list[str] = []
    for raw in sys.stdin:
        line = redact(raw)
        if not line or not ERROR_LINE.search(line):
            continue
        if len(line) > 420:
            line = line[:417] + "..."
        if line not in selected:
            selected.append(line)
    selected = selected[-24:]
    print("### Sanitized nested-run diagnostic (selected error lines only)")
    if not selected:
        print("- No recognized error lines were retained; inspect the target workflow directly.")
        return 0
    for line in selected:
        print("- " + line.replace("\n", " "))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
