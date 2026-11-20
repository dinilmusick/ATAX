"""Static shell syntax verification for generated FMRL bridge workflows."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

SPEC = importlib.util.spec_from_file_location(
    "fmrl_disposable_shell",
    Path(__file__).with_name("disposable_workspace.py"),
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GeneratedFmrlWorkflowShellTests(unittest.TestCase):
    def test_every_embedded_bash_step_parses(self):
        lines = MODULE.WORKFLOW.splitlines()
        checked = 0
        for i, line in enumerate(lines):
            if line != "        run: |":
                continue
            script = []
            for segment in lines[i + 1:]:
                if segment.strip() and not segment.startswith("          "):
                    break
                script.append(segment[10:] if segment.startswith("          ") else "")
            result = subprocess.run(
                ["bash", "-n"], input="\n".join(script) + "\n",
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(
                result.returncode, 0,
                f"Generated Bash block {i + 1} is invalid: {result.stderr}",
            )
            checked += 1
        self.assertGreaterEqual(checked, 5)

    def test_safe_failure_categories_survive_control_plane_cleanup(self):
        workflow = MODULE.WORKFLOW
        controller = (Path(__file__).parents[2] / ".github" /
                      "workflows" / "private-repo-ci.yml").read_text()
        self.assertIn("FMRL failure categories:", workflow)
        self.assertIn("FMRL failing gate:", workflow)
        self.assertIn("Safe error identifiers:", workflow)
        self.assertIn("ERR_PNPM_[A-Z0-9_]+", workflow)
        self.assertIn("Do not print dependency names, private paths", workflow)
        self.assertIn("lockfile", workflow)
        self.assertIn("ERR_PNPM_[A-Z0-9_]+", workflow)
        self.assertIn("codes=", workflow)
        self.assertIn("for attempt in $(seq 1 15)", controller)
        self.assertIn("grep -E '^(FMRL coverage:", controller)
        self.assertIn("ALWAYS delete FMRL and verify absence", controller)

    def test_safe_python_diagnostics_parse_without_raw_log_exposure(self):
        import ast
        workflow = MODULE.WORKFLOW
        marker = """          python3 - "$result" <<'SAFE'\n"""
        embedded = workflow.split(marker, 1)[1].split("\n          SAFE\n", 1)[0]
        source = "\n".join(
            line[10:] if line.startswith("          ") else line
            for line in embedded.split("\n")
        )
        ast.parse(source)
        self.assertIn("FMRL TypeScript codes:", source)
        self.assertIn("FMRL last observed nested script:", source)
        self.assertNotIn("print(output)", source)

    def test_node_heredoc_closes_at_scalar_baseline(self):
        script = MODULE.WORKFLOW.split(
            "      - name: Run portable private-suite checks", 1
        )[1].split("      - name: Remove private checkout", 1)[0]
        self.assertIn("\n          NODE\n", script)
        self.assertNotIn("\n            NODE\n", script)
        self.assertIn("FMRL direct suite:", script)


if __name__ == "__main__":
    unittest.main()
