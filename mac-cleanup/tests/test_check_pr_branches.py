"""check_pr_branches.py 를 tempfile 임시 저장소로 검증한다. gh 는 가짜로 바꾼다."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import check_pr_branches as cpb  # noqa: E402


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


class VerdictTest(unittest.TestCase):
    def test_verdicts(self):
        self.assertEqual(cpb.verdict("a", "a", 0), "잃는 커밋 없음")
        self.assertEqual(cpb.verdict("a", "a", 3), "로컬 커밋 3개, 사용자 판단")
        self.assertEqual(cpb.verdict("a", "b", 0), "tip 바뀜, 다시 조사")
        self.assertEqual(cpb.verdict("a", None, None), "브랜치 없음, 다시 조사")
        self.assertEqual(cpb.verdict("a", "a", None), "로컬 커밋 수 확인 실패, 사용자 판단")


class CheckBranchTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = self._tmp.name
        git(self.repo, "init", "-q", "-b", "main")
        self.a = commit(self.repo, "A")
        git(self.repo, "checkout", "-q", "-b", "pushed")
        self.b = commit(self.repo, "B")
        git(self.repo, "update-ref", "refs/remotes/origin/pushed", self.b)
        git(self.repo, "checkout", "-q", "-b", "ahead")
        self.c = commit(self.repo, "C")
        git(self.repo, "checkout", "-q", "main")

    def check(self, name, tip, prs):
        return cpb.check_branch(self.repo, {"name": name, "tip": tip}, fetch_prs=lambda *a: prs)

    def test_no_local_only_commits(self):
        res = self.check("pushed", self.b, [{"number": 7, "state": "CLOSED", "headRefOid": self.b, "mergedAt": None}])
        self.assertEqual(res["local_only_commits"], 0)
        self.assertEqual(res["verdict"], "잃는 커밋 없음")
        self.assertEqual(res["prs"], [{"number": 7, "state": "CLOSED", "head_is_tip": True, "merged_at": None}])

    def test_local_only_commit_needs_user(self):
        res = self.check("ahead", self.c, [{"number": 8, "state": "MERGED", "headRefOid": self.b, "mergedAt": "2026-01-01T00:00:00Z"}])
        self.assertEqual(res["local_only_commits"], 1)
        self.assertEqual(res["verdict"], "로컬 커밋 1개, 사용자 판단")
        self.assertFalse(res["prs"][0]["head_is_tip"])

    def test_changed_tip_asks_for_resurvey(self):
        res = self.check("pushed", self.a, [])
        self.assertFalse(res["tip_same"])
        self.assertEqual(res["verdict"], "tip 바뀜, 다시 조사")

    def test_missing_branch(self):
        self.assertEqual(self.check("gone", self.a, [])["verdict"], "브랜치 없음, 다시 조사")

    def test_gh_failure_is_marked_and_verdict_still_given(self):
        res = self.check("pushed", self.b, None)
        self.assertTrue(res["gh_error"])
        self.assertEqual(res["verdict"], "잃는 커밋 없음")

    def test_survey_handles_null_pr_state_and_filters_class(self):
        survey = [{"repo": self.repo, "branches": [
            {"name": "pushed", "tip": self.b, "class": cpb.CLASS, "pr_state": None},
            {"name": "ahead", "tip": self.c, "class": "삭제 후보(-d)", "pr_state": None}]}]
        results = cpb.check_survey(survey, fetch_prs=lambda *a: [])
        self.assertEqual([r["name"] for r in results], ["pushed"])
        self.assertEqual(results[0]["prs"], [])


if __name__ == "__main__":
    unittest.main()
