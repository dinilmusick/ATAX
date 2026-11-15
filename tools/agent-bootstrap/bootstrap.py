#!/usr/bin/env python3
"""Deterministic ATAX bootstrap and local execution preflight."""
from __future__ import annotations
import argparse, json, shutil, subprocess, sys
from pathlib import Path

WORKSPACE_URL = "https://github.com/dinilmusick/ATAX.git"

def run(command, cwd=None):
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)

def command_exists(name): return shutil.which(name) is not None

def repo_root(path):
    result = run(["git", "rev-parse", "--show-toplevel"], path)
    return Path(result.stdout.strip()) if result.returncode == 0 else None

def build_commands(root):
    commands = []
    package = root / "package.json"
    if package.exists():
        try:
            data = json.loads(package.read_text())
            scripts = data.get("scripts", {})
            for name in ("build", "typecheck", "lint", "test"):
                if name in scripts: commands.append(["npm", "run", name])
        except (OSError, json.JSONDecodeError):
            pass
    for candidate in ("build.sh", "build.py", "Makefile"):
        if (root / candidate).exists():
            commands.append(["bash", candidate] if candidate == "build.sh" else
                            [sys.executable, candidate] if candidate == "build.py" else ["make"])
    return commands

def plan(args):
    detected_root = repo_root(Path.cwd())
    root = detected_root or Path.cwd()
    workspace = Path(args.workspace).expanduser().resolve()
    result = {
        "workspace_repo": "dinilmusick/ATAX",
        "workspace_path": str(workspace),
        "workspace_present": workspace.exists(),
        "current_repository": str(detected_root) if detected_root else None,
        "git_available": command_exists("git"),
        "target_repository": args.repository,
        "target_ref": args.ref,
        "local_runtime": True,
        "build_commands": build_commands(root),
        "next": []
    }
    if not result["git_available"]:
        result["next"].append("Install git or use the ATAX GitHub Actions fallback.")
    elif not workspace.exists():
        result["next"].append("Clone ATAX into this runtime before repository work.")
    if args.repository:
        result["next"].append("Use ATAX private-repository tooling; never run CI directly in the private target.")
    if result["build_commands"]:
        result["next"].append("Run every discovered repository build/quality script before completion.")
    result["next"].append("Capture command output as evidence and independently verify resulting behavior.")
    print(json.dumps(result, indent=2)); return 0

def prepare(args):
    if not command_exists("git"):
        print("ERROR: git is required for local bootstrap.", file=sys.stderr); return 2
    workspace = Path(args.workspace).expanduser().resolve()
    workspace.parent.mkdir(parents=True, exist_ok=True)
    if not (workspace / ".git").exists():
        result = run(["git", "clone", "--depth", "1", "--branch", "main", WORKSPACE_URL, str(workspace)])
        if result.returncode:
            print(result.stderr, file=sys.stderr); return result.returncode
    if args.repository:
        print("Private targets must be accessed through ATAX private-repository tooling; direct target cloning is disabled.", file=sys.stderr)
        return 4
    print(json.dumps({"workspace":str(workspace),"target":None}, indent=2))
    return 0

def main():
    parser = argparse.ArgumentParser(description="Bootstrap ATAX for local agent execution.")
    sub = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--workspace", default=".atax")
    common.add_argument("--repository")
    common.add_argument("--ref", default="main")
    common.add_argument("--target-path")
    for name, func in (("plan", plan), ("prepare", prepare)):
        p = sub.add_parser(name, parents=[common]); p.set_defaults(func=func)
    args = parser.parse_args()
    return args.func(args)

if ( __name__ == "__main__"):
    raise SystemExit(main())
