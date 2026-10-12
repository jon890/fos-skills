#!/usr/bin/env python3
"""collect_review.py 인자 해석 검사."""

import importlib.util
import sys
import unittest
from pathlib import Path

scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("collect_review", scripts / "collect_review.py")
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)


class ParseArgs(unittest.TestCase):
    def parse(self, *args):
        return cr.parse_args(["collect_review.py", *args])

    def test_plain(self):
        self.assertEqual(self.parse("o", "r", "5"), ("o", "r", "5", [], None))

    def test_carried_from_takes_several_numbers(self):
        self.assertEqual(self.parse("o", "r", "5", "--carried-from", "3", "4"),
                         ("o", "r", "5", ["3", "4"], None))

    def test_options_before_positionals_and_marker(self):
        self.assertEqual(self.parse("--carried-from", "3", "--carried-marker", "후속", "o", "r", "5"),
                         ("o", "r", "5", ["3"], "후속"))

    def test_carried_from_without_number_is_error(self):
        self.assertIsNone(self.parse("o", "r", "5", "--carried-from"))

    def test_marker_without_value_is_error(self):
        self.assertIsNone(self.parse("o", "r", "5", "--carried-marker"))

    def test_wrong_positional_count_is_error(self):
        self.assertIsNone(self.parse("o", "r"))


if __name__ == "__main__":
    unittest.main()
