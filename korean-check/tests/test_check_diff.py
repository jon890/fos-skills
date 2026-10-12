#!/usr/bin/env python3
"""check.sh --diff 의 검출력 검사.

임시 git 저장소에 기존 금지어를 둔 파일을 커밋하고, 줄을 더한 뒤 돌린다.
기존 줄의 발견이 종료 코드를 올리면 이 모드를 둔 의미가 없고,
더한 줄의 발견이 「기존 줄」 로 빠지면 금지어가 통과한다. 두 방향을 함께 고정한다.
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

CHECK = Path(__file__).resolve().parents[1] / "scripts" / "check.sh"
RULES = Path(__file__).resolve().parents[1] / "references" / "korean-style.md"

OLD = "# 문서\n\n장애를 트리아지한다.\n\n둘째 단락이다.\n"


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.env = {
            **os.environ,
            "KOREAN_STYLE_RULES": str(RULES),
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
        }
        self.git("init", "-q", "-b", "main")
        (self.root / "doc.md").write_text(OLD, encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "init")

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, env=self.env, check=True,
                       capture_output=True)

    def run_diff(self, *args):
        return subprocess.run(["bash", str(CHECK), "--diff", *args], cwd=self.root,
                              env=self.env, capture_output=True, text=True)

    def sections(self, out):
        new, _, old = out.partition("## 기존 줄")
        return new, old


class TestDiffMode(Base):
    def test_existing_finding_does_not_fail(self):
        (self.root / "doc.md").write_text(OLD + "\n새로 더한 문장이다.\n", encoding="utf-8")
        done = self.run_diff()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        new, old = self.sections(done.stdout)
        self.assertNotIn("트리아지", new)
        self.assertIn("doc.md:3", old)

    def test_added_finding_fails(self):
        (self.root / "doc.md").write_text(OLD + "\n결과를 스윕한다.\n", encoding="utf-8")
        done = self.run_diff()
        self.assertEqual(done.returncode, 1, done.stdout)
        new, old = self.sections(done.stdout)
        self.assertIn("doc.md:7", new)
        self.assertIn("스윕", new)
        self.assertIn("트리아지", old)

    def test_changed_line_counts_as_new(self):
        (self.root / "doc.md").write_text(OLD.replace("둘째 단락이다.", "둘째 스파이크다."),
                                          encoding="utf-8")
        done = self.run_diff()
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("doc.md:5", self.sections(done.stdout)[0])

    def test_warning_in_new_line_does_not_fail(self):
        (self.root / "doc.md").write_text(OLD + "\nA + B 를 쓴다.\n", encoding="utf-8")
        done = self.run_diff()
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertIn("인라인 + 연결", self.sections(done.stdout)[0])

    def test_fence_context_comes_from_whole_file(self):
        # 펜스 안에 더한 줄은 파일 전체로 보면 코드 블록이라 걸리지 않아야 한다.
        text = OLD + "\n```\n첫 줄\n```\n"
        (self.root / "doc.md").write_text(text, encoding="utf-8")
        self.git("commit", "-qam", "fence")
        (self.root / "doc.md").write_text(text.replace("첫 줄", "첫 줄\n트리아지 예시"),
                                          encoding="utf-8")
        done = self.run_diff()
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_base_ref_includes_committed_changes(self):
        self.git("checkout", "-q", "-b", "work")
        (self.root / "doc.md").write_text(OLD + "\n결과를 스윕한다.\n", encoding="utf-8")
        self.git("commit", "-qam", "work")
        self.assertEqual(self.run_diff().returncode, 0)  # HEAD 기준이면 변경이 없다
        self.assertEqual(self.run_diff("main").returncode, 1)

    def test_untracked_file_is_all_new(self):
        (self.root / "new.md").write_text("장애를 트리아지한다.\n", encoding="utf-8")
        done = self.run_diff()
        self.assertEqual(done.returncode, 1, done.stdout)
        self.assertIn("new.md:1", self.sections(done.stdout)[0])

    def test_explicit_file_limits_scope(self):
        (self.root / "new.md").write_text("장애를 트리아지한다.\n", encoding="utf-8")
        (self.root / "doc.md").write_text(OLD + "\n더한 문장이다.\n", encoding="utf-8")
        done = self.run_diff("HEAD", "--", "doc.md")
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertNotIn("new.md", done.stdout)

    def test_unknown_base_is_error(self):
        self.assertEqual(self.run_diff("no-such-ref").returncode, 2)

    def test_outside_git_is_error(self):
        with tempfile.TemporaryDirectory() as d:
            done = subprocess.run(["bash", str(CHECK), "--diff"], cwd=d, env=self.env,
                                  capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)


if __name__ == "__main__":
    unittest.main()
