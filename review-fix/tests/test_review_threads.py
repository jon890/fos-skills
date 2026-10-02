#!/usr/bin/env python3
"""review_threads list --count 검사."""

import contextlib
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("review_threads", scripts / "review_threads.py")
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)


def response(resolved_flags, total=None):
    nodes = [{"id": f"T{i}", "isResolved": r, "isOutdated": False, "path": "a.py", "line": i,
              "comments": {"nodes": [{"author": {"login": "bot"}, "body": "x"}]}}
             for i, r in enumerate(resolved_flags)]
    data = {"data": {"repository": {"pullRequest": {"reviewThreads": {
        "totalCount": total if total is not None else len(nodes), "nodes": nodes}}}}}
    return json.dumps(data)


def run_main(argv, out):
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.object(rt.gh_host, "resolve", return_value="github.com"), \
            patch.object(rt, "gh", return_value=(0, out, "")), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = rt.main(["review_threads.py", *argv])
    return code, stdout.getvalue(), stderr.getvalue()


class TestCount(unittest.TestCase):
    def test_list_count_is_unresolved_only(self):
        code, out, _ = run_main(["list", "--count", "o", "r", "1"], response([False, True, False]))
        self.assertEqual((code, out), (0, "2\n"))

    def test_list_count_zero_when_all_resolved(self):
        code, out, _ = run_main(["list", "o", "r", "1", "--count"], response([True, True]))
        self.assertEqual((code, out), (0, "0\n"))

    def test_list_all_count_includes_resolved(self):
        code, out, _ = run_main(["list-all", "--count", "o", "r", "1"], response([False, True]))
        self.assertEqual((code, out), (0, "2\n"))

    def test_truncated_count_fails_instead_of_reporting_a_number(self):
        code, out, err = run_main(["list", "--count", "o", "r", "1"], response([True], total=150))
        self.assertEqual((code, out), (1, ""))
        self.assertIn("150", err)

    def test_list_without_count_keeps_compact_json_lines(self):
        code, out, _ = run_main(["list", "o", "r", "1"], response([False, True]))
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(len(lines), 1)
        self.assertIn('"resolved":false', lines[0])


if __name__ == "__main__":
    unittest.main()
