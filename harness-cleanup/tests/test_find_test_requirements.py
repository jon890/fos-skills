"""find_test_requirements.py 가 시험이 요구하는 문자열만 찾는지 검증한다."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "find_test_requirements.py"


class FindTestRequirementsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        (self.root / "tests").mkdir()
        (self.root / "tests/check.sh").write_text('grep -q "## 일곱 단계" SKILL.md\n')
        (self.root / "skills/a").mkdir(parents=True)
        (self.root / "skills/a/SKILL.md").write_text("## 일곱 단계\n## 언제 쓰나\n")

    def run_script(self, *needles):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root), *needles], capture_output=True, text=True
        )

    def test_reports_string_required_by_a_test(self):
        done = self.run_script("## 일곱 단계")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("시험이 요구: tests/check.sh:1", done.stdout)

    def test_string_only_in_docs_is_not_required(self):
        done = self.run_script("## 언제 쓰나")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("시험이 요구", done.stdout)
        self.assertIn("없음", done.stdout)

    def test_reports_each_string_separately(self):
        done = self.run_script("## 일곱 단계", "## 언제 쓰나")
        self.assertEqual(done.stdout.count("시험이 요구"), 1)
        self.assertEqual(done.stdout.count("없음"), 1)

    def test_reads_fixture_ci_and_validate_files(self):
        for relative in ("tests/data/expected.txt", ".github/workflows/ci.yml", "scripts/validate.sh"):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("## 표본 제목\n")
        done = self.run_script("## 표본 제목")
        for relative in ("tests/data/expected.txt", ".github/workflows/ci.yml", "scripts/validate.sh"):
            self.assertIn(f"시험이 요구: {relative}:1", done.stdout)

    def test_skips_worktrees_and_node_modules(self):
        for relative in ("worktrees/w/tests/t.txt", "node_modules/m/tests/t.txt"):
            target = self.root / relative
            target.parent.mkdir(parents=True)
            target.write_text("## 표본 제목\n")
        self.assertIn("없음", self.run_script("## 표본 제목").stdout)

    def test_empty_string_argument_exits_with_2(self):
        self.assertEqual(self.run_script("").returncode, 2)

    def test_missing_arguments_exit_with_2(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 2)


if __name__ == "__main__":
    unittest.main()
