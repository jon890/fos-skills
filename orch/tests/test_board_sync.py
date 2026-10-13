"""board-sync.py 를 가짜 gh, orca, 보드 명령과 실제 git 저장소로 검증한다."""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
SPEC = importlib.util.spec_from_file_location("board_sync", SCRIPTS / "board-sync.py")
bs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bs)


def sh(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()


class BoardSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        for k, v in {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t",
                     "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t",
                     "GIT_COMMITTER_EMAIL": "t@example.com"}.items():
            os.environ[k] = v
        self.repo = self.tmp / "repo"
        sh("git", "init", "-q", "-b", "main", str(self.repo))
        sh("git", "-C", str(self.repo), "commit", "-q", "--allow-empty", "-m", "init")
        self.wt = self.tmp / "wts" / "feat"
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "-b", "feat", str(self.wt), "main")
        sh("git", "-C", str(self.wt), "commit", "-q", "--allow-empty", "-m", "작업 커밋")

        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.state = {"prs": {}, "workers": [], "terminals": [], "screen": ""}
        self.calls = self.tmp / "calls.jsonl"
        board_bin = self.tmp / "board.py"
        board_bin.write_text(f"import json,sys\nopen({str(self.calls)!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n")
        self.board_bin = board_bin
        state = self.tmp / "state.json"
        head = f"#!/usr/bin/env python3\nimport json, sys\nst = json.load(open({str(state)!r}))\na = sys.argv[1:]\n"
        (self.bin / "gh").write_text(head + textwrap.dedent("""\
            if a[:2] == ["pr", "view"] and a[2] in st["prs"]:
                print(json.dumps(st["prs"][a[2]]))
            else:
                sys.exit(1)
            """))
        (self.bin / "orca").write_text(head + textwrap.dedent("""\
            if a[:2] == ["orchestration", "worker-list"]:
                print(json.dumps({"result": {"workers": st["workers"]}}))
            elif a[:2] == ["terminal", "list"]:
                print(json.dumps({"result": {"terminals": st["terminals"]}}))
            elif a[:2] == ["terminal", "read"]:
                print(st["screen"])
            """))
        for name in ("gh", "orca"):
            (self.bin / name).chmod(0o755)
        self.state_file = state
        bs.GH, bs.ORCA = str(self.bin / "gh"), str(self.bin / "orca")
        self.board = self.tmp / "board.json"

    def sync(self, items, *extra):
        self.state_file.write_text(json.dumps(self.state))
        self.board.write_text(json.dumps({"items": items}), encoding="utf-8")
        rc = bs.main(["--board", str(self.board), "--board-bin", str(self.board_bin), "--repo", str(self.repo),
                      "--base", "main", "--worktree-root", str(self.tmp / "wts"), *extra])
        calls = [json.loads(l) for l in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return rc, calls

    def test_rewrites_only_auto_lines_and_keeps_human_lines(self):
        self.state["prs"]["12"] = {"state": "OPEN", "mergeStateStatus": "CLEAN", "headRefOid": "abcdef1234",
                                   "statusCheckRollup": [{"name": "ci", "status": "COMPLETED", "conclusion": "SUCCESS"}]}
        items = [{"id": "a", "status": "doing", "pr": "#12", "worktree": "feat",
                  "details": ["결정: A 안으로 간다", "자동: 옛 줄"]}]
        rc, calls = self.sync(items)
        self.assertEqual(rc, 0)
        argv = calls[0]
        self.assertEqual(argv[:2], ["set", "a"])
        self.assertNotIn("done", argv)
        details = [argv[i + 1] for i, x in enumerate(argv) if x == "--detail"]
        self.assertEqual(details[0], "결정: A 안으로 간다")
        self.assertNotIn("자동: 옛 줄", details)
        self.assertIn("자동: PR #12 OPEN CLEAN (HEAD abcdef12), CI 통과", details)
        self.assertIn("자동: feat 앞 1, 뒤 0", details)
        self.assertTrue(any(d.startswith("자동: 마지막 커밋 ") and "작업 커밋" in d for d in details))

    def test_merged_pr_marks_done_and_skips_done_items(self):
        self.state["prs"]["7"] = {"state": "MERGED", "mergedAt": "2026-10-13T01:02:03Z"}
        items = [{"id": "a", "status": "doing", "pr": "7"}, {"id": "b", "status": "done", "pr": "7"}]
        rc, calls = self.sync(items)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:3], ["set", "a", "done"])
        self.assertIn("자동: ✓ PR #7 머지됨 2026-10-13 01:02Z", calls[0])

    def test_failed_ci_and_missing_worktree(self):
        self.state["prs"]["3"] = {"state": "OPEN", "mergeStateStatus": "BLOCKED", "headRefOid": "1",
                                  "statusCheckRollup": [{"name": "backend", "conclusion": "FAILURE"}]}
        rc, calls = self.sync([{"id": "a", "status": "doing", "pr": "3", "worktree": "gone"}])
        self.assertIn("자동: PR #3 OPEN BLOCKED (HEAD 1), CI 실패 backend", calls[0])
        self.assertIn("자동: worktree 없음(gone)", calls[0])

    def test_worker_with_live_terminal_is_reported_even_if_succeeded(self):
        self.state["workers"] = [{"dispatchId": "ctx_1", "workerState": "succeeded", "agentTerminalHandle": "term_1",
                                  "resource": {"worktreeId": f"x::{self.wt}"}}]
        self.state["terminals"] = [{"handle": "term_1"}]
        self.state["screen"] = "⏺ 첫 보고\n⏺ 테스트를 고쳤다\n✻ Thinking…"
        rc, calls = self.sync([{"id": "a", "status": "doing", "worktree": "feat"}], "--run", "run_x")
        self.assertIn("자동: worker ctx_1 succeeded (작업 중): ⏺ 테스트를 고쳤다", calls[0])

    def test_worker_without_live_terminal(self):
        self.state["workers"] = [{"dispatchId": "ctx_1", "workerState": "succeeded", "agentTerminalHandle": "term_1",
                                  "resource": {"worktreeId": f"x::{self.wt}"}}]
        rc, calls = self.sync([{"id": "a", "status": "doing", "worktree": "feat"}], "--run", "run_x")
        self.assertIn("자동: 살아 있는 worker 없음", calls[0])

    def test_dry_run_and_unchanged_items_do_not_call_board(self):
        self.state["prs"]["9"] = {"state": "OPEN", "mergeStateStatus": "CLEAN", "headRefOid": "9", "statusCheckRollup": []}
        rc, calls = self.sync([{"id": "a", "status": "doing", "pr": "9"}], "--dry-run")
        self.assertEqual((rc, calls), (0, []))
        rc, calls = self.sync([{"id": "a", "status": "doing", "pr": "9",
                                "details": ["자동: PR #9 OPEN CLEAN (HEAD 9), CI 체크 없음"]}])
        self.assertEqual((rc, calls), (0, []))

    def test_goal_progress_is_called_after_sync(self):
        items_file = self.tmp / "items.txt"
        items_file.write_text("a\n")
        self.state["prs"]["7"] = {"state": "MERGED", "mergedAt": "2026-10-13T01:02:03Z"}
        rc, calls = self.sync([{"id": "goal", "status": "goal"}, {"id": "a", "status": "doing", "pr": "7"}],
                              "--goal", "goal", "--goal-items", str(items_file))
        self.assertEqual(rc, 0)
        self.assertEqual(calls[-1][:2], ["set", "goal"])

    def test_goal_needs_items(self):
        self.assertEqual(bs.main(["--board", str(self.board), "--goal", "g"]), 2)

    def test_unreadable_board_fails(self):
        self.assertEqual(bs.main(["--board", str(self.tmp / "none.json")]), 1)


if __name__ == "__main__":
    unittest.main()
