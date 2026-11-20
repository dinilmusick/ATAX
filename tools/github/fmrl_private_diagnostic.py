#!/usr/bin/env python3
"""Write bounded private test failure labels to the exact private PR, never public logs."""
import html
import json
import os
from pathlib import Path
import re
import sys
from urllib import error, request

API = "https://api.github.com"
LOG = Path("/tmp/fmrl-direct-raw.log")


def api(path: str, token: str, method: str = "GET", body=None):
    payload = json.dumps(body).encode() if body is not None else None
    req = request.Request(API + path, data=payload, method=method, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "atax-fmrl-private-diagnostic",
    })
    try:
        with request.urlopen(req, timeout=25) as res:
            return json.load(res)
    except error.HTTPError as exc:
        raise RuntimeError("Private diagnostic API gate HTTP " + str(exc.code)) from None


def sanitize(text: str) -> str:
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    text = re.sub(r"(?:ghp_|gho_|ghs_|sk-|Bearer\s+)[A-Za-z0-9._-]{16,}", "[redacted]", text)
    text = re.sub(r"[A-Za-z0-9_+/=-]{48,}", "[long-value-redacted]", text)
    return html.escape(text.replace("@", "＠").replace(chr(96), "'"))[:180]


def extract(log: str) -> list[str]:
    names = []
    # Vitest: FAIL path > suite > test; Node's built-in runner: not ok N - test.
    for line in log.splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
        m = re.match(r"(?:FAIL\s+(.+)|not ok\s+\d+\s*-\s*(.+))$", line)
        if m:
            name = sanitize(m.group(1) or m.group(2))
            if name and name not in names:
                names.append(name)
        if len(names) >= 18:
            break
    return names


def main() -> None:
    if not LOG.is_file():
        print("FMRL private diagnostic: no retained direct-suite receipt")
        return
    text = LOG.read_text(errors="replace")
    if "Direct CI failed:" not in text:
        print("FMRL private diagnostic: no failing portable script")
        return
    repo = os.environ.get("FMRL_TARGET_REPOSITORY", "")
    ref = os.environ.get("FMRL_TARGET_REF", "")
    branch = os.environ.get("FMRL_TARGET_BRANCH", "")
    token = os.environ.get("FMRL_DIAGNOSTIC_WRITE_TOKEN", "")
    if not re.fullmatch(r"dinilmusick/[A-Za-z0-9_.-]+", repo):
        raise RuntimeError("Target identity not in authorized repository scope")
    if not re.fullmatch(r"[a-f0-9]{40}", ref):
        raise RuntimeError("Missing exact reviewed commit")
    if not re.fullmatch(r"[A-Za-z0-9_./-]{1,180}", branch) or ".." in branch or not token:
        raise RuntimeError("Missing secure private PR writeback metadata")
    prs = api("/repos/" + repo + "/pulls?state=open&per_page=100", token)
    matches = [
        p for p in prs if p.get("head", {}).get("sha") == ref
        and p.get("head", {}).get("ref") == branch
        and p.get("head", {}).get("repo", {}).get("full_name") == repo
    ]
    if len(matches) != 1:
        raise RuntimeError("Private PR head changed or could not be uniquely resolved")
    gate = re.search(r"Direct CI failed: ([A-Za-z0-9:._-]+) exit=\d+", text)
    labels = extract(text)
    summary = [
        "**ATAX FMRL private test diagnostics**",
        "",
        "- Exact commit: " + ref,
        "- Failing gate: " + (gate.group(1) if gate else "unknown"),
        "- Failing test labels (sanitized; maximum 18):",
    ]
    summary += ["  - " + item for item in labels] if labels else ["  - No standard test labels detected"]
    summary += ["", "Only bounded test labels are retained here; raw private CI logs remain in the ephemeral runner."]
    api("/repos/" + repo + "/issues/" + str(matches[0]["number"]) + "/comments",
        token, "POST", {"body": "\n".join(summary)})
    print("FMRL private diagnostic: saved to authorized private PR")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print raw log content, path, repo, token, or server error body.
        print("FMRL private diagnostic unavailable (gate denied)", file=sys.stderr)
        sys.exit(1)
    finally:
        LOG.unlink(missing_ok=True)
