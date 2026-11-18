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
        self.assertIn("GH_TOKEN: ${{ secrets.FMRL_DISPATCH_TOKEN || secrets.FMRL_SECRETS_TOKEN }}", dispatch)\n        self.assertIn("grant Actions: write on newly created FMRL repositories", dispatch)
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
        self.assertNotIn('AUTHORIZATION: bearer', clone)
        self.assertNotIn('https://x-access-token:', clone)
        self.assertIn('"--bind" "--directory" "$PWD"', execute)
        self.assertIn("test -d .git", execute)
        self.assertNotIn("PRIVATE_REPO_TOKEN", execute)
        self.assertNotIn("--secret", execute)
        self.assertNotIn("upload-artifact", workflow)
        self.assertIn("%%TARGET_SOURCE%%", workflow)
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
                                               "--target", "FMRL-unit-test"]), \
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
        self.assertIn('test "$REQUESTED_REPOSITORY" = "dinilmusick/KONE"', workflow)
        self.assertIn('default: "develop"', workflow)
        self.assertNotIn("%%TARGET_SOURCE%%", workflow)
        self.assertEqual(run.call_args.kwargs["input"], "source-read")
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
             mock.patch.object(MODULE.subprocess, "run", side_effect=[transient, mock.Mock(returncode=0)]) as run, \
             mock.patch.object(MODULE.time, "sleep") as sleep, \
             mock.patch.dict(MODULE.os.environ, {
                 "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
                 "FMRL_SECRETS_TOKEN": "secret-writer",
             }), \
             mock.patch.object(sys, "argv", ["disposable_workspace.py",
                                            "--source", "dinilmusick/KONE",
                                            "--target", "FMRL-unit-test"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(MODULE.main(), 0)
        self.assertEqual(run.call_count, 2)
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
                                           "--target", "FMRL-unit-test"]),
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


if __name__ == "__main__":
    unittest.main()
