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


class DefaultBoardBinTest(unittest.TestCase):
    def test_default_board_bin_is_in_this_repo(self):
        """BOARD_BIN 이 없을 때 세 스크립트가 부르는 board.py 가 저장소 안에 있다."""
        for name in ("board-sync.py", "goal-progress.py", "finish-pr.py"):
            spec = importlib.util.spec_from_file_location(name.replace("-", "_")[:-3], SCRIPTS / name)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertTrue(module.BOARD_BIN.is_file(), name)
            self.assertEqual("work-board", module.BOARD_BIN.parents[1].name, name)


class BoardSyncTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bin = Path(tempfile.mkdtemp()).resolve()
        cls.addClassCleanup(shutil.rmtree, cls.bin, True)
        cls.gh = cls.bin / "gh"
        cls.gh.write_text(textwrap.dedent("""\
            #!/usr/bin/env python3
            import json, sys
            # gh runs in the current test's --repo directory.
            st = json.load(open("state.json"))
            a = sys.argv[1:]
            if a[:2] == ["pr", "view"] and a[2] in st:
                print(st[a[2]])
            else:
                sys.exit(1)
            """))
        cls.gh.chmod(0o755)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.states = {}
        self.state_file = self.tmp / "state.json"
        bs.GH = str(self.gh)
        self.board = self.tmp / "board.json"

    def sync(self, items, *extra, board_bin=None):
        """실제 board.py 로 동기화하고 (종료 코드, id 별 항목) 을 돌려준다."""
        self.state_file.write_text(json.dumps(self.states))
        self.board.write_text(json.dumps({"items": items}, ensure_ascii=False), encoding="utf-8")
        argv = ["--board", str(self.board), "--repo", str(self.tmp), *extra]
        rc = bs.main(argv + (["--board-bin", str(board_bin)] if board_bin else []))
        return rc, {i["id"]: i for i in json.loads(self.board.read_text(encoding="utf-8"))["items"]}

    def test_merged_pr_marks_done_and_checks_remaining_steps(self):
        self.states["7"] = "MERGED"
        items = [{"id": "a", "status": "doing", "pr": "#7", "details": ["✓ 1. 구현", "2. PR 리뷰 반영", "✓ 3. 머지"]}]
        rc, board = self.sync(items)
        self.assertEqual(rc, 0)
        self.assertEqual("done", board["a"]["status"])
        self.assertEqual("#7", board["a"]["pr"])
        self.assertEqual(["✓ 1. 구현", "✓ 2. PR 리뷰 반영", "✓ 3. 머지"], board["a"]["details"])

    def test_merged_pr_with_two_open_steps_keeps_item_and_checks_only_its_step(self):
        self.states["7"] = "MERGED"
        items = [{"id": "a", "status": "doing", "pr": "#7",
                  "details": ["1. PR #7 머지", "2. dev 테스트", "3. 후속 PR #70"]}]
        rc, board = self.sync(items)
        self.assertEqual(rc, 0)
        self.assertEqual("doing", board["a"]["status"])
        self.assertNotIn("pr", board["a"])
        self.assertEqual(["✓ 1. PR #7 머지", "2. dev 테스트", "3. 후속 PR #70"], board["a"]["details"])

    def test_merged_pr_with_one_open_step_finishes_item(self):
        self.states["7"] = "MERGED"
        items = [{"id": "a", "status": "doing", "pr": "#7", "details": ["✓ 1. 구현", "2. 머지"]}]
        rc, board = self.sync(items)
        self.assertEqual("done", board["a"]["status"])
        self.assertEqual(["✓ 1. 구현", "✓ 2. 머지"], board["a"]["details"])

    def test_checkbox_steps_are_finished_by_board_command(self):
        """[ ] 줄은 「✓ [ ] …」 가 아니라 [x] 로 끝나 단계로 계속 세어진다."""
        self.states["7"] = "MERGED"
        items = [{"id": "a", "status": "doing", "pr": "#7", "details": ["[x] 1. 구현", "[ ] 2. 머지 #7", "[ ] 3. 배포"]},
                 {"id": "b", "status": "doing", "pr": "#7", "next": "[x] 1. 구현\n[ ] 2. 머지"}]
        rc, board = self.sync(items)
        self.assertEqual(rc, 0)
        self.assertEqual(["[x] 1. 구현", "[x] 2. 머지 #7", "[ ] 3. 배포"], board["a"]["details"])
        self.assertEqual("doing", board["a"]["status"])
        self.assertEqual("[x] 1. 구현\n[x] 2. 머지", board["b"]["next"])
        self.assertEqual("done", board["b"]["status"])

    def test_reference_lines_are_not_counted_as_open_steps(self):
        self.states["7"] = "MERGED"
        items = [{"id": "a", "status": "doing", "pr": "#7", "details": ["✓ 1. 구현", "2. 머지", "참고: 후속 검토"]}]
        rc, board = self.sync(items)
        self.assertEqual("done", board["a"]["status"])
        self.assertEqual(["✓ 1. 구현", "✓ 2. 머지", "참고: 후속 검토"], board["a"]["details"])

    def test_open_pr_leaves_steps_alone_and_writes_no_status_lines(self):
        self.states["8"] = "OPEN"
        items = [{"id": "a", "status": "doing", "pr": "8", "details": ["1. 구현", "2. 리뷰"]}]
        before = json.dumps({"items": items}, ensure_ascii=False)
        rc, _ = self.sync(items)
        self.assertEqual((rc, before), (0, self.board.read_text(encoding="utf-8")))

    def test_legacy_auto_lines_are_removed(self):
        self.states["8"] = "OPEN"
        rc, board = self.sync([{"id": "a", "status": "doing", "pr": "8",
                                "details": ["1. 구현", "자동: PR #8 OPEN CLEAN"]}])
        self.assertEqual(["1. 구현"], board["a"]["details"])
        self.assertEqual("doing", board["a"]["status"])

    def test_done_goal_and_failed_lookup_are_skipped(self):
        self.states["7"] = "MERGED"
        items = [{"id": "g", "status": "goal"}, {"id": "d", "status": "done", "pr": "7"},
                 {"id": "x", "status": "doing", "pr": "99", "details": ["1. 구현"]}]
        before = json.dumps({"items": items}, ensure_ascii=False)
        rc, _ = self.sync(items)
        self.assertEqual((rc, before), (0, self.board.read_text(encoding="utf-8")))

    def test_dry_run_does_not_change_board(self):
        self.states["7"] = "MERGED"
        items = [{"id": "a", "status": "doing", "pr": "7", "details": ["1. 구현"]}]
        before = json.dumps({"items": items}, ensure_ascii=False)
        rc, _ = self.sync(items, "--dry-run")
        self.assertEqual((rc, before), (0, self.board.read_text(encoding="utf-8")))

    def test_board_command_without_steps_fails(self):
        """steps 를 모르는 옛 보드 명령이면 고치지 않고 종료 코드 1 로 멈춘다."""
        old_bin = self.tmp / "old-board.py"
        old_bin.write_text("import sys\nsys.exit(2)\n")
        self.states["7"] = "MERGED"
        rc, board = self.sync([{"id": "a", "status": "doing", "pr": "7", "details": ["1. 구현"]}], board_bin=old_bin)
        self.assertEqual(1, rc)
        self.assertEqual("doing", board["a"]["status"])

    def test_goal_progress_is_called_after_sync(self):
        items_file = self.tmp / "items.txt"
        items_file.write_text("a\n")
        self.states["7"] = "MERGED"
        rc, board = self.sync([{"id": "goal", "status": "goal"}, {"id": "a", "status": "doing", "pr": "7", "next": "1. 구현"}],
                              "--goal", "goal", "--goal-items", str(items_file))
        self.assertEqual(rc, 0)
        self.assertEqual("1/1", board["goal"]["progress"])

    def test_goal_without_items_counts_goal_steps(self):
        self.states["7"] = "MERGED"
        items = [{"id": "g", "status": "goal", "details": ["✓ 1. a", "2. b"]},
                 {"id": "a", "status": "doing", "pr": "7", "details": ["1. 구현"]}]
        rc, board = self.sync(items, "--goal", "g")
        self.assertEqual(rc, 0)
        self.assertEqual("1/2", board["g"]["progress"])

    def test_goal_items_needs_goal(self):
        self.assertEqual(bs.main(["--board", str(self.board), "--goal-items", "x"]), 2)

    def test_unreadable_board_fails(self):
        self.assertEqual(bs.main(["--board", str(self.tmp / "none.json")]), 1)


if __name__ == "__main__":
    unittest.main()
