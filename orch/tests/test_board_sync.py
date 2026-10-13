"""board-sync.py 를 가짜 gh 와 보드 명령으로 검증한다."""

import importlib.util
import json
import shutil
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
SPEC = importlib.util.spec_from_file_location("board_sync", SCRIPTS / "board-sync.py")
bs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bs)


class BoardSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.states = {}
        self.calls = self.tmp / "calls.jsonl"
        self.board_bin = self.tmp / "board.py"
        self.board_bin.write_text(f"import json,sys\nopen({str(self.calls)!r}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n")
        self.state_file = self.tmp / "state.json"
        gh = self.tmp / "gh"
        gh.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env python3
            import json, sys
            st = json.load(open({str(self.state_file)!r}))
            a = sys.argv[1:]
            if a[:2] == ["pr", "view"] and a[2] in st:
                print(st[a[2]])
            else:
                sys.exit(1)
            """))
        gh.chmod(0o755)
        bs.GH = str(gh)
        self.board = self.tmp / "board.json"

    def sync(self, items, *extra):
        self.state_file.write_text(json.dumps(self.states))
        self.board.write_text(json.dumps({"items": items}), encoding="utf-8")
        rc = bs.main(["--board", str(self.board), "--board-bin", str(self.board_bin), "--repo", str(self.tmp), *extra])
        calls = [json.loads(l) for l in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return rc, calls

    @staticmethod
    def details(argv):
        return [argv[i + 1] for i, x in enumerate(argv) if x == "--detail"]

    def test_merged_pr_marks_done_and_checks_remaining_steps(self):
        self.states["7"] = "MERGED"
        items = [{"id": "a", "status": "doing", "pr": "#7", "details": ["✓ 1. 구현", "2. PR 리뷰 반영", "3. 머지"]}]
        rc, calls = self.sync(items)
        self.assertEqual(rc, 0)
        self.assertEqual(calls[0][:3], ["set", "a", "done"])
        self.assertEqual(self.details(calls[0]), ["✓ 1. 구현", "✓ 2. PR 리뷰 반영", "✓ 3. 머지"])

    def test_open_pr_leaves_steps_alone_and_writes_no_status_lines(self):
        self.states["8"] = "OPEN"
        rc, calls = self.sync([{"id": "a", "status": "doing", "pr": "8", "details": ["1. 구현", "2. 리뷰"]}])
        self.assertEqual((rc, calls), (0, []))

    def test_legacy_auto_lines_are_removed(self):
        self.states["8"] = "OPEN"
        rc, calls = self.sync([{"id": "a", "status": "doing", "pr": "8",
                                "details": ["1. 구현", "자동: PR #8 OPEN CLEAN"]}])
        self.assertEqual(self.details(calls[0]), ["1. 구현"])
        self.assertNotIn("done", calls[0])

    def test_done_goal_and_failed_lookup_are_skipped(self):
        self.states["7"] = "MERGED"
        items = [{"id": "g", "status": "goal"}, {"id": "d", "status": "done", "pr": "7"},
                 {"id": "x", "status": "doing", "pr": "99", "details": ["1. 구현"]}]
        rc, calls = self.sync(items)
        self.assertEqual((rc, calls), (0, []))

    def test_dry_run_does_not_call_board(self):
        self.states["7"] = "MERGED"
        rc, calls = self.sync([{"id": "a", "status": "doing", "pr": "7", "details": ["1. 구현"]}], "--dry-run")
        self.assertEqual((rc, calls), (0, []))

    def test_goal_progress_is_called_after_sync(self):
        items_file = self.tmp / "items.txt"
        items_file.write_text("a\n")
        self.states["7"] = "MERGED"
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
