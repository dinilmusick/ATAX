#!/usr/bin/env python3
"""Plan/prepare container-first target work. ATAX is tooling, never the target runner."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def run(command, cwd=None):
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)


def repo_root(path):
    result = run(["git", "rev-parse", "--show-toplevel"], path)
    return Path(result.stdout.strip()) if result.returncode == 0 else None


def build_commands(root):
    commands = []
    package = root / "package.json"
    if package.exists():
        try:
            scripts = json.loads(package.read_text()).get("scripts", {})
            for name in ("build", "typecheck", "lint", "test"):
                if name in scripts:
                    commands.append(["npm", "run", name])
        except (OSError, ValueError, AttributeError):
            pass
    for candidate in ("build.sh", "build.py", "Makefile"):
        if (root / candidate).exists():
            commands.append(
                ["bash", candidate] if candidate == "build.sh"
                else [sys.executable, candidate] if candidate == "build.py"
                else ["make"]
            )
    return commands


def plan(args):
    current = repo_root(Path.cwd())
    workspace = Path(args.workspace).expanduser().resolve()
    root = (workspace if (workspace / ".git").exists() else current) or Path.cwd()
    instructions = []
    if not shutil.which("git"):
        instructions.append("No local git: use FMRL disposable public runner via ATAX provisioning tools.")
    elif args.repository and not (workspace / ".git").exists():
        instructions.append("Clone the TARGET directly into the agent container; do NOT clone ATAX as workspace.")
    if args.repository:
        instructions.append("If target checkout/runtime is inaccessible or remote CI is required: provision FMRL-* through ATAX tools.")
    instructions.append("Collect evidence, independently verify, and delete+verify absence of any FMRL fallback.")
    print(json.dumps({
        "execution_order": ["agent-container", "disposable-FMRL-public-runner"],
        "atax_role": "control-plane-and-tools-only",
        "target_repository": args.repository,
        "ref": args.ref,
        "target_path": str(workspace),
        "target_present": (workspace / ".git").exists(),
        "git_available": shutil.which("git") is not None,
        "build_commands": build_commands(root),
        "next": instructions,
    }, indent=2))
    return 0


def prepare(args):
    if not args.repository or not REPOSITORY.fullmatch(args.repository):
        print("ERROR: --repository must be owner/name", file=sys.stderr)
        return 2
    if not shutil.which("git"):
        print("ERROR: git unavailable; provision disposable FMRL through ATAX control plane.", file=sys.stderr)
        return 4
    workspace = Path(args.workspace).expanduser().resolve()
    if (workspace / ".git").exists():
        print("Target path is already a repository; refusing to overwrite it.", file=sys.stderr)
        return 2
    if workspace.exists() and any(workspace.iterdir()):
        print("Target directory is not empty; refusing to overwrite it.", file=sys.stderr)
        return 2
    workspace.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["git", "clone", "--no-single-branch"]
    if args.ref:
        cmd.extend(["--branch", args.ref])
    cmd.extend(["https://github.com/" + args.repository + ".git", str(workspace)])
    result = run(cmd)
    if result.returncode:
        print("Target clone unavailable. Use ATAX FMRL provisioning; never use ATAX as a workspace.",
              file=sys.stderr)
        return 4
    print(json.dumps({"target_repository": args.repository,
                      "target_path": str(workspace),
                      "mode": "agent-container"}, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description="Container-first ATAX target execution preflight.")
    sub = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--workspace", default=".target-workspace")
    common.add_argument("--repository")
    common.add_argument("--ref", default="")
    for name, func in (("plan", plan), ("prepare", prepare)):
        sub.add_parser(name, parents=[common]).set_defaults(func=func)
    return parser.parse_args().func(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
