"""Contract tests for GitHub-hosted, disposable Skipo execution."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tools/github/disposable_workspace.py"
spec = importlib.util.spec_from_file_location("fmrl_skipo_contract", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SkipoFMRLTests(unittest.TestCase):
    def test_cli_is_pinned_to_target_dependency_graph(self):
        workflow = module.WORKFLOW
        self.assertIn("skipo_action:", workflow)
        self.assertIn("pnpm install --frozen-lockfile", workflow)
        self.assertIn("npm ci --ignore-scripts", workflow)
        self.assertIn("node_modules/.bin/skipo --help", workflow)
        self.assertIn("node_modules/.bin/skipo \"$SKIPO_ACTION\" .", workflow)
        self.assertNotIn("npm install -g skipo", workflow)
        self.assertNotIn("skipo@latest", workflow)

    def test_private_source_and_token_isolation(self):
        workflow = module.WORKFLOW
        run = workflow.split("      - name: Run pinned Skipo CLI in target checkout")[1].split(
            "      - name: Remove private checkout")[0]
        self.assertNotIn("PRIVATE_REPO_TOKEN", run)
        self.assertNotIn("GITHUB_TOKEN", run)
        self.assertNotIn("upload-artifact", workflow)
        self.assertIn("sudo rm -rf -- target", workflow)
        self.assertIn("test ! -e target", workflow)

    def test_controller_validates_command_and_deletes_bridge(self):
        controller = (ROOT / ".github/workflows/private-repo-ci.yml").read_text()
        self.assertIn("assert skipo_action in", controller)
        self.assertIn("assert not (skipo_action and workflow)", controller)
        self.assertIn('inputs[skipo_action]=$SKIPO_ACTION', controller)
        self.assertIn("ALWAYS delete FMRL and verify absence", controller)

if __name__ == "__main__":
    unittest.main()
