"""run_checks.py 가 검사마다 종료 코드를 그대로 읽고 판정과 종료 코드를 내는지 검증한다."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_checks.py"


class RunChecksTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)

    def write(self, relative, text):
        target = self.repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def harness(self, *extra):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.repo), *extra],
            capture_output=True,
            text=True,
        )

    def row(self, done, name):
        return next(line for line in done.stdout.splitlines() if line.startswith(f"| {name} |"))

    def test_clean_repo_passes_every_check(self):
        self.write("CLAUDE.md", "# 지침\n\n본문\n")
        done = self.harness()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("| check_references | 0 | 통과 |", self.row(done, "check_references"))
        self.assertIn("| check_facts | 0 | 출력 판정 |", self.row(done, "check_facts"))

    def test_broken_reference_is_reported_as_finding_with_exit_1(self):
        self.write("CLAUDE.md", "[깨짐](없다.md)\n")
        done = self.harness()
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("| check_references | 1 | 발견 |", self.row(done, "check_references"))
        self.assertIn("CLAUDE.md:1  [링크] 없다.md", done.stdout)

    def test_zero_targets_is_execution_failure_not_pass(self):
        self.write("data.txt", "x\n")
        done = self.harness()
        self.assertEqual(done.returncode, 2, done.stdout)
        self.assertIn("| collect_targets | 2 | 실행 실패 |", self.row(done, "collect_targets"))

    def test_no_changed_skill_is_not_applicable(self):
        self.write("CLAUDE.md", "# 지침\n")
        done = self.harness()
        self.assertIn("| check_rename_drift | 2 | 해당 없음 |", self.row(done, "check_rename_drift"))


if __name__ == "__main__":
    unittest.main()
