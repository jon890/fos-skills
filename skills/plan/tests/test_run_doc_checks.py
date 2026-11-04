"""run_doc_checks.py 가 레포 설정의 「문서 검사 명령」 을 찾아 실행하는지 검증한다."""

import contextlib
import io
import os
import subprocess
import tempfile
import unittest
import importlib.util
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_doc_checks.py"
SPEC = importlib.util.spec_from_file_location("run_doc_checks", SCRIPT)
run = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run)


class RunDocChecksTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True,
                       env={**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"})

    def write(self, rel, text=""):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def overlay(self, rel, command):
        self.write(rel, f"# 레포 설정\n\n## 저장소 검사\n\n| 값 | 값 |\n| --- | --- |\n| 문서 검사 명령 | {command} |\n")

    def main(self, *argv):
        out = io.StringIO()
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            with contextlib.redirect_stdout(out):
                code = run.main(["run_doc_checks.py", *argv])
        finally:
            os.chdir(cwd)
        return code, out.getvalue()

    def test_without_command_passes_and_says_so(self):
        self.write(".claude/spec-overlay.md", "# spec 레포 설정\n")
        code, out = self.main("--skill", "spec", "docs/features/a/spec.md")
        self.assertEqual(0, code)
        self.assertIn("「문서 검사 명령」 이 레포 설정에 없다", out)

    def test_runs_each_inline_command_from_the_repo_root(self):
        self.overlay(".claude/spec-overlay.md", "`touch ran-1` 과 `touch ran-2`")
        code, out = self.main("--skill", "spec", "docs/features/a/spec.md")
        self.assertEqual(0, code, out)
        self.assertTrue((self.root / "ran-1").is_file() and (self.root / "ran-2").is_file())
        self.assertIn("출처: .claude/spec-overlay.md", out)

    def test_failing_command_fails_the_gate(self):
        self.overlay(".claude/spec-overlay.md", "`exit 3`")
        code, out = self.main("--skill", "spec")
        self.assertEqual(1, code)
        self.assertIn("실패(종료 코드 3): exit 3", out)

    def test_technical_design_falls_back_to_the_spec_overlay(self):
        self.overlay(".claude/spec-overlay.md", "`touch from-spec`")
        self.assertEqual(0, self.main("--skill", "technical-design", "docs/features/a/spec.md")[0])
        self.assertTrue((self.root / "from-spec").is_file())
        self.overlay(".claude/technical-design-overlay.md", "`touch from-design`")
        self.assertEqual(0, self.main("--skill", "technical-design")[0])
        self.assertTrue((self.root / "from-design").is_file())

    def test_subproject_overlay_is_chosen_by_document_path(self):
        self.overlay(".claude/spec-overlay.md", "`touch root`")
        self.overlay("web/.claude/spec-overlay.md", "`touch web`")
        self.assertEqual([("touch web", "web/.claude/spec-overlay.md")], run.commands(self.root, "spec", ["web/docs/features/a/spec.md"]))
        self.assertEqual([("touch root", ".claude/spec-overlay.md")], run.commands(self.root, "spec", ["docs/features/a/spec.md"]))

    def test_outside_a_repository_cannot_run(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as other, patch.object(Path, "cwd", return_value=Path(other)):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(2, run.main(["run_doc_checks.py", "--skill", "spec"]))


if __name__ == "__main__":
    unittest.main()
