"""ATAX FMRL lock-repair contract: no source leaks or unguarded writes."""
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fmrl_disposable_repair", ROOT / "disposable_workspace.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FmrlLockRepairContract(unittest.TestCase):
    def test_static_repair_requires_no_scripts_then_frozen_install(self):
        wf = module.WORKFLOW
        repair = wf.split("      - name: Regenerate one lockfile", 1)[1].split(
            "      - name: Remove private checkout", 1
        )[0]
        self.assertIn("pnpm install --lockfile-only --ignore-scripts", repair)
        self.assertIn("pnpm install --frozen-lockfile --ignore-scripts", repair)
        self.assertIn("npm install --package-lock-only --ignore-scripts", repair)
        self.assertIn("npm ci --ignore-scripts", repair)
        self.assertIn("dinilmusick/Frnes", repair)
        self.assertIn("test -f target/package.json", repair)
        self.assertIn('ls-files", "--others", "--exclude-standard', (ROOT / "fmrl_lock_writer.py").read_text())
        self.assertIn("python3 tools/github/fmrl_lock_writer.py", repair)
        self.assertIn("Checkout trusted static public FMRL writeback helper", wf)
        self.assertIn("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", wf)
        self.assertIn("secrets.FMRL_REPAIR_WRITE_TOKEN", repair)
        direct = wf.split("      - name: Run portable private-suite checks", 1)[1].split(
            "      - name: Regenerate one lockfile", 1
        )[0]
        self.assertIn("if: env.FMRL_EXECUTION_MODE == 'direct'", direct)
        self.assertNotIn("|| env.FMRL_EXECUTION_MODE == 'repair'", direct.splitlines()[1])

    def test_target_commands_receive_no_write_token(self):
        wf = module.WORKFLOW
        regen = wf.split("      - name: Regenerate one lockfile", 1)[1].split(
            "      - name: Atomically commit", 1
        )[0]
        self.assertNotIn("REPAIR_WRITE_TOKEN", regen)
        self.assertNotIn("CODING_REPO_TOKEN", regen)
        writer = (ROOT / "fmrl_lock_writer.py").read_text()
        self.assertIn('"force": False', writer)
        self.assertIn("source file", writer)
        self.assertIn("Independent", writer)
        self.assertIn('repo not in ALLOWED', writer)
        self.assertIn('stage="private-branch-preflight"', writer)
        self.assertIn('stage="atomic-branch-update"', writer)
        self.assertIn('branch_path.replace("/git/ref/", "/git/refs/")', writer)
        self.assertIn('stage="private-branch-preflight"', writer)

    def test_issue_trigger_requires_owner_and_exact_pr(self):
        controller = (ROOT.parent.parent / ".github/workflows/owner-authorized-private-ci.yml").read_text()
        self.assertIn("github.event.issue.user.id == 155351357", controller)
        self.assertIn("[atax-fmrl] repair-lockfile", controller)
        self.assertIn("'dinilmusick/Frnes'", controller)
        self.assertIn('"dinilmusick/Frnes"', source)
        self.assertIn("candidate_repo", controller)
        self.assertIn("source_branch", controller)


if __name__ == "__main__":
    unittest.main()
