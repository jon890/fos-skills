#!/usr/bin/env python3
"""collect_review.py 인자 해석 검사."""

import importlib.util
import sys
import unittest
from unittest.mock import patch
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


class KnownTarget(unittest.TestCase):
    def test_explicit_target_controls_every_collection_command(self):
        for target in [["https://github.com/o/r/pull/5"], ["github.com/o/r", "5"]]:
            with self.subTest(target=target), \
                    patch.object(cr.gh_host, "resolve", return_value="github.com") as resolve, \
                    patch.object(cr, "run", return_value=0) as run:
                self.assertEqual(cr.main(["collect_review.py", *target]), 0)
                resolve.assert_called_once_with("o", "r", host="github.com")
                self.assertGreater(len(run.call_args_list), 0)
                for call in run.call_args_list:
                    self.assertEqual(call.args[2], {"GH_HOST": "github.com"})

    def test_invalid_pr_url_is_rejected(self):
        self.assertIsNone(cr.parse_args(["collect_review.py", "https://github.com/o/r/issues/5"]))


if __name__ == "__main__":
    unittest.main()
