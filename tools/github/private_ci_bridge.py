#!/usr/bin/env python3
"""Run private-repository verification through an ephemeral public GitHub compute bridge.

Credential flow:
1. Create a disposable public repository containing only a workflow and this runner.
2. The public runner generates a one-time RSA keypair and publishes the public key.
3. This client encrypts the repository-read token and uploads only ciphertext.
4. The runner decrypts the token locally, clones the private source at runtime,
   removes the credential from Git configuration, executes bounded commands,
   deletes its checkout and local secrets, and publishes a sanitized result.
5. This client deletes the public bridge repository and verifies deletion.

No Actions repository secret or Actions-write permission is required.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from urllib import error, request

API_ROOT = "https://api.github.com"
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atax-private-ci-public-key-bridge",
}

WORKFLOW = "name: ATAX Private CI Bridge\n\non:\n  push:\n    branches: [main]\n    paths:\n      - \".atax/request.json\"\n\npermissions:\n  contents: write\n\njobs:\n  private-ci:\n    runs-on: ubuntu-latest\n    timeout-minutes: 55\n    steps:\n      - name: Checkout ephemeral bridge controls\n        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n        with:\n          persist-credentials: true\n\n      - name: Execute encrypted private-repository verification\n        shell: bash\n        run: python3 .atax/runner.py\n"
RUNNER = "import json\nimport os\nimport re\nimport subprocess\nimport sys\nimport tempfile\nimport time\nimport urllib.error\nimport urllib.request\nfrom pathlib import Path\n\ndef raw_bytes(url):\n    req = urllib.request.Request(url, headers={\"Cache-Control\": \"no-cache\", \"User-Agent\": \"ATAX-private-ci-bridge\"})\n    try:\n        with urllib.request.urlopen(req, timeout=20) as response:\n            return response.read()\n    except urllib.error.HTTPError as error:\n        if error.code == 404:\n            return None\n        raise\n\ndef quiet_run(args, **kwargs):\n    return subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)\n\ndef publish_result(challenge_id, branch, repository, ref, workflow, exit_code, summary):\n    result = {\n        \"challenge_id\": challenge_id,\n        \"repository\": repository,\n        \"ref\": ref,\n        \"workflow\": workflow,\n        \"status\": \"success\" if exit_code == 0 else \"failure\",\n        \"exit_code\": int(exit_code),\n        \"summary\": summary,\n        \"source_published\": False,\n        \"credential_secret_created\": False,\n    }\n    try:\n        quiet_run([\"git\", \"fetch\", \"origin\", branch], check=True, timeout=60)\n        quiet_run([\"git\", \"reset\", \"--hard\", f\"origin/{branch}\"], check=True, timeout=60)\n        for path in [\n            Path(f\".atax/key-{challenge_id}.pem\"),\n            Path(f\".atax/credential-{challenge_id}.enc\"),\n        ]:\n            try:\n                path.unlink()\n            except FileNotFoundError:\n                pass\n        Path(f\".atax/result-{challenge_id}.json\").write_text(json.dumps(result, indent=2) + \"\\n\")\n        quiet_run([\"git\", \"add\", \"-A\", \".atax\"], check=True, timeout=60)\n        quiet_run([\"git\", \"commit\", \"-m\", f\"chore: record private CI result {challenge_id}\"], check=True, timeout=60)\n        quiet_run([\"git\", \"push\", \"origin\", f\"HEAD:{branch}\"], check=True, timeout=120)\n    except Exception:\n        # Never print credential-related subprocess diagnostics into a public workflow log.\n        print(\"ATAX bridge could not publish its result record.\", flush=True)\n\ndef execute(request, challenge_id, temp_dir):\n    repository = str(request[\"repository\"])\n    ref = str(request.get(\"ref\") or \"main\")\n    workflow = str(request[\"workflow\"])\n    commands = request[\"commands\"]\n    timeout_seconds = int(request.get(\"timeout_seconds\", 1800))\n    branch = os.environ.get(\"GITHUB_REF_NAME\", \"main\")\n    stage = \"key-generation\"\n\n    private_key = temp_dir / \"private.pem\"\n    public_key = temp_dir / \"public.pem\"\n    subprocess.run(\n        [\"openssl\", \"genpkey\", \"-algorithm\", \"RSA\", \"-pkeyopt\", \"rsa_keygen_bits:3072\", \"-out\", str(private_key)],\n        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60,\n    )\n    subprocess.run(\n        [\"openssl\", \"pkey\", \"-in\", str(private_key), \"-pubout\", \"-out\", str(public_key)],\n        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60,\n    )\n    key_path = Path(f\".atax/key-{challenge_id}.pem\")\n    key_path.write_bytes(public_key.read_bytes())\n    quiet_run([\"git\", \"add\", str(key_path)], check=True, timeout=60)\n    quiet_run([\"git\", \"commit\", \"-m\", f\"chore: publish one-time CI public key {challenge_id}\"], check=True, timeout=60)\n    quiet_run([\"git\", \"push\", \"origin\", f\"HEAD:{branch}\"], check=True, timeout=120)\n\n    stage = \"credential-delivery\"\n    encrypted = temp_dir / \"credential.enc\"\n    credential_url = (\n        f\"https://raw.githubusercontent.com/{os.environ['GITHUB_REPOSITORY']}/{branch}/\"\n        f\".atax/credential-{challenge_id}.enc\"\n    )\n    for _ in range(180):\n        payload = raw_bytes(credential_url + f\"?v={time.time_ns()}\")\n        if payload:\n            encrypted.write_bytes(payload)\n            break\n        time.sleep(2)\n    if not encrypted.exists():\n        raise RuntimeError(\"Credential delivery timed out.\")\n\n    stage = \"credential-decryption\"\n    token_file = temp_dir / \"private-token\"\n    subprocess.run(\n        [\n            \"openssl\", \"pkeyutl\", \"-decrypt\", \"-inkey\", str(private_key),\n            \"-in\", str(encrypted), \"-out\", str(token_file),\n            \"-pkeyopt\", \"rsa_padding_mode:oaep\", \"-pkeyopt\", \"rsa_oaep_md:sha256\",\n        ],\n        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60,\n    )\n    token = token_file.read_text().strip()\n    if not token:\n        raise RuntimeError(\"Decrypted credential is empty.\")\n\n    stage = \"private-checkout\"\n    target = Path(\"target\")\n    if target.exists():\n        subprocess.run([\"rm\", \"-rf\", str(target)], check=True, timeout=60)\n    clone = subprocess.run(\n        [\n            \"git\", \"-c\", f\"http.extraheader=AUTHORIZATION: bearer {token}\",\n            \"clone\", \"--depth\", \"1\", \"--branch\", ref,\n            f\"https://github.com/{repository}.git\", str(target),\n        ],\n        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300,\n    )\n    token = \"\"\n    if clone.returncode:\n        raise RuntimeError(f\"Private checkout failed (exit code {clone.returncode}).\")\n    quiet_run([\"git\", \"-C\", str(target), \"remote\", \"set-url\", \"origin\", f\"https://github.com/{repository}.git\"], check=True)\n    quiet_run([\"git\", \"-C\", str(target), \"config\", \"--unset-all\", \"http.https://github.com/.extraheader\"], check=False)\n\n    stage = \"verification\"\n    workflow_file = target / \".github\" / \"workflows\" / workflow\n    if not workflow_file.is_file():\n        raise RuntimeError(\"Requested verification workflow was not found.\")\n    log_dir = temp_dir / \"command-logs\"\n    log_dir.mkdir()\n    for index, command in enumerate(commands, start=1):\n        log_path = log_dir / f\"command-{index}.log\"\n        with log_path.open(\"wb\") as output:\n            result = subprocess.run(\n                [\"bash\", \"-lc\", command],\n                cwd=target,\n                stdout=output,\n                stderr=subprocess.STDOUT,\n                timeout=timeout_seconds,\n            )\n        if result.returncode:\n            raise RuntimeError(f\"Verification command {index} failed (exit code {result.returncode}).\")\n        print(f\"ATAX verification command {index}/{len(commands)} passed.\", flush=True)\n    return 0, \"All requested verification commands passed.\"\n\ndef main():\n    challenge_id = \"\"\n    request = {}\n    result_code = 1\n    summary = \"Private CI bridge did not complete.\"\n    stage = \"request-validation\"\n    temp_dir = Path(tempfile.mkdtemp(prefix=\"atax-private-ci-\"))\n    try:\n        request = json.loads(Path(\".atax/request.json\").read_text())\n        challenge_id = str(request.get(\"challenge_id\", \"\"))\n        if not re.fullmatch(r\"[a-f0-9]{32}\", challenge_id):\n            raise RuntimeError(\"Invalid bridge challenge identifier.\")\n        if not re.fullmatch(r\"[^/]+/[^/]+\", str(request.get(\"repository\", \"\"))):\n            raise RuntimeError(\"Invalid private repository identity.\")\n        if not re.fullmatch(r\"[^/]+\\\\.ya?ml\", str(request.get(\"workflow\", \"\"))):\n            raise RuntimeError(\"Invalid workflow filename.\")\n        commands = request.get(\"commands\")\n        if not isinstance(commands, list) or not commands or len(commands) > 30:\n            raise RuntimeError(\"Verification command list is invalid.\")\n        if any(not isinstance(item, str) or not item.strip() for item in commands):\n            raise RuntimeError(\"Verification commands must be non-empty strings.\")\n        if sum(len(item) for item in commands) > 20000:\n            raise RuntimeError(\"Verification command payload is too large.\")\n        result_code, summary = execute(request, challenge_id, temp_dir)\n    except Exception as error:\n        summary = f\"Private CI bridge failed during {stage}: {type(error).__name__}.\"\n        result_code = 1\n        print(summary, flush=True)\n    finally:\n        if challenge_id:\n            try:\n                publish_result(\n                    challenge_id,\n                    os.environ.get(\"GITHUB_REF_NAME\", \"main\"),\n                    str(request.get(\"repository\", \"\")),\n                    str(request.get(\"ref\") or \"main\"),\n                    str(request.get(\"workflow\", \"\")),\n                    result_code,\n                    summary,\n                )\n            except Exception:\n                print(\"ATAX bridge cleanup/result publication failed.\", flush=True)\n        subprocess.run([\"rm\", \"-rf\", \"target\", str(temp_dir)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n    return result_code\n\nif __name__ == \"__main__\":\n    raise SystemExit(main())\n"

def bearer_token() -> str:
    value = os.environ.get("CODING_REPO_TOKEN") or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not value:
        raise SystemExit("Missing CODING_REPO_TOKEN, GITHUB_TOKEN or GH_TOKEN.")
    return value

def api(path: str, token: str, method: str = "GET", payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = request.Request(
        API_ROOT + path,
        data=body,
        method=method,
        headers={**HEADERS, "Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            if response.status == 204:
                return None
            return json.load(response)
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {path} failed with HTTP {exc.code}: {detail}") from exc

def raw_text(url: str) -> str | None:
    req = request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": HEADERS["User-Agent"]})
    try:
        with request.urlopen(req, timeout=20) as response:
            return response.read().decode("utf-8")
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise

def put_file(token: str, repository: str, path: str, content: bytes, message: str):
    return api(f"/repos/{repository}/contents/{path}", token, "PUT", {
        "message": message,
        "content": base64.b64encode(content).decode("ascii"),
        "branch": "main",
    })

def encrypt_credential(token: str, public_key: str, directory: str) -> bytes:
    key_path = os.path.join(directory, "public.pem")
    plain_path = os.path.join(directory, "token")
    cipher_path = os.path.join(directory, "credential.enc")
    with open(key_path, "w", encoding="utf-8") as stream:
        stream.write(public_key)
    os.chmod(key_path, 0o600)
    with open(plain_path, "w", encoding="utf-8") as stream:
        stream.write(token)
    os.chmod(plain_path, 0o600)
    subprocess.run([
        "openssl", "pkeyutl", "-encrypt", "-pubin", "-inkey", key_path,
        "-in", plain_path, "-out", cipher_path,
        "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256",
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    with open(cipher_path, "rb") as stream:
        cipher = stream.read()
    for path in (plain_path, key_path, cipher_path):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    return cipher

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="Private source repository owner/name.")
    parser.add_argument("--target", required=True, help="Disposable public repository name.")
    parser.add_argument("--ref", required=True, help="Private source branch, tag or commit.")
    parser.add_argument("--workflow", required=True, help="Workflow filename inside the private source repository.")
    parser.add_argument("--command", action="append", required=True, help="Verification command (repeat for multiple steps).")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()

    if not re.fullmatch(r"[^/]+/[^/]+", args.source):
        raise SystemExit("--source must be owner/name.")
    if "/" in args.target or not re.fullmatch(r"[A-Za-z0-9_.-]+", args.target):
        raise SystemExit("--target must be a repository name.")
    if not re.fullmatch(r"[^/]+\.ya?ml", args.workflow):
        raise SystemExit("--workflow must be a workflow filename.")
    if not args.command or len(args.command) > 30 or any(not command.strip() for command in args.command):
        raise SystemExit("At least one non-empty verification command is required (maximum 30).")
    if sum(len(command) for command in args.command) > 20000:
        raise SystemExit("Verification command payload exceeds 20,000 characters.")
    if not (1 <= args.timeout_seconds <= 3600):
        raise SystemExit("--timeout-seconds must be between 1 and 3600.")

    token = bearer_token()
    source = api(f"/repos/{args.source}", token)
    if source.get("private") is not True:
        raise SystemExit("Source repository must be private.")
    bridge_name = args.target
    bridge_repo = ""
    challenge = uuid.uuid4().hex
    temp_dir = tempfile.mkdtemp(prefix="atax-private-ci-client-")
    result_payload = None
    delete_verified = False

    try:
        created = api("/user/repos", token, "POST", {
            "name": bridge_name,
            "description": "Ephemeral ATAX public CI compute bridge. Contains no private source.",
            "private": False,
            "auto_init": True,
        })
        bridge_repo = created["full_name"]
        verified_repo = api(f"/repos/{bridge_repo}", token)
        if verified_repo.get("private") is not False:
            raise RuntimeError("Disposable bridge repository is not public as required.")

        put_file(token, bridge_repo, ".github/workflows/atax-private-ci.yml", WORKFLOW.encode(), "chore: add ephemeral ATAX CI bridge workflow")
        put_file(token, bridge_repo, ".atax/runner.py", RUNNER.encode(), "chore: add ephemeral ATAX CI bridge runner")
        payload = {
            "challenge_id": challenge,
            "repository": args.source,
            "ref": args.ref,
            "workflow": args.workflow,
            "commands": args.command,
            "timeout_seconds": args.timeout_seconds,
        }
        put_file(token, bridge_repo, ".atax/request.json", json.dumps(payload, indent=2).encode(), "chore: request one-time private CI verification")

        raw_root = f"https://raw.githubusercontent.com/{bridge_repo}/main/.atax"
        public_key = None
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            public_key = raw_text(f"{raw_root}/key-{challenge}.pem?v={time.time_ns()}")
            if public_key and "BEGIN PUBLIC KEY" in public_key:
                break
            time.sleep(3)
        if not public_key or "BEGIN PUBLIC KEY" not in public_key:
            raise RuntimeError("The public compute runner did not publish its one-time public key.")

        ciphertext = encrypt_credential(token, public_key, temp_dir)
        put_file(token, bridge_repo, f".atax/credential-{challenge}.enc", ciphertext, "chore: provide encrypted one-time clone credential")

        deadline = time.monotonic() + args.timeout_seconds + 600
        while time.monotonic() < deadline:
            result_text = raw_text(f"{raw_root}/result-{challenge}.json?v={time.time_ns()}")
            if result_text:
                result_payload = json.loads(result_text)
                if result_payload.get("challenge_id") != challenge:
                    raise RuntimeError("Bridge result challenge does not match this request.")
                break
            time.sleep(5)
        if result_payload is None:
            raise TimeoutError("Disposable public CI bridge did not return a result before timeout.")

    finally:
        if bridge_repo:
            try:
                api(f"/repos/{bridge_repo}", token, "DELETE")
                try:
                    api(f"/repos/{bridge_repo}", token)
                except RuntimeError as exc:
                    if "HTTP 404" in str(exc) or "Not Found" in str(exc):
                        delete_verified = True
                    else:
                        raise
            except Exception:
                delete_verified = False
        shutil.rmtree(temp_dir, ignore_errors=True)

    if not delete_verified:
        raise RuntimeError(f"Disposable bridge cleanup was not verified for {bridge_repo}.")
    if result_payload is None:
        raise RuntimeError("Bridge was deleted, but no execution result was returned.")
    output = {
        "bridge_repository": bridge_repo,
        "source_repository": args.source,
        "ref": args.ref,
        "workflow": args.workflow,
        "status": result_payload.get("status"),
        "exit_code": result_payload.get("exit_code"),
        "summary": result_payload.get("summary"),
        "source_published": result_payload.get("source_published", False),
        "credential_secret_created": result_payload.get("credential_secret_created", False),
        "bridge_deleted": delete_verified,
    }
    print(json.dumps(output, indent=2))
    return 0 if output["status"] == "success" and output["exit_code"] == 0 else 1

if __name__ == "__main__":
    raise SystemExit(main())
