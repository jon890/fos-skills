"""run_static_check.py 가 static_check.py 의 종료 코드를 그대로 읽고 판정 낱말로 옮기는지 검증한다."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_static_check.py"


class RunStaticCheckTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)

    def write(self, relative, text):
        target = self.repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def invoke(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=self.repo, capture_output=True, text=True)

    def test_clean_docs_pass(self):
        self.write("docs/a.md", "# 제목\n")
        done = self.invoke("", "docs")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("| static_check | 0 | 통과 | 0 |", done.stdout)

    def test_violation_is_finding_with_exit_1(self):
        self.write("docs/a.md", "# 제목\n\n[깨짐](없다.md)\n")
        done = self.invoke("", "docs")
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("| static_check | 1 | 발견 |", done.stdout)
        self.assertIn("없다.md", done.stdout)

    def test_warn_only_passes_with_warning_count(self):
        self.write("docs/code-architecture.md", "# 구조\n\n```text\ncore/   도메인 (A, B, C)\n```\n")
        done = self.invoke("", "docs")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("| static_check | 0 | 통과 (경고 1줄) | 1 |", done.stdout)

    def test_no_markdown_is_execution_failure(self):
        self.write("code.py", "x = 1\n")
        done = self.invoke()
        self.assertEqual(done.returncode, 2)
        self.assertIn("| static_check | 2 | 실행 실패 |", done.stdout)


if __name__ == "__main__":
    unittest.main()
