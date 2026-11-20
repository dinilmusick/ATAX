"""Safe private PR diagnostics contract for transient FMRL runner."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fmrl_diag", HERE / "fmrl_private_diagnostic.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateDiagnosticTests(unittest.TestCase):
    def test_only_bounded_labels_are_selected_and_redacted(self):
        log = ("FAIL src/auth/code.test.ts > should reject bearer\n"
               "not ok 4 - refresh stays scoped\n"
               "token ghp_" + "x"*48 + "\n")
        labels = module.extract(log)
        self.assertEqual(len(labels), 2)
        self.assertNotIn("ghp_", repr(labels))
        self.assertIn("[redacted]", module.sanitize("Bearer " + "k"*32))

    def test_exact_private_pr_binding_before_comment(self):
        ref = "a"*40
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "direct.log"
            p.write_text("FAIL src/auth/code.test.ts > denies wrong origin\n"
                         "Direct CI failed: test exit=1")
            with mock.patch.object(module, "LOG", p), mock.patch.object(module, "api") as api:
                api.side_effect = [
                    [{"number": 41, "head": {"sha": ref, "ref": "fix/auth",
                                              "repo": {"full_name": "dinilmusick/Aiko"}}}],
                    {"id": 12},
                ]
                env = {"FMRL_TARGET_REPOSITORY": "dinilmusick/Aiko",
                       "FMRL_TARGET_REF": ref,
                       "FMRL_TARGET_BRANCH": "fix/auth",
                       "FMRL_DIAGNOSTIC_WRITE_TOKEN": "private-test-token"}
                with mock.patch.dict(module.os.environ, env, clear=True):
                    module.main()
                self.assertEqual(api.call_count, 2)
                body = api.call_args.args[3]["body"]
                self.assertIn("denies wrong origin", body)
                self.assertNotIn("private-test-token", body)

    def test_changed_pr_ref_fails_closed(self):
        ref = "a"*40
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "direct.log"
            p.write_text("Direct CI failed: test exit=1")
            with mock.patch.object(module, "LOG", p), mock.patch.object(module, "api") as api:
                api.return_value = [{"number": 41, "head": {"sha": "b"*40,
                                      "ref": "fix/auth",
                                      "repo": {"full_name": "dinilmusick/Aiko"}}}]
                env = {"FMRL_TARGET_REPOSITORY": "dinilmusick/Aiko",
                       "FMRL_TARGET_REF": ref,
                       "FMRL_TARGET_BRANCH": "fix/auth",
                       "FMRL_DIAGNOSTIC_WRITE_TOKEN": "private-test-token"}
                with mock.patch.dict(module.os.environ, env, clear=True):
                    with self.assertRaisesRegex(RuntimeError, "changed"):
                        module.main()
                self.assertEqual(api.call_count, 1)


if __name__ == "__main__":
    unittest.main()
