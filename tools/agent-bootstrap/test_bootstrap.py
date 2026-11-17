import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "bootstrap.py"


class BootstrapTests(unittest.TestCase):
    def test_plan_discovers_build_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "package.json").write_text('{"scripts":{"build":"tsc","test":"node --test"}}')
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "plan", "--workspace", str(root)],
                cwd=root, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(data["build_commands"], [["npm", "run", "build"], ["npm", "run", "test"]])

    def test_plan_prohibits_atax_runner(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "plan", "--repository", "dinilmusick/Aiko",
                 "--workspace", str(Path(temp) / "target")],
                cwd=temp, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(data["execution_order"], ["agent-container", "disposable-FMRL-public-runner"])
            self.assertEqual(data["atax_role"], "control-plane-and-tools-only")
            self.assertIn("TARGET", " ".join(data["next"]))
            self.assertNotIn("Clone ATAX", result.stdout)

    def test_prepare_rejects_invalid_repo(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "prepare", "--repository", "http://invalid"],
                cwd=temp, text=True, capture_output=True)
            self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
