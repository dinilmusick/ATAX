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
    def test_runner_only_uses_clone_token_in_clone_step(self):
        workflow = MODULE.WORKFLOW
        clone = workflow.split("      - name: Clone private target at runtime")[1].split(
            "      - name: Install pinned act")[0]
        execute = workflow.split("      - name: Execute target workflow")[1].split(
            "      - name: Remove private checkout")[0]
        self.assertIn("PRIVATE_REPO_TOKEN", clone)
        self.assertNotIn("PRIVATE_REPO_TOKEN", execute)
        self.assertNotIn("--secret", execute)
        self.assertNotIn("upload-artifact", workflow)
        self.assertIn("%%TARGET_SOURCE%%", workflow)
        self.assertIn("test ! -e target", workflow)

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
        self.assertNotIn("--body", run.call_args.args[0])

    def test_rejects_atax_as_target_without_creating_repository(self):
        with mock.patch.object(MODULE, "api") as api, \
             mock.patch.dict(MODULE.os.environ, {
                 "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
             }), mock.patch.object(sys, "argv", [
                 "disposable_workspace.py", "--source", "dinilmusick/ATAX"]):
            with self.assertRaises(SystemExit):
                MODULE.main()
            api.assert_not_called()

    def test_rejects_non_fmrl_repository_name(self):
        with mock.patch.dict(MODULE.os.environ, {
            "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
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
        with mock.patch.object(MODULE, "api", side_effect=fake_api), \\
             mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/gh"), \\
             mock.patch.object(MODULE.subprocess, "run", side_effect=[transient, mock.Mock(returncode=0)]) as run, \\
             mock.patch.object(MODULE.time, "sleep") as sleep, \\
             mock.patch.dict(MODULE.os.environ, {
                 "CODING_REPO_TOKEN": "management", "PRIVATE_REPO_TOKEN": "source-read",
             }), \\
             mock.patch.object(sys, "argv", ["disposable_workspace.py",
                                            "--source", "dinilmusick/KONE",
                                            "--target", "FMRL-unit-test"]), \\
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(MODULE.main(), 0)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(3)


if __name__ == "__main__":
    unittest.main()
