"""bin/board.py 를 임시 보드 파일로 실행해 단계 줄 처리와 set 규칙을 확인한다.

실행: python3 -m unittest discover -s work-board/tests
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BOARD = Path(__file__).resolve().parents[1] / "bin" / "board.py"


class BoardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "board.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, *items):
        self.file.write_text(json.dumps({"items": list(items)}, ensure_ascii=False), encoding="utf-8")

    def run_board(self, *args):
        return subprocess.run([sys.executable, str(BOARD), *args, "--file", str(self.file)],
                              capture_output=True, text=True)

    def item(self, item_id):
        return next(i for i in json.loads(self.file.read_text(encoding="utf-8"))["items"] if i["id"] == item_id)

    def test_step_finds_numbered_next_lines(self):
        self.write({"id": "up", "status": "doing", "next": "1. 구현\n2. 리뷰 반영\n3. 머지"})
        done = self.run_board("step", "up", "1")
        self.assertEqual(0, done.returncode, done.stderr)
        self.assertEqual("✓ 1. 구현\n2. 리뷰 반영\n3. 머지", self.item("up")["next"])
        self.run_board("step", "up", "1", "--undo")
        self.assertEqual("1. 구현\n2. 리뷰 반영\n3. 머지", self.item("up")["next"])

    def test_step_prefers_detail_steps_over_next(self):
        self.write({"id": "g", "status": "doing", "next": "1. 할 일 목록", "details": ["1 a", "2 b"]})
        self.run_board("step", "g", "1")
        self.assertEqual(["✓ 1 a", "2 b"], self.item("g")["details"])
        self.assertEqual("1. 할 일 목록", self.item("g")["next"])

    def test_step_turns_checkbox_into_x(self):
        self.write({"id": "c", "status": "doing", "details": ["[ ] 1. a", "[ ] 2) b"]})
        self.run_board("step", "c", "2")
        self.assertEqual(["[ ] 1. a", "[x] 2) b"], self.item("c")["details"])
        self.run_board("step", "c", "2", "--undo")
        self.assertEqual(["[ ] 1. a", "[ ] 2) b"], self.item("c")["details"])

    def test_step_replaces_in_progress_mark(self):
        self.write({"id": "m", "status": "doing", "details": ["▶ 1 a", "◇ 2 b"]})
        self.run_board("step", "m", "1")
        self.assertEqual(["✓ 1 a", "◇ 2 b"], self.item("m")["details"])

    def test_step_missing_number_says_how_to_write_steps(self):
        self.write({"id": "x", "status": "doing", "next": "1. a"})
        done = self.run_board("step", "x", "4")
        self.assertNotEqual(0, done.returncode)
        self.assertIn("4 번 단계 줄이 없다", done.stderr)
        self.assertIn("「4. …」", done.stderr)

    def test_steps_lists_counted_lines_without_writing(self):
        self.write({"id": "s", "status": "doing", "details": ["참고: x", "✓ 1 a", "[ ] 2. b #7"]})
        before = self.file.read_text(encoding="utf-8")
        done = self.run_board("steps", "s")
        self.assertEqual(0, done.returncode, done.stderr)
        self.assertEqual([{"number": 1, "done": True, "text": "✓ 1 a"}, {"number": 2, "done": False, "text": "[ ] 2. b #7"}],
                         json.loads(done.stdout))
        self.assertEqual(before, self.file.read_text(encoding="utf-8"))
        self.assertNotEqual(0, self.run_board("steps", "none").returncode)

    def test_set_doing_without_progress_is_refused(self):
        self.write({"id": "old", "status": "wait", "title": "옛 항목"})
        done = self.run_board("set", "old", "doing")
        self.assertNotEqual(0, done.returncode)
        self.assertIn("진행률이 필요하다", done.stderr)
        self.assertIn("--next '1. 구현'", done.stderr)
        self.assertIn("--progress", done.stderr)
        self.assertEqual("wait", self.item("old")["status"])
        done = self.run_board("set", "new", "doing", "--title", "새 항목")
        self.assertNotEqual(0, done.returncode)
        self.assertEqual(["old"], [i["id"] for i in json.loads(self.file.read_text(encoding="utf-8"))["items"]])

    def test_set_doing_with_steps_or_progress_is_accepted(self):
        self.write()
        done = self.run_board("set", "a", "doing", "--next", "1. 구현", "--next", "2. 머지")
        self.assertEqual(0, done.returncode, done.stderr)
        self.assertEqual("1. 구현\n2. 머지", self.item("a")["next"])
        self.assertEqual(0, self.run_board("set", "b", "doing", "--progress", "2/5").returncode)
        self.assertEqual(0, self.run_board("set", "c", "doing", "--detail", "✓ 1 a", "--detail", "2 b").returncode)

    def test_progress_must_be_a_fraction(self):
        self.write()
        done = self.run_board("set", "a", "doing", "--progress", "거의 완료")
        self.assertNotEqual(0, done.returncode)
        self.assertIn("끝낸단계/전체단계", done.stderr)

    def test_old_doing_item_is_kept_until_it_is_set(self):
        self.write({"id": "old", "status": "doing", "progress": "거의 완료"}, {"id": "w", "status": "wait"})
        self.assertEqual(0, self.run_board("set", "w", "--title", "대기").returncode)
        self.assertEqual("doing", self.item("old")["status"])
        self.assertNotEqual(0, self.run_board("set", "old", "--pr", "#1").returncode)
        self.assertEqual(0, self.run_board("set", "old", "done").returncode)

    def test_list_shows_progress_per_item(self):
        self.write({"id": "a", "status": "doing", "next": "✓ 1. a\n[x] 2. b\n3. c"},
                   {"id": "b", "status": "doing", "progress": "1/4"},
                   {"id": "c", "status": "wait"})
        lines = self.run_board("list").stdout.splitlines()
        self.assertTrue(lines[0].endswith("2/3 (67%)"), lines[0])
        self.assertTrue(lines[1].endswith("1/4 (25%)"), lines[1])
        self.assertTrue(lines[2].endswith("진행률 없음"), lines[2])


if __name__ == "__main__":
    unittest.main()
