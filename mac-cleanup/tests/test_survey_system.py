"""survey_system.py 의 순수 함수(파싱, 집계)를 검증한다. 실제 시스템을 읽지 않는다."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import survey_system as sy  # noqa: E402


class HumanSizeTest(unittest.TestCase):
    def test_units(self):
        self.assertEqual(sy.human_kb(512), "512K")
        self.assertEqual(sy.human_kb(1536), "1.5M")
        self.assertEqual(sy.human_kb(20 * 1024), "20M")
        self.assertEqual(sy.human_kb(5 * 1024 * 1024), "5.0G")


class DuParseTest(unittest.TestCase):
    def test_parse_skips_garbage_and_keeps_spaces_in_path(self):
        out = "100\t/a/b c\nnot a row\n\n7\t/a/d\n"
        self.assertEqual(sy.parse_du_kb(out), [(100, "/a/b c"), (7, "/a/d")])

    def test_top_dirs_orders_by_size_then_path(self):
        rows = [(5, "/b"), (9, "/a"), (5, "/a2"), (1, "/z")]
        self.assertEqual(sy.top_dirs(rows, 3), [(9, "/a"), (5, "/a2"), (5, "/b")])

    def test_dot_directories_are_kept_without_glob(self):
        # 점으로 시작하는 디렉터리도 du 출력에 있으면 그대로 후보가 된다. glob 을 쓰지 않으므로 맞는 것이 없어도 실패하지 않는다.
        rows = sy.parse_du_kb("10\t/h/.cache\n20\t/h/proj\n")
        self.assertIn((10, "/h/.cache"), sy.top_dirs(rows, 5))


class RssTest(unittest.TestCase):
    def test_app_name(self):
        self.assertEqual(sy.app_name("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --x"), "Google Chrome")
        self.assertEqual(sy.app_name("/usr/bin/python3 script.py"), "python3")
        self.assertEqual(sy.app_name(""), "?")

    def test_rss_by_app_sums_and_skips_bad_rows(self):
        out = "100 /A/Foo.app/Contents/x\n 50 /A/Foo.app/Contents/y\n  7 /bin/zsh -l\nbad row\n12\n"
        self.assertEqual(sy.rss_by_app(out), {"Foo": 150, "zsh": 7})


class VmStatTest(unittest.TestCase):
    def test_parse(self):
        out = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
               "Pages occupied by compressor:                 123456.\n")
        self.assertEqual(sy.parse_vm_stat(out), (16384, 123456))

    def test_missing_values_are_none(self):
        self.assertEqual(sy.parse_vm_stat(""), (None, None))


if __name__ == "__main__":
    unittest.main()
