"""delete_branches.py 를 tempfile 임시 저장소로 검증한다. 실제 저장소는 건드리지 않는다."""

import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import delete_branches as db  # noqa: E402

BASE = "origin/main"


def git(repo, *args):
    done = subprocess.run(
        ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", *args],
        capture_output=True, text=True)
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return done.stdout.strip()


def commit(repo, msg):
    git(repo, "commit", "--allow-empty", "-m", msg)
    return git(repo, "rev-parse", "HEAD")


class DeleteBranchesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = self._tmp.name
        git(self.repo, "init", "-q", "-b", "main")
        self.a = commit(self.repo, "A")
        # feature 는 A 위의 커밋 B 이고 origin/main 에만 포함된다. 로컬 main(HEAD)은 A 라서 -d 가 거절된다.
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.b = commit(self.repo, "B")
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.b)
        git(self.repo, "checkout", "-q", "main")
        # merged 는 A 에 있으므로 -d 가 통과한다.
        git(self.repo, "branch", "merged", self.a)

    def exists(self, name):
        return subprocess.run(["git", "-C", self.repo, "rev-parse", "-q", "--verify", f"refs/heads/{name}"],
                              capture_output=True).returncode == 0

    def br(self, name, tip, cls, **kw):
        return {"name": name, "tip": tip, "class": cls, "pr_state": None, **kw}

    def process(self, branch, only, apply):
        return db.process_branch(self.repo, BASE, branch, only, apply)

    def test_dry_run_changes_nothing(self):
        for br, only in ((self.br("merged", self.a, "삭제 후보(-d)"), ["merged"]),
                         (self.br("feature", self.b, "PR 머지됨(-D)"), ["pr-merged"])):
            res = self.process(br, only, apply=False)
            self.assertEqual(res["status"], "삭제 예정")
            self.assertTrue(self.exists(br["name"]))

    def test_d_deletes_merged(self):
        res = self.process(self.br("merged", self.a, "삭제 후보(-d)"), ["merged"], apply=True)
        self.assertEqual(res["status"], "삭제")
        self.assertFalse(self.exists("merged"))

    def test_d_rejected_then_force_when_tip_and_base_match(self):
        res = self.process(self.br("feature", self.b, "삭제 후보(-d)"), ["merged"], apply=True)
        self.assertEqual(res["status"], "삭제")
        self.assertIn("-D", res["detail"])
        self.assertFalse(self.exists("feature"))

    def test_d_rejected_keeps_when_tip_differs(self):
        res = self.process(self.br("feature", self.a, "삭제 후보(-d)"), ["merged"], apply=True)
        self.assertEqual(res["status"], "유지")
        self.assertIn("tip 불일치", res["detail"])
        self.assertTrue(self.exists("feature"))

    def test_d_rejected_keeps_when_not_in_base(self):
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.a)
        res = self.process(self.br("feature", self.b, "삭제 후보(-d)"), ["merged"], apply=True)
        self.assertEqual(res["status"], "유지")
        self.assertTrue(self.exists("feature"))

    def test_pr_merged_requires_same_tip(self):
        keep = self.process(self.br("feature", self.a, "PR 머지됨(-D)"), ["pr-merged"], apply=True)
        self.assertEqual(keep["status"], "유지")
        self.assertTrue(self.exists("feature"))
        gone = self.process(self.br("feature", self.b, "PR 머지됨(-D)"), ["pr-merged"], apply=True)
        self.assertEqual(gone["status"], "삭제")
        self.assertFalse(self.exists("feature"))

    def test_unselected_class_and_gh_error_untouched(self):
        res = self.process(self.br("feature", self.b, "PR 머지됨(-D)"), ["merged"], apply=True)
        self.assertEqual(res["status"], "건드리지 않음")
        res = self.process(self.br("feature", self.b, "삭제 후보(-d)", pr_state="error"), ["merged"], apply=True)
        self.assertEqual(res["status"], "건드리지 않음")
        res = self.process(self.br("feature", self.b, "PR 확인 필요(-D)"), ["merged", "pr-merged"], apply=True)
        self.assertEqual(res["status"], "건드리지 않음")
        self.assertTrue(self.exists("feature"))

    def test_checked_out_branch_fails_with_stderr(self):
        res = self.process(self.br("main", self.a, "삭제 후보(-d)"), ["merged"], apply=True)
        self.assertEqual(res["status"], "실패")
        self.assertTrue(res["detail"])
        self.assertTrue(self.exists("main"))

    def test_missing_branch_is_kept_in_both_paths_and_modes(self):
        for cls, only in (("삭제 후보(-d)", ["merged"]), ("PR 머지됨(-D)", ["pr-merged"])):
            for apply in (False, True):
                res = self.process(self.br("gone", self.a, cls), only, apply=apply)
                self.assertEqual(res["status"], "유지")
                self.assertEqual(res["detail"], "브랜치가 없다")

    def test_main_exit_code_on_failure(self):
        import json
        import os
        survey = [{"repo": self.repo, "base": BASE, "branches": [self.br("main", self.a, "삭제 후보(-d)")]}]
        path = os.path.join(self._tmp.name, "survey.json")
        Path(path).write_text(json.dumps(survey), encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(db.main([path]), 0)  # dry-run 은 실패가 없다
            self.assertEqual(db.main([path, "--apply"]), 1)
            self.assertEqual(db.main([os.path.join(self._tmp.name, "none.json")]), 2)


if __name__ == "__main__":
    unittest.main()
