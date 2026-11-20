"""FMRL lifecycle contract tests: no remote calls or real repositories."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fmrl_disposable", ROOT / "disposable_workspace.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FmrlTests(unittest.TestCase):
    def test_controller_preserves_failure_step_names_before_disposable_cleanup(self):
        controller = (ROOT / ".." / ".." / ".github" / "workflows" / "private-repo-ci.yml").read_text()
        failure_step = 'select(.conclusion == "failure")'
        self.assertIn('actions/runs/$run_id/jobs?per_page=100', controller)
        self.assertIn(failure_step, controller)
        self.assertIn('"Failed step: "', controller)
        self.assertLess(controller.index('actions/runs/$run_id/jobs?per_page=100'),
                        controller.index('name: ALWAYS delete FMRL and verify absence'))

    def test_secret_scan_covers_checked_out_head_history_not_other_branches(self):
        security = (ROOT / ".." / ".." / ".github" / "workflows" / "security-gates.yml").read_text()
        scan = next(line.strip() for line in security.splitlines() if "gitleaks git" in line)
        self.assertIn('--log-opts="--full-history HEAD"', scan)
        self.assertNotIn("--all", scan)
        self.assertIn("--redact", scan)
        self.assertIn("--exit-code 1", scan)

    def test_controller_dispatch_uses_actions_write_credential(self):
        controller = (ROOT / ".." / ".." / ".github" / "workflows" / "private-repo-ci.yml").read_text()
        dispatch = controller.split(
            "      - name: Dispatch FMRL runner and independently inspect result"
        )[1].split("      - name: ALWAYS delete FMRL and verify absence")[0]
        self.assertIn("GH_TOKEN: ${{ secrets.FMRL_DISPATCH_TOKEN || secrets.FMRL_SECRETS_TOKEN }}", dispatch)
        self.assertIn("using one-shot Contents:write push trigger", dispatch)
        self.assertNotIn("GH_TOKEN: ${{ secrets.CODING_REPO_TOKEN }}", dispatch)

    def test_runner_only_uses_clone_token_in_clone_step(self):
        workflow = MODULE.WORKFLOW
        clone = workflow.split("      - name: Clone private target at runtime")[1].split(
            "      - name: Install pinned act")[0]
        execute = workflow.split("      - name: Execute target workflow")[1].split(
            "      - name: Remove private checkout")[0]
        self.assertIn("PRIVATE_REPO_TOKEN", clone)
        self.assertIn("GIT_ASKPASS", clone)
        self.assertIn("x-access-token", clone)
        self.assertIn("credential.helper=", clone)
        self.assertIn("trap 'rm -f", clone)
        self.assertIn('/tmp/fmrl-clone-private.log', clone)
        self.assertIn('FMRL exact private SHA verified without exposing its value', clone)
        self.assertNotIn('echo "FMRL checked out exact target commit:', clone)
        self.assertNotIn('AUTHORIZATION: bearer', clone)
        self.assertNotIn('https://x-access-token:', clone)
        self.assertIn('"--bind" "--directory" "$PWD"', execute)
        self.assertIn("test -d .git", execute)
        self.assertNotIn("PRIVATE_REPO_TOKEN", execute)
        self.assertNotIn("--secret", execute)
        self.assertIn('>/tmp/fmrl-nested-raw.log 2>&1', execute)
        self.assertIn('raw target output suppressed', execute)
        self.assertIn('rm -f /tmp/fmrl-nested-raw.log', execute)
        self.assertNotIn('cat /tmp/fmrl-nested-raw.log', execute)
        self.assertNotIn("upload-artifact", workflow)
        self.assertNotIn("%%TARGET_SOURCE%%", workflow)
        self.assertIn("secrets.FMRL_TARGET_REPOSITORY", workflow)
        self.assertIn("secrets.FMRL_TARGET_REF", workflow)
        self.assertIn("test ! -e target", workflow)
        cleanup = workflow.split("      - name: Remove private checkout")[1]
        self.assertIn("sudo rm -rf -- target", cleanup)
        self.assertIn("if: always()", cleanup)

    def test_provision_uses_separate_private_read_token_and_fmrl_prefix(self):
        calls = []

        def fake_api(path, bearer, method="GET", payload=None):
            calls.append((path, bearer, method, payload))
            if path == "/repos/dinilmusick/KONE":
                return {"private": True, "default_branch": "develop"}
            if path == "/user/repos":
                return {"full_name": "dinilmusick/FMRL-unit-test"}
            if path == "/repos/dinilmusick/FMRL-unit-test":
                return {"private": False, "html_url": "https://github.com/dinilmusick/FMRL-unit-test"}
            return None

        with mock.patch.object(MODULE, "api", side_effect=fake_api), \
             mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/gh"), \
             mock.patch.object(MODULE.subprocess, "run") as run, \
             mock.patch.dict(MODULE.os.environ, {
                 "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
                 "FMRL_SECRETS_TOKEN": "secret-writer",
             }), \
             mock.patch.object(sys, "argv", ["disposable_workspace.py",
                                               "--source", "dinilmusick/KONE",
                                               "--target", "FMRL-unit-test", "--ref", "a"*40]), \
             contextlib.redirect_stdout(io.StringIO()) as stream:
            self.assertEqual(MODULE.main(), 0)
            payload = json.loads(stream.getvalue())
            self.assertEqual(payload["disposable_repository"], "dinilmusick/FMRL-unit-test")
            self.assertEqual(payload["default_ref"], "develop")
            self.assertTrue(payload["public"])
            self.assertFalse(payload["private_source_published"])

        self.assertEqual(calls[0][:3], ("/repos/dinilmusick/KONE", "source-read", "GET"))
        self.assertEqual(calls[1][1], "management")
        workflow_payload = calls[2][3]
        import base64
        workflow = base64.b64decode(workflow_payload["content"]).decode()
        self.assertNotIn("dinilmusick/KONE", workflow)
        self.assertNotIn("develop", workflow)
        self.assertNotIn("a"*40, workflow)
        self.assertNotIn("%%TARGET_SOURCE%%", workflow)
        self.assertEqual(run.call_args_list[0].kwargs["input"], "source-read")
        self.assertEqual(run.call_count, 6)
        self.assertEqual([item.args[0][3] for item in run.call_args_list],
                         ["PRIVATE_REPO_TOKEN","FMRL_TARGET_REPOSITORY","FMRL_TARGET_REF",
                          "FMRL_TARGET_EVENT","FMRL_TARGET_WORKFLOW","FMRL_EXECUTION_MODE"])
        self.assertEqual([item.kwargs["input"] for item in run.call_args_list],
                         ["source-read","dinilmusick/KONE","a"*40,"push","-","direct"])
        self.assertEqual(run.call_args.kwargs["env"]["GH_TOKEN"], "secret-writer")
        self.assertNotEqual(run.call_args.kwargs["env"]["GH_TOKEN"], "management")
        self.assertNotIn("CODING_REPO_TOKEN", run.call_args.kwargs["env"])
        self.assertNotIn("PRIVATE_REPO_TOKEN", run.call_args.kwargs["env"])
        self.assertNotIn("FMRL_SECRETS_TOKEN", run.call_args.kwargs["env"])
        self.assertNotIn("--body", run.call_args.args[0])

    def test_missing_dedicated_secrets_token_fails_before_creating_repository(self):
        with mock.patch.object(MODULE, "api") as api, \
             mock.patch.dict(MODULE.os.environ, {
                 "CODING_REPO_TOKEN": "management",
                 "PRIVATE_REPO_TOKEN": "source-read",
             }, clear=True), \
             mock.patch.object(sys, "argv", [
                 "disposable_workspace.py",
                 "--source", "dinilmusick/KONE",
                 "--target", "FMRL-unit-test",
             ]):
            with self.assertRaisesRegex(SystemExit, "Missing FMRL_SECRETS_TOKEN"):
                MODULE.main()
            api.assert_not_called()

    def test_secrets_token_is_not_confused_with_repo_management_token(self):
        with mock.patch.dict(MODULE.os.environ, {
            "CODING_REPO_TOKEN": "management",
            "FMRL_SECRETS_TOKEN": "secret-writer",
        }, clear=True):
            self.assertEqual(MODULE.token(), "management")
            self.assertEqual(MODULE.secrets_token(), "secret-writer")

    def test_rejects_atax_as_target_without_creating_repository(self):
        with mock.patch.object(MODULE, "api") as api, \
             mock.patch.dict(MODULE.os.environ, {
                 "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
                 "FMRL_SECRETS_TOKEN": "secret-writer",
             }), mock.patch.object(sys, "argv", [
                 "disposable_workspace.py", "--source", "dinilmusick/ATAX"]):
            with self.assertRaises(SystemExit):
                MODULE.main()
            api.assert_not_called()

    def test_rejects_non_fmrl_repository_name(self):
        with mock.patch.dict(MODULE.os.environ, {
            "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
                 "FMRL_SECRETS_TOKEN": "secret-writer",
        }), mock.patch.object(sys, "argv", [
            "disposable_workspace.py", "--source", "dinilmusick/KONE",
            "--target", "ATAX-as-runner"]):
            with self.assertRaises(SystemExit):
                MODULE.main()


    def test_transient_secret_provision_failure_retries_without_leaking_token(self):
        def fake_api(path, bearer, method="GET", payload=None):
            if path == "/repos/dinilmusick/KONE":
                return {"private": True, "default_branch": "main"}
            if path == "/user/repos":
                return {"full_name": "dinilmusick/FMRL-unit-test"}
            if path == "/repos/dinilmusick/FMRL-unit-test":
                return {"private": False, "html_url": "https://github.com/dinilmusick/FMRL-unit-test"}
            return None

        transient = MODULE.subprocess.CalledProcessError(
            1, ["gh", "secret", "set"], stderr="secret endpoint not ready"
        )
        with mock.patch.object(MODULE, "api", side_effect=fake_api), \
             mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/gh"), \
             mock.patch.object(MODULE.subprocess, "run", side_effect=lambda *a, **k: (_ for _ in ()).throw(transient) if len(run.call_args_list) == 1 else mock.Mock(returncode=0)) as run, \
             mock.patch.object(MODULE.time, "sleep") as sleep, \
             mock.patch.dict(MODULE.os.environ, {
                 "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
                 "FMRL_SECRETS_TOKEN": "secret-writer",
             }), \
             mock.patch.object(sys, "argv", ["disposable_workspace.py",
                                            "--source", "dinilmusick/KONE",
                                            "--target", "FMRL-unit-test", "--ref", "a"*40]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(MODULE.main(), 0)
        self.assertEqual(run.call_count, 7)
        sleep.assert_called_once_with(3)


    def test_permanent_secret_permission_error_fails_fast_and_verifies_cleanup(self):
        def fake_api(path, bearer, method="GET", payload=None):
            if path == "/repos/dinilmusick/KONE":
                return {"private": True, "default_branch": "main"}
            if path == "/user/repos":
                return {"full_name": "dinilmusick/FMRL-unit-test"}
            if path == "/repos/dinilmusick/FMRL-unit-test":
                return {"private": False, "html_url": "https://github.com/dinilmusick/FMRL-unit-test"}
            return None

        forbidden = MODULE.subprocess.CalledProcessError(
            1, ["gh", "secret", "set"],
            stderr="HTTP 403: Resource not accessible by personal access token"
        )
        with (
            mock.patch.object(MODULE, "api", side_effect=fake_api) as api,
            mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/gh"),
            mock.patch.object(MODULE.subprocess, "run", side_effect=forbidden) as run,
            mock.patch.object(MODULE, "verify_deleted_public_bridge") as verified,
            mock.patch.object(MODULE.time, "sleep") as sleep,
            mock.patch.dict(MODULE.os.environ, {
                "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
                 "FMRL_SECRETS_TOKEN": "secret-writer",
            }),
            mock.patch.object(sys, "argv", ["disposable_workspace.py",
                                           "--source", "dinilmusick/KONE",
                                           "--target", "FMRL-unit-test", "--ref", "a"*40]),
        ):
            with self.assertRaisesRegex(RuntimeError, "Secrets: write"):
                MODULE.main()
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()
        verified.assert_called_once_with("dinilmusick/FMRL-unit-test")
        self.assertTrue(any(
            call.args[:3] == ("/repos/dinilmusick/FMRL-unit-test", "management", "DELETE")
            for call in api.call_args_list
        ))

    def test_absence_check_is_anonymous_and_requires_404(self):
        import urllib.error
        not_found = urllib.error.HTTPError(
            "https://api.github.com/repos/dinilmusick/FMRL-unit-test", 404,
            "Not Found", {}, None,
        )
        with mock.patch.object(MODULE.request, "urlopen", side_effect=not_found) as fetch:
            MODULE.verify_deleted_public_bridge("dinilmusick/FMRL-unit-test")
        self.assertNotIn("Authorization", fetch.call_args.args[0].headers)


    def test_fmrl_push_fallback_is_one_shot_and_never_contains_private_source(self):
        workflow = MODULE.WORKFLOW
        self.assertIn("  push:\n    branches: [main]\n    paths: [.fmrl/execute]", workflow)
        self.assertIn("TARGET_REPOSITORY: ${{ secrets.FMRL_TARGET_REPOSITORY }}", workflow)
        self.assertIn("TARGET_REF: ${{ secrets.FMRL_TARGET_REF }}", workflow)
        self.assertIn("TARGET_EVENT: ${{ secrets.FMRL_TARGET_EVENT }}", workflow)
        self.assertIn("TARGET_WORKFLOW: ${{ secrets.FMRL_TARGET_WORKFLOW }}", workflow)
        self.assertNotIn("CODING_REPO_TOKEN", workflow)
        self.assertNotIn("FMRL_SECRETS_TOKEN", workflow)
        controller = (ROOT / ".." / ".." / ".github" / "workflows" / "private-repo-ci.yml").read_text()
        dispatch = controller.split(
            "      - name: Dispatch FMRL runner and independently inspect result"
        )[1].split("      - name: ALWAYS delete FMRL and verify absence")[0]
        self.assertIn('if [[ "$dispatch_error" == *"Resource not accessible by personal access token"* ]]', dispatch)
        self.assertIn('GH_TOKEN="$FMRL_CONTENTS_TOKEN" gh api -X PUT "repos/$BRIDGE/contents/.fmrl/execute"', dispatch)
        self.assertIn("FMRL_CONTENTS_TOKEN: ${{ secrets.CODING_REPO_TOKEN }}", dispatch)
        self.assertIn('registered" == 1', dispatch)
        self.assertNotIn("PRIVATE_REPO_TOKEN", dispatch)
        self.assertIn("repository_lifecycle.py delete --repository", controller)

    def test_push_fallback_rejects_unsafe_target_ref_and_workflow(self):
        for extra in (["--ref", "main'; echo unsafe"], ["--workflow", "ci.yml;bad"]):
            with mock.patch.object(MODULE, "api") as api, \
                 mock.patch.object(sys, "argv", [
                     "disposable_workspace.py", "--source", "dinilmusick/KONE", *extra
                 ]):
                with self.assertRaises(SystemExit):
                    MODULE.main()
                api.assert_not_called()

    def test_push_fallback_embeds_requested_exact_sha(self):
        calls = []
        sha = "a" * 40

        def fake_api(path, bearer, method="GET", payload=None):
            calls.append((path, method, payload))
            if path == "/repos/dinilmusick/KONE":
                return {"private": True, "default_branch": "develop"}
            if path == "/user/repos":
                return {"full_name": "dinilmusick/FMRL-unit-test"}
            if path == "/repos/dinilmusick/FMRL-unit-test":
                return {"private": False, "html_url": "https://github.com/dinilmusick/FMRL-unit-test"}
            return None

        with mock.patch.object(MODULE, "api", side_effect=fake_api), \
             mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/gh"), \
             mock.patch.object(MODULE.subprocess, "run"), \
             mock.patch.dict(MODULE.os.environ, {
                 "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "clone-only",
                 "FMRL_SECRETS_TOKEN": "secret-writer",
             }), \
             mock.patch.object(sys, "argv", ["disposable_workspace.py", "--source",
                                           "dinilmusick/KONE", "--target", "FMRL-unit-test",
                                           "--ref", sha, "--workflow", "ci.yml"]), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(MODULE.main(), 0)
        source = json.loads(output.getvalue())
        self.assertEqual(source["verified_target_ref"], sha)
        import base64
        generated = base64.b64decode(next(call[2]["content"] for call in calls
            if call[0].endswith("atax-private-ci.yml"))).decode()
        self.assertNotIn("dinilmusick/KONE", generated)
        self.assertNotIn(sha, generated)
        self.assertNotIn("ci.yml", generated)
        self.assertNotIn("clone-only", generated)
        self.assertIn("secrets.FMRL_TARGET_REPOSITORY", generated)
        self.assertIn("secrets.FMRL_TARGET_REF", generated)


    def test_direct_suite_is_frozen_fail_closed_and_explicitly_not_full_workflow_parity(self):
        workflow = MODULE.WORKFLOW
        self.assertIn("FMRL_EXECUTION_MODE: ${{ secrets.FMRL_EXECUTION_MODE }}", workflow)
        direct = workflow.split("      - name: Run portable private-suite checks")[1].split(
            "      - name: Remove private checkout")[0]
        self.assertIn("pnpm install --frozen-lockfile", direct)
        self.assertIn("npm ci --include=optional --no-audit --no-fund", direct)
        self.assertIn("scripts.test || !scripts.build", direct)
        self.assertIn("NOT full workflow parity", direct)
        self.assertIn(">/tmp/fmrl-direct-raw.log 2>&1", direct)
        self.assertIn("rm -f /tmp/fmrl-direct-raw.log", direct)
        self.assertNotIn("PRIVATE_REPO_TOKEN", direct)
        self.assertNotIn("upload-artifact", direct)
        self.assertIn("if: env.FMRL_EXECUTION_MODE == 'direct'", workflow)
        self.assertIn("if: env.FMRL_EXECUTION_MODE == 'act'", workflow)
        self.assertIn("sudo rm -rf -- target", workflow)

    def test_direct_mode_is_default_but_legacy_nested_executor_is_explicitly_opt_in(self):
        import inspect
        source = inspect.getsource(MODULE.main)
        self.assertIn('choices=("direct", "act", "repair"), default="direct"', source)
        self.assertIn('("FMRL_EXECUTION_MODE", args.mode)', source)
        self.assertIn('not full workflow parity', source)
        controller = (ROOT / '..' / '..' / '.github' / 'workflows' / 'private-repo-ci.yml').read_text()
        self.assertIn('--mode "$TARGET_MODE" --branch "$TARGET_BRANCH" > /tmp/fmrl.json', controller)
        self.assertIn('no raw source logs or artifacts', controller)
        self.assertIn("assert mode in ('direct','repair')", controller)


    def test_public_bridge_workflow_static_and_no_private_target_in_git(self):
        workflow = MODULE.WORKFLOW
        self.assertNotIn("%%TARGET_", workflow)
        self.assertNotIn("%%DEFAULT_REF", workflow)
        self.assertNotIn("dinilmusick/KONE", workflow)
        self.assertNotIn("inputs:", workflow.split("workflow_dispatch:")[1].split("permissions:")[0])
        self.assertIn('test "$(git -C target rev-parse HEAD)" = "$TARGET_REF"', workflow)
        controller = (ROOT / ".." / ".." / ".github" / "workflows" / "private-repo-ci.yml").read_text()
        self.assertNotIn("  issues:", controller)
        self.assertIn("assert re.fullmatch(r'[0-9a-f]{40}',ref)", controller)
        self.assertNotIn('inputs[repository]', controller)
        self.assertIn('gh api -X POST "repos/$BRIDGE/actions/workflows/atax-private-ci.yml/dispatches" -f ref=main',controller)


    def test_skipo_rule_diagnostics_are_bounded_public_identifiers(self):
        runner = (ROOT / "disposable_workspace.py").read_text()
        controller = (ROOT.parent.parent / ".github/workflows/private-repo-ci.yml").read_text()
        self.assertIn("approved={", runner)
        self.assertIn("SKIPO_CANONICAL_DEPENDENCY_MISMATCH", runner)
        self.assertIn("seen.intersection(approved)", runner)
        self.assertIn("FMRL Skipo rule IDs:", runner)
        self.assertIn("FMRL Skipo rule IDs:", controller)
        self.assertNotIn("print(output)", runner)

if __name__ == "__main__":
    unittest.main()
