#!/usr/bin/env python3
"""Synthetic regression tests for the FMRL nested-log sanitizer."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("sanitize_fmrl_diagnostic.py")

def run(payload: str) -> str:
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=payload,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout

def main() -> int:
    sample = "\n".join([
        "normal build step completed",
        "private source code should not be retained",
        "Error: cannot find module './secret-module'",
        "PRIVATE_REPO_TOKEN=ghp_123456789012345678901234567890",
        "Authorization: Bearer eyJabcdefghijk.abcdefghijk.abcdefghijk",
        "DATABASE_URL=postgresql://alice:super-secret@db.example.invalid/app",
        "AWS_SECRET_ACCESS_KEY=AKIA1234567890ABCDEF",
        "ordinary output with no diagnostic marker",
    ])
    output = run(sample)
    required = [
        "Error: cannot find module",
        "PRIVATE_REPO_TOKEN=[redacted]",
        "Bearer [redacted]",
        "[redacted-database-url]",
        "[redacted-aws-key]",
    ]
    for marker in required:
        assert marker in output, f"expected sanitized marker: {marker}"
    for secret in [
        "ghp_123456789012345678901234567890",
        "abcdefghijk.abcdefghijk.abcdefghijk",
        "super-secret",
        "AKIA1234567890ABCDEF",
        "private source code should not be retained",
        "ordinary output with no diagnostic marker",
    ]:
        assert secret not in output, f"unsafe/unfiltered content leaked: {secret}"

    many = "\n".join(f"Error: synthetic failure {index}" for index in range(40))
    bounded = run(many)
    assert bounded.count("- Error:") == 24, "diagnostic summary must be bounded to 24 lines"
    assert len(max(bounded.splitlines(), key=len)) <= 430, "diagnostic lines must be length-bounded"
    print("FMRL diagnostic sanitizer synthetic tests passed.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
