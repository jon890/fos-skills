"""orch 스크립트를 검증한다. orca 와 GitHub 에는 닿지 않는다."""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gp = load("goal-progress")


class GoalProgressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.board = self.tmp / "board.json"
        self.board.write_text(json.dumps({"items": [
            {"id": "goal", "status": "goal", "title": "목표"},
            {"id": "a", "status": "done", "title": "A"},
            {"id": "b", "status": "doing", "title": "B"},
        ]}), encoding="utf-8")
        self.calls = self.tmp / "calls.json"
        self.bin = self.tmp / "board.py"
        self.bin.write_text(f"import json,sys\njson.dump(sys.argv[1:], open({str(self.calls)!r}, 'w'))\n")

    def test_progress_counts_done_and_missing(self):
        by_id = gp.board_items(json.loads(self.board.read_text()))
        done, details, missing = gp.progress(by_id, ["a", "b", "gone"])
        self.assertEqual(1, done)
        self.assertEqual(["✓ A", "B", "gone"], details)
        self.assertEqual(["gone"], missing)

    def test_sets_progress_and_details(self):
        items = self.tmp / "items.txt"
        items.write_text("# 오늘\na\n\nb\n", encoding="utf-8")
        rc = gp.main(["goal", "--items-file", str(items), "--board", str(self.board),
                      "--board-bin", str(self.bin), "--details"])
        self.assertEqual(0, rc)
        argv = json.loads(self.calls.read_text())
        self.assertEqual(["set", "goal", "--progress", "1/2", "--file", str(self.board),
                          "--detail", "✓ A", "--detail", "B"], argv)

    def write_goal(self, details):
        self.board.write_text(json.dumps({"items": [{"id": "goal", "status": "goal", "details": details}]}),
                              encoding="utf-8")

    def test_counts_goal_own_steps_and_skips_reference_lines(self):
        self.write_goal(["✓ 1. 구현", "2. 리뷰", "✓ 3. 머지", "참고: 메모", "✓ 완료한 참고"])
        rc = gp.main(["goal", "--board", str(self.board), "--board-bin", str(self.bin), "--details"])
        self.assertEqual(0, rc)
        # 단계 줄이 곧 하위 줄이라 --details 를 줘도 하위 줄을 다시 쓰지 않는다
        self.assertEqual(["set", "goal", "--progress", "2/3", "--file", str(self.board)],
                         json.loads(self.calls.read_text()))

    def test_counts_object_and_legacy_steps_together(self):
        self.write_goal([{"text": "1. 구현", "done": True}, {"text": "2. 리뷰", "done": False},
                         "✓ 3. 머지", {"text": "참고", "done": True}])
        self.assertEqual(0, gp.main(["goal", "--board", str(self.board), "--board-bin", str(self.bin)]))
        self.assertIn("2/3", json.loads(self.calls.read_text()))

    def test_no_step_lines_leaves_progress_alone(self):
        self.write_goal(["참고: 메모"])
        self.assertEqual(0, gp.main(["goal", "--board", str(self.board), "--board-bin", str(self.bin)]))
        self.assertFalse(self.calls.exists())

    def test_dry_run_does_not_call_board(self):
        rc = gp.main(["goal", "a", "--board", str(self.board), "--board-bin", str(self.bin), "--dry-run"])
        self.assertEqual(0, rc)
        self.assertFalse(self.calls.exists())

    def test_unknown_goal_fails(self):
        self.assertEqual(1, gp.main(["nope", "a", "--board", str(self.board), "--dry-run"]))


if __name__ == "__main__":
    unittest.main()
