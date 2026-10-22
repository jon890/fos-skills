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


if __name__ == "__main__":
    unittest.main()
