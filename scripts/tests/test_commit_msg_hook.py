#!/usr/bin/env python3
"""hooks/commit-msg 가 금지어가 든 커밋 메시지를 커밋 전에 막는지 검사한다.

임시 저장소에 훅, install-hooks.sh, korean-check 를 복사해 실제 `git commit` 으로 확인한다.
install-hooks.sh 가 commit-msg 도 걸어야 이 테스트가 통과한다.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
       "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}


class CommitMsgHookTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name).resolve()
        (self.repo / "hooks").mkdir()
        shutil.copy2(ROOT / "hooks" / "commit-msg", self.repo / "hooks" / "commit-msg")
        (self.repo / "scripts").mkdir()
        shutil.copy2(ROOT / "scripts" / "install-hooks.sh", self.repo / "scripts" / "install-hooks.sh")
        shutil.copytree(ROOT / "korean-check" / "scripts", self.repo / "korean-check" / "scripts",
                        ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(ROOT / "korean-check" / "references", self.repo / "korean-check" / "references")
        self.git("init", "-q")
        installed = subprocess.run(["bash", "scripts/install-hooks.sh"], cwd=self.repo, env=ENV, capture_output=True, text=True)
        self.assertEqual(0, installed.returncode, installed.stderr)
        self.assertIn("commit-msg", installed.stdout)

    def git(self, *args, check=True):
        return subprocess.run(["git", *args], cwd=self.repo, env=ENV, capture_output=True, text=True, check=check)

    def commit(self, message):
        (self.repo / "f.txt").write_text(message, encoding="utf-8")
        self.git("add", "f.txt")
        msg = self.repo / ".git" / "MSG"
        msg.write_text(message, encoding="utf-8")
        return self.git("commit", "-q", "-F", str(msg), check=False)

    def commits(self):
        return int(self.git("rev-list", "--count", "--all").stdout.strip() or 0)

    def test_forbidden_word_blocks_the_commit(self):
        done = self.commit("feat: 매트릭스를 고친다\n")
        self.assertNotEqual(0, done.returncode)
        self.assertIn("매트릭스", done.stderr)
        self.assertIn("커밋하지 않았다", done.stderr)
        self.assertEqual(0, self.commits())

    def test_clean_message_commits(self):
        done = self.commit("feat: 영향 표를 고친다\n\n본문도 평범하다.\n")
        self.assertEqual(0, done.returncode, done.stderr)
        self.assertEqual(1, self.commits())

    def test_verbose_diff_below_scissors_is_not_checked(self):
        message = "feat: 영향 표를 고친다\n\n# ------------------------ >8 ------------------------\n+매트릭스 는 diff 다\n"
        done = self.commit(message)
        self.assertEqual(0, done.returncode, done.stderr)

    def test_comment_line_is_checked_because_file_messages_keep_it(self):
        done = self.commit("feat: 영향 표를 고친다\n\n# 매트릭스\n")
        self.assertNotEqual(0, done.returncode)

    def test_missing_checker_does_not_block(self):
        shutil.rmtree(self.repo / "korean-check")
        done = self.commit("feat: 매트릭스를 고친다\n")
        self.assertEqual(0, done.returncode, done.stderr)


if __name__ == "__main__":
    unittest.main()
