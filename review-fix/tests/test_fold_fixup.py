#!/usr/bin/env python3
"""fold_fixup.sh 검사. 임시 저장소에서 돌린다."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fold_fixup.sh"
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_EDITOR": "false"}


class FoldFixup(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.git("init", "-q", "-b", "main")
        for name in ("a", "b", "c"):
            self.commit(name)

    def git(self, *args, check=True):
        done = subprocess.run(["git", *args], cwd=self.repo, env=ENV, capture_output=True, text=True)
        if check and done.returncode != 0:
            raise AssertionError(f"git {args}: {done.stderr}")
        return done.stdout.strip()

    def commit(self, name, text=None):
        (self.repo / f"{name}.txt").write_text(text or name)
        self.git("add", ".")
        self.git("commit", "-q", "-m", f"add {name}")

    def fold(self, target):
        return subprocess.run(["bash", str(SCRIPT), target], cwd=self.repo, env=ENV,
                              capture_output=True, text=True)

    def subjects(self):
        return self.git("log", "--format=%s").splitlines()

    def test_folds_into_earlier_commit_keeping_history_linear(self):
        target = self.git("rev-parse", "HEAD~1")
        (self.repo / "b.txt").write_text("fixed")
        self.git("add", "b.txt")
        done = self.fold(target)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.subjects(), ["add c", "add b", "add a"])
        self.assertEqual(self.git("show", "HEAD~1:b.txt"), "fixed")
        self.assertEqual(self.git("show", "HEAD:c.txt"), "c")

    def test_head_target_amends(self):
        (self.repo / "c.txt").write_text("fixed")
        self.git("add", "c.txt")
        done = self.fold(self.git("rev-parse", "HEAD"))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.subjects(), ["add c", "add b", "add a"])

    def test_root_commit_target(self):
        (self.repo / "a.txt").write_text("fixed")
        self.git("add", "a.txt")
        done = self.fold(self.git("rev-list", "--max-parents=0", "HEAD"))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.git("show", "HEAD~2:a.txt"), "fixed")

    def test_unstaged_changes_survive(self):
        (self.repo / "b.txt").write_text("fixed")
        self.git("add", "b.txt")
        (self.repo / "c.txt").write_text("dirty")
        done = self.fold(self.git("rev-parse", "HEAD~1"))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.repo / "c.txt").read_text(), "dirty")

    def test_nothing_staged_is_usage_error(self):
        done = self.fold(self.git("rev-parse", "HEAD~1"))
        self.assertEqual(done.returncode, 2)

    def test_unknown_commit_is_usage_error(self):
        (self.repo / "b.txt").write_text("fixed")
        self.git("add", "b.txt")
        self.assertEqual(self.fold("nope").returncode, 2)

    def test_merge_in_range_is_refused(self):
        base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "-b", "side")
        self.commit("s")
        self.git("checkout", "-q", "main")
        self.git("merge", "-q", "--no-ff", "-m", "merge side", "side")
        (self.repo / "a.txt").write_text("fixed")
        self.git("add", "a.txt")
        done = self.fold(base)
        self.assertEqual(done.returncode, 2, done.stderr)

    def test_conflict_aborts_and_keeps_fixup_commit(self):
        # c 가 b.txt 를 다시 고친 뒤, b 에 접으면 c 와 겹쳐 충돌한다
        (self.repo / "b.txt").write_text("c-edit")
        self.git("add", "b.txt")
        self.git("commit", "-q", "-m", "edit b again")
        (self.repo / "b.txt").write_text("conflicting")
        self.git("add", "b.txt")
        done = self.fold(self.git("rev-parse", "HEAD~3"))
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertNotIn("rebase", self.git("status", "--short", "--branch").lower())
        self.assertTrue(self.subjects()[0].startswith("fixup!"))


if __name__ == "__main__":
    unittest.main()
