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


def rows(*values):
    return [{"text": text, "done": done} for text, done in values]


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
        self.assertEqual(rows(("1. 구현", True), ("2. 리뷰 반영", False), ("3. 머지", False)), self.item("up")["next"])
        self.run_board("step", "up", "1", "--undo")
        self.assertEqual(rows(("1. 구현", False), ("2. 리뷰 반영", False), ("3. 머지", False)), self.item("up")["next"])

    def test_step_prefers_detail_steps_over_next(self):
        self.write({"id": "g", "status": "doing", "next": "1. 할 일 목록", "details": ["1 a", "2 b"]})
        self.run_board("step", "g", "1")
        self.assertEqual(rows(("1 a", True), ("2 b", False)), self.item("g")["details"])
        self.assertEqual(rows(("1. 할 일 목록", False)), self.item("g")["next"])

    def test_step_updates_checkbox_done_value(self):
        self.write({"id": "c", "status": "doing", "details": ["[ ] 1. a", "[ ] 2) b"]})
        self.run_board("step", "c", "2")
        self.assertEqual(rows(("1. a", False), ("2) b", True)), self.item("c")["details"])
        self.run_board("step", "c", "2", "--undo")
        self.assertEqual(rows(("1. a", False), ("2) b", False)), self.item("c")["details"])

    def test_step_replaces_in_progress_mark(self):
        self.write({"id": "m", "status": "doing", "details": ["▶ 1 a", "◇ 2 b"]})
        self.run_board("step", "m", "1")
        self.assertEqual(rows(("1 a", True), ("2 b", False)), self.item("m")["details"])

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
        self.assertEqual([{"number": 1, "done": True, "text": "1 a"}, {"number": 2, "done": False, "text": "2. b #7"}],
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
        self.assertEqual(rows(("1. 구현", False), ("2. 머지", False)), self.item("a")["next"])
        self.assertEqual(0, self.run_board("set", "b", "doing", "--progress", "2/5").returncode)
        self.assertEqual(0, self.run_board("set", "c", "doing", "--detail", "✓ 1 a", "--detail", "2 b").returncode)

    def test_set_normalizes_marks_and_clears_fields(self):
        result = self.run_board("set", "a", "doing", "--next", "[X] 1. 구현\n[ ] 2. 머지",
                                "--detail", "✓ 참고", "--detail", "▶ 3 검증", "--detail", "◇ 4 배포")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(rows(("1. 구현", True), ("2. 머지", False)), self.item("a")["next"])
        self.assertEqual(rows(("참고", True), ("3 검증", False), ("4 배포", False)), self.item("a")["details"])
        result = self.run_board("set", "a", "wait", "--next", "", "--detail", "")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("next", self.item("a"))
        self.assertNotIn("details", self.item("a"))

    def test_mixed_formats_migrate_on_write_and_objects_keep_done(self):
        self.write({"id": "a", "status": "doing", "details": ["[x] 1 a", {"text": "2 b", "done": False},
                    {"text": "3 c", "done": True}, "참고"]},
                   {"id": "b", "status": "wait", "next": "✓ 1 d"})
        before = self.file.read_bytes()
        self.assertTrue(self.run_board("list").stdout.splitlines()[0].endswith("2/3 (67%)"))
        self.assertEqual(before, self.file.read_bytes())
        result = self.run_board("step", "a", "2")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(rows(("1 a", True), ("2 b", True), ("3 c", True), ("참고", False)), self.item("a")["details"])
        self.assertEqual(rows(("1 d", True)), self.item("b")["next"])
        before = self.file.read_bytes()
        self.assertNotEqual(0, self.run_board("step", "a", "9").returncode)
        self.assertEqual(before, self.file.read_bytes())

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
