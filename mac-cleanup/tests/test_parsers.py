"""조사 스크립트의 순수 함수(파싱, 분류)를 검증한다. 시스템 상태에 의존하지 않는다."""

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import docker_images as di  # noqa: E402
import survey_git as sg  # noqa: E402
import survey_sessions as ss  # noqa: E402


class EtimeTest(unittest.TestCase):
    def test_formats(self):
        self.assertAlmostEqual(ss.parse_etime("05:30"), 5.5 / 60)
        self.assertAlmostEqual(ss.parse_etime("02:00:00"), 2.0)
        self.assertAlmostEqual(ss.parse_etime("3-04:30:00"), 76.5)

    def test_ancestors_stops_at_pid1(self):
        parents = {30: 20, 20: 10, 10: 1, 1: 0}
        self.assertEqual(ss.ancestors(30, parents), {30, 20, 10, 1})

    def test_ancestors_survives_cycle(self):
        self.assertEqual(ss.ancestors(5, {5: 6, 6: 5}), {5, 6})

    def test_is_agent_by_executable_name(self):
        self.assertTrue(ss.is_agent("/Users/x/.local/bin/claude --resume"))
        self.assertTrue(ss.is_agent("codex"))
        self.assertFalse(ss.is_agent("/usr/bin/vim claude.md"))

    def test_group_helpers_threshold(self):
        rows = [{"command": "node oxide-helper.js", "rss_kb": 100}] * 10 + [{"command": "other", "rss_kb": 5}] * 9
        groups = ss.group_helpers(rows)
        self.assertEqual(len(groups), 1)
        self.assertEqual((groups[0]["count"], groups[0]["rss_kb"]), (10, 1000))

    def test_parse_lsof_cwd(self):
        self.assertEqual(ss.parse_lsof_cwd("p12\nn/a/b\np13\nn/c\n"), {12: "/a/b", 13: "/c"})

    def test_parse_ps_skips_garbage(self):
        out = "  10     1 01:00:00 ttys001  2048  1.5 /bin/claude --x\nbad line\n"
        rows = ss.parse_ps(out)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["pid"], rows[0]["hours"]), (10, 1.0))


def wt(**kw):
    base = {"prunable": False, "merged": False, "dirty": 0, "stash": 0, "in_use": False, "upstream_gone": False}
    return {**base, **kw}


class GitClassifyTest(unittest.TestCase):
    def test_worktree_classes(self):
        self.assertEqual(sg.classify_worktree(wt(merged=True)), "제거 후보")
        self.assertEqual(sg.classify_worktree(wt(merged=True, dirty=1)), "유지")
        self.assertEqual(sg.classify_worktree(wt(merged=True, stash=1)), "유지")
        self.assertEqual(sg.classify_worktree(wt(merged=True, in_use=True)), "유지")
        self.assertEqual(sg.classify_worktree(wt(prunable=True)), "기록만 남음")
        self.assertEqual(sg.classify_worktree(wt(upstream_gone=True)), "PR 확인 필요")
        self.assertEqual(sg.classify_worktree(wt()), "유지")

    def test_branch_classes(self):
        def br(name, **kw):
            return {"name": name, "merged": False, "upstream_gone": False, **kw}
        self.assertEqual(sg.classify_branch(br("feat/a", merged=True), "main", set()), "삭제 후보(-d)")
        self.assertEqual(sg.classify_branch(br("feat/a", merged=True), "main", {"feat/a"}), "유지")
        self.assertEqual(sg.classify_branch(br("main", merged=True), "main", set()), "유지")
        self.assertEqual(sg.classify_branch(br("release/1.0", merged=True), "main", set()), "유지")
        self.assertEqual(sg.classify_branch(br("feat/b", upstream_gone=True), "main", set()), "PR 확인 필요(-D)")
        self.assertEqual(sg.classify_branch(br("feat/c"), "main", set()), "유지")

    def test_worktree_pr_merged(self):
        self.assertEqual(sg.classify_worktree(wt(), pr_state="merged"), "제거 후보(PR 머지됨)")
        self.assertEqual(sg.classify_worktree(wt(dirty=2), pr_state="merged"), "유지")
        self.assertEqual(sg.classify_worktree(wt(stash=1), pr_state="merged"), "유지")
        self.assertEqual(sg.classify_worktree(wt(in_use=True), pr_state="merged"), "유지")
        self.assertEqual(sg.classify_worktree(wt(upstream_gone=True)), "PR 확인 필요")

    def test_worktree_pr_diverged(self):
        self.assertEqual(sg.classify_worktree(wt(), pr_state="diverged"), "PR 확인 필요")

    def test_judge_pr(self):
        prs = [{"number": 1, "headRefOid": "aaa"}, {"number": 2, "headRefOid": "bbb"}]
        self.assertEqual(sg.judge_pr("bbb", prs), "merged")
        self.assertEqual(sg.judge_pr("ccc", prs), "diverged")
        self.assertIsNone(sg.judge_pr("ccc", []))

    def test_branch_pr_diverged(self):
        br = {"name": "feat/a", "merged": False, "upstream_gone": False}
        self.assertEqual(sg.classify_branch(br, "main", set(), pr_state="diverged"), "PR 확인 필요(-D)")

    def test_branch_pr_merged(self):
        br = {"name": "feat/a", "merged": False, "upstream_gone": False}
        self.assertEqual(sg.classify_branch(br, "main", set(), pr_state="merged"), "PR 머지됨(-D)")
        self.assertEqual(sg.classify_branch(br, "main", {"feat/a"}, pr_state="merged"), "유지")
        self.assertEqual(sg.classify_branch(br, "main", set()), "유지")

    def test_branch_keeps_default_names_when_base_differs(self):
        def br(name):
            return {"name": name, "merged": True, "upstream_gone": False}
        for name in ("main", "master", "develop"):
            self.assertEqual(sg.classify_branch(br(name), "develop", set()), "유지")
            self.assertEqual(sg.classify_branch(br(name), "main", set()), "유지")
        self.assertEqual(sg.classify_branch(br("feat/a"), "develop", set()), "삭제 후보(-d)")

    def test_judge_pr_error(self):
        self.assertEqual(sg.judge_pr("aaa", None), "error")
        self.assertIsNone(sg.judge_pr("aaa", []))

    def test_pr_error_keeps_existing_classes(self):
        br = {"name": "feat/a", "merged": False, "upstream_gone": False}
        self.assertEqual(sg.classify_branch(br, "main", set(), pr_state="error"), "유지")
        self.assertEqual(sg.classify_branch({**br, "upstream_gone": True}, "main", set(), pr_state="error"), "PR 확인 필요(-D)")
        self.assertEqual(sg.classify_branch({**br, "merged": True}, "main", set(), pr_state="error"), "삭제 후보(-d)")
        self.assertEqual(sg.classify_worktree(wt(), pr_state="error"), "유지")
        self.assertEqual(sg.classify_worktree(wt(upstream_gone=True), pr_state="error"), "PR 확인 필요")

    def test_parse_tip(self):
        rows = sg.parse_branches("a\t\t1\t\torigin/a\tdeadbeef\nb\t\t2\t\t\n")
        self.assertEqual(rows[0]["tip"], "deadbeef")
        self.assertIsNone(rows[1]["tip"])
        items = sg.parse_worktrees("worktree /r\nHEAD abc123\nbranch refs/heads/main\n\n")
        self.assertEqual(items[0]["head"], "abc123")

    def test_parse_stash_branches(self):
        text = "WIP on feat/x: abc msg\nOn feat/x: manual\nWIP on main: def other\nOn (no branch): z\nweird\n"
        self.assertEqual(sg.parse_stash_branches(text), {"feat/x": 2, "main": 1})
        self.assertEqual(sg.parse_stash_branches(""), {})

    def test_parse_worktrees(self):
        text = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/w\nHEAD def\nbranch refs/heads/feat/x\nprunable gitdir file points to non-existent location\n\n"
        items = sg.parse_worktrees(text)
        self.assertEqual([i["path"] for i in items], ["/r", "/r/w"])
        self.assertEqual(items[1]["branch"], "feat/x")
        self.assertTrue(items[1]["prunable"])

    def test_parse_branches_gone(self):
        rows = sg.parse_branches("a\t[gone]\t100\t\nb\t\t200\t/w\n")
        self.assertTrue(rows[0]["upstream_gone"])
        self.assertEqual(rows[1]["worktreepath"], "/w")
        self.assertFalse(rows[0]["has_upstream"])
        self.assertTrue(sg.parse_branches("a\t\t1\t\torigin/a\n")[0]["has_upstream"])


class DockerImageTest(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(di.normalize_image("alpine"), "alpine:latest")
        self.assertEqual(di.normalize_image("mysql:8.4"), "mysql:8.4")
        self.assertEqual(di.normalize_image("localhost:5000/app"), "localhost:5000/app:latest")
        self.assertEqual(di.normalize_image("a/b@sha256:ff"), "a/b@sha256:ff")

    def test_classify(self):
        now = time.time()
        used = {"alpine:latest"}
        old = now - 10 * 86400
        self.assertEqual(di.classify_image({"ref": "alpine:latest", "id": "x", "created_ts": old}, used, set(), now, 24), "사용 중")
        self.assertEqual(di.classify_image({"ref": "other:1", "id": "x", "created_ts": old}, used, {"x"}, now, 24), "사용 중")
        self.assertEqual(di.classify_image({"ref": "other:1", "id": "y", "created_ts": now - 3600}, used, set(), now, 24), "확인 필요(최근 생성)")
        self.assertEqual(di.classify_image({"ref": "other:1", "id": "y", "created_ts": old}, used, set(), now, 24), "미사용")


if __name__ == "__main__":
    unittest.main()
