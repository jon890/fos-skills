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

    def test_heading_marker_is_stripped_when_searching(self):
        (self.root / "tests/test_skill.py").write_text('    "언제 쓰나",\n')
        done = self.run_script("## 언제 쓰나")
        self.assertIn("시험이 요구: tests/test_skill.py:1", done.stdout)

    def test_missing_arguments_exit_with_2(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 2)


class RequirementTiersTest(unittest.TestCase):
    """빌드 결과물과 무시된 파일을 빼고, 낱말만 겹친 줄은 개수로만 내는지 검증한다."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        (self.root / "tests").mkdir()

    def write(self, relative, text):
        target = self.root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def git_init(self):
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root), *args], capture_output=True, text=True
        )

    def test_non_git_walk_skips_build_output_folders(self):
        for folder in ("build", "dist", "out", "target", "coverage", ".next"):
            self.write(f"{folder}/resources/test/application-test.yml", "## 표본 제목\n")
        self.write("tests/t.txt", "## 표본 제목\n")
        done = self.run_script("## 표본 제목")
        self.assertEqual(done.stdout.count("시험이 요구"), 1, done.stdout)
        self.assertIn("tests/t.txt:1", done.stdout)

    def test_git_repo_skips_ignored_files_but_reads_untracked_ones(self):
        self.git_init()
        self.write(".gitignore", "build/\n")
        self.write("backend/build/resources/test/application-test.yml", "## 표본 제목\n")
        self.write("tests/new_file.txt", "## 표본 제목\n")
        done = self.run_script("## 표본 제목")
        self.assertNotIn("backend/build", done.stdout)
        self.assertIn("시험이 요구: tests/new_file.txt:1", done.stdout)

    def test_git_repo_reads_tracked_test_files(self):
        self.git_init()
        self.write("tests/t.txt", "## 표본 제목\n")
        subprocess.run(["git", "add", "tests/t.txt"], cwd=self.root, check=True)
        self.assertIn("시험이 요구: tests/t.txt:1", self.run_script("## 표본 제목").stdout)

    def test_quoted_or_bracketed_title_is_required(self):
        samples = ['x("확인")', "x('확인')", "x(`확인`)", "「확인」 을 본다", "『확인』 을 본다"]
        for number, sample in enumerate(samples):
            self.write(f"tests/q{number}.txt", sample + "\n")
        done = self.run_script("## 확인")
        self.assertEqual(done.stdout.count("시험이 요구"), len(samples), done.stdout)
        self.assertNotIn("낱말만 겹침", done.stdout)

    def test_line_equal_to_title_after_trim_is_required(self):
        self.write("tests/t.txt", "    확인   \n")
        self.assertIn("시험이 요구: tests/t.txt:1", self.run_script("## 확인").stdout)

    def test_argument_verbatim_is_required(self):
        self.write("tests/t.md", "본문\n## 확인\n")
        self.assertIn("시험이 요구: tests/t.md:2", self.run_script("## 확인").stdout)

    def test_word_overlap_is_counted_not_listed(self):
        self.write("tests/t.txt", "# 결과를 확인한다\n// 확인 후 진행\n")
        done = self.run_script("## 확인")
        self.assertNotIn("시험이 요구", done.stdout)
        self.assertIn("없음", done.stdout)
        self.assertIn("낱말만 겹침 2건 (--loose 로 목록)", done.stdout)
        self.assertNotIn("tests/t.txt", done.stdout)

    def test_loose_lists_the_overlapping_lines(self):
        self.write("tests/t.txt", "# 결과를 확인한다\n")
        done = self.run_script("## 확인", "--loose")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("낱말만 겹침: tests/t.txt:1", done.stdout)
        self.assertNotIn("--loose 로 목록", done.stdout)

    def test_plain_argument_without_heading_marker_is_substring_match(self):
        self.write("tests/t.txt", "결과를 확인한다\n")
        self.assertIn("시험이 요구: tests/t.txt:1", self.run_script("확인").stdout)

    def test_loose_flag_does_not_count_as_a_string(self):
        done = self.run_script("--loose")
        self.assertEqual(done.returncode, 2)


if __name__ == "__main__":
    unittest.main()
