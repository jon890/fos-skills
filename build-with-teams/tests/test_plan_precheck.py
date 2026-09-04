#!/usr/bin/env python3
"""plan_precheck 의 판정 함수 검사."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "plan_precheck", Path(__file__).resolve().parents[1] / "scripts" / "plan_precheck.py"
)
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)


def branch(exists=True, impl=None, merged=False, name="plan001-x"):
    f = {"branch": name, "remote_exists": exists}
    if exists:
        f["impl_files"] = impl or []
        f["has_impl_commits"] = bool(impl)
        f["merged_into_main"] = merged
    return f


class TestJudge(unittest.TestCase):
    def test_pending_clean_branch_passes(self):
        found = pc.judge({"status": "pending"}, branch(), [])
        self.assertEqual(found, [])

    def test_completed_is_flagged(self):
        found = pc.judge({"status": "completed"}, branch(merged=True), [])
        self.assertTrue(any("completed" in f for f in found))

    def test_completed_but_unmerged_is_flagged(self):
        found = pc.judge({"status": "completed"}, branch(merged=False), [])
        self.assertTrue(any("머지되지 않았다" in f for f in found))

    def test_completed_with_deleted_branch_still_flags_completion(self):
        """머지 후 브랜치를 지운 것이 가장 흔한 재실행 사례다."""
        found = pc.judge({"status": "completed"}, branch(exists=False), [])
        self.assertTrue(any("completed" in f for f in found))
        self.assertTrue(any("머지 후 정리된" in f for f in found))

    def test_missing_branch_for_pending_points_at_planning(self):
        found = pc.judge({"status": "pending"}, branch(exists=False), [])
        self.assertTrue(any("planning 이 push 하지 않았거나" in f for f in found))

    def test_impl_commits_are_flagged(self):
        found = pc.judge({"status": "pending"}, branch(impl=["src/a.ts"]), [])
        self.assertTrue(any("src/a.ts" in f for f in found))

    def test_planning_only_changes_are_not_impl(self):
        b = branch()
        b["impl_files"] = []
        b["has_impl_commits"] = False
        self.assertEqual(pc.judge({"status": "pending"}, b, []), [])

    def test_open_pr_is_flagged(self):
        found = pc.judge(
            {"status": "pending"}, branch(),
            [{"number": 7, "title": "t", "url": "u"}],
        )
        self.assertTrue(any("#7" in f for f in found))

    def test_cancelled_reports_reason(self):
        found = pc.judge(
            {"status": "cancelled", "blocked_reason": "설계 변경"}, branch(), []
        )
        self.assertTrue(any("설계 변경" in f for f in found))

    def test_failed_without_reason_says_so(self):
        found = pc.judge({"status": "failed"}, branch(), [])
        self.assertTrue(any("사유 없음" in f for f in found))


class TestFindLocal(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        for name in ("plan001-alpha", "plan002-beta", "plan0020-gamma"):
            d = self.repo / "tasks" / name
            d.mkdir(parents=True)
            (d / "index.json").write_text("{}")

    def tearDown(self):
        self.tmp.cleanup()

    def test_exact_name(self):
        self.assertEqual(pc.find_local(self.repo, "plan001-alpha").name, "plan001-alpha")

    def test_prefix_needs_a_hyphen(self):
        """plan002 가 plan0020 까지 잡으면 엉뚱한 plan 을 돌린다."""
        self.assertEqual(pc.find_local(self.repo, "plan002").name, "plan002-beta")

    def test_no_match_returns_none(self):
        self.assertIsNone(pc.find_local(self.repo, "plan999"))

    def test_no_tasks_dir_returns_none(self):
        import tempfile
        with tempfile.TemporaryDirectory() as empty:
            self.assertIsNone(pc.find_local(Path(empty), "plan001"))


if __name__ == "__main__":
    unittest.main()
