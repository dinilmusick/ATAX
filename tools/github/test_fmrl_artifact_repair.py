"""Guarded private Worker artifact writeback contract — no private source in public bridge."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fmrl_disposable_artifact", ROOT / "disposable_workspace.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FmrlArtifactContract(unittest.TestCase):
    def test_allowlisted_only_aiko_srkl_and_single_generated_worker(self):
        writer = (ROOT / "fmrl_artifact_writer.py").read_text()
        self.assertIn('"dinilmusick/Aiko": "api/index.js"', writer)
        self.assertIn('"dinilmusick/Srkl-Engine": "api/index.js"', writer)
        self.assertNotIn('"dinilmusick/Luth":', writer)
        self.assertNotIn('"package-lock.json"', writer)
        self.assertIn("any(item != path for item in changed)", writer)
        self.assertIn("target.is_symlink()", writer)
        self.assertIn("repo not in ALLOWED", writer)
        self.assertIn('"force": False', writer)
        self.assertIn('stage="private-branch-preflight"', writer)
        self.assertIn('stage="atomic-branch-update"', writer)
        self.assertIn("local_digest", writer)
        self.assertIn("published_blob", writer)

    def test_build_runs_without_write_token_and_only_public_static_helper_is_checked_out(self):
        wf = module.WORKFLOW
        stage = wf.split("      - name: Rebuild canonical Worker artifact", 1)[1].split(
            "      - name: Commit only regenerated Worker artifact", 1
        )[0]
        self.assertIn("npm ci --include=optional", stage)
        self.assertIn("npm run build", stage)
        self.assertIn("npm run typecheck", stage)
        self.assertIn("test -s api/index.js", stage)
        self.assertIn("git diff --check -- api/index.js", stage)
        self.assertIn("/tmp/fmrl-artifact-raw.log", stage)
        self.assertNotIn("FMRL_REPAIR_WRITE_TOKEN", stage)
        self.assertNotIn("PRIVATE_REPO_TOKEN", stage)
        self.assertIn("python3 tools/github/fmrl_artifact_writer.py", wf)
        self.assertIn("env.FMRL_EXECUTION_MODE == 'artifact'", wf)
        self.assertIn("      - name: Remove private checkout", wf)

    def test_generated_workflow_never_contains_yaml_control_characters(self):
        # The Python triple-quoted workflow template must escape JS regex boundaries.
        self.assertNotIn('\\x08', module.WORKFLOW)
        self.assertNotIn('\\x00', module.WORKFLOW)
        self.assertNotIn('\\x0c', module.WORKFLOW)

    def test_owner_approved_pr_id_and_no_arbitrary_target(self):
        controller = (ROOT.parent.parent / ".github/workflows/owner-authorized-private-ci.yml").read_text()
        parent = (ROOT.parent.parent / ".github/workflows/private-repo-ci.yml").read_text()
        self.assertIn("github.event.issue.user.id == 155351357", controller)
        self.assertIn("[atax-fmrl] repair-artifact", controller)
        self.assertIn("PR_[A-Za-z0-9_-]", controller)
        self.assertIn("assert mode != 'artifact'", parent)
        self.assertIn("repo in ('dinilmusick/Srkl-Engine','dinilmusick/Aiko')", parent)
        self.assertIn('if args.mode in ("repair", "artifact")', (ROOT / "disposable_workspace.py").read_text())


if __name__ == "__main__":
    unittest.main()
