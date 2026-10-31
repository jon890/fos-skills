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

    def test_outdated_thread_falls_back_to_original_line(self):
        data = json.loads(response([False, False]))
        nodes = data["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        nodes[0].update(line=None, originalLine=7, isOutdated=True)
        nodes[1].update(line=12, originalLine=9)
        code, out, _ = run_main(["list", "o", "r", "1"], json.dumps(data))
        self.assertEqual(code, 0)
        lines = [json.loads(l) for l in out.splitlines()]
        self.assertEqual([l["line"] for l in lines], [7, 12])


def carried_response(threads):
    nodes = [{"id": tid, "isResolved": resolved, "path": "a.py", "line": 3,
              "comments": {"nodes": [{"author": {"login": "bot"}, "body": "지적", "url": "u0"}] +
                           [{"author": {"login": "me"}, "body": b, "url": f"u{i}"}
                            for i, b in enumerate(replies, 1)]}}
             for tid, resolved, replies in threads]
    return json.dumps({"data": {"repository": {"pullRequest": {"reviewThreads": {
        "totalCount": len(nodes), "nodes": nodes}}}}})


def show_response(comments, total=None, thread=True):
    node = {"id": "T1", "isResolved": False, "isOutdated": True, "path": "a.py",
            "line": None, "originalLine": 9,
            "comments": {"totalCount": total if total is not None else len(comments),
                         "nodes": [{"author": {"login": a}, "body": b, "url": f"u{i}"}
                                   for i, (a, b) in enumerate(comments)]}}
    if not thread:
        node = {}
    return json.dumps({"data": {"node": node}})


class TestShow(unittest.TestCase):
    def test_prints_full_body_past_head_len_with_all_comments(self):
        long_body = "근거 " * 100 + "\n둘째 줄"
        out = show_response([("bot", long_body), ("me", "반영했다")])
        code, stdout, _ = run_main(["show", "T1"], out)
        self.assertEqual(code, 0)
        self.assertGreater(len(long_body), rt.HEAD_LEN)
        self.assertIn(long_body, stdout)
        self.assertIn("반영했다", stdout)
        header = json.loads(stdout.splitlines()[0])
        self.assertEqual((header["id"], header["line"], header["comments"]), ("T1", 9, 2))
        self.assertIn("--- 1. bot u0", stdout)
        self.assertIn("--- 2. me u1", stdout)

    def test_non_thread_node_fails(self):
        code, out, err = run_main(["show", "X"], show_response([], thread=False))
        self.assertEqual((code, out), (1, ""))
        self.assertIn("X", err)

    def test_requires_exactly_one_thread_id(self):
        code, _, _ = run_main(["show"], "{}")
        self.assertEqual(code, 2)

    def test_truncated_comments_warn_on_stderr(self):
        code, _, err = run_main(["show", "T1"], show_response([("bot", "x")], total=150))
        self.assertEqual(code, 0)
        self.assertIn("150", err)

    def test_list_head_contract_stays_truncated(self):
        data = json.loads(response([False]))
        data["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0][
            "comments"]["nodes"][0]["body"] = "가" * 300
        _, out, _ = run_main(["list", "o", "r", "1"], json.dumps(data))
        self.assertEqual(len(json.loads(out)["head"]), rt.HEAD_LEN)


class TestCarried(unittest.TestCase):
    def test_lists_only_threads_whose_reply_has_marker_including_resolved(self):
        out = carried_response([("T1", True, ["다음 PR 에서 반영한다"]),
                                ("T2", False, ["반영했다"]),
                                ("T3", False, [])])
        code, stdout, _ = run_main(["carried", "o", "r", "7"], out)
        self.assertEqual(code, 0)
        lines = stdout.splitlines()
        self.assertEqual(len(lines), 1)
        self.assertIn('"id":"T1"', lines[0])
        self.assertIn('"pr":7', lines[0])

    def test_first_comment_with_marker_is_not_a_reply(self):
        nodes = json.loads(carried_response([("T1", False, [])]))
        nodes["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0][
            "comments"]["nodes"][0]["body"] = "다음 PR"
        code, stdout, _ = run_main(["carried", "o", "r", "7"], json.dumps(nodes))
        self.assertEqual((code, stdout), (0, ""))

    def test_custom_marker(self):
        out = carried_response([("T1", False, ["후속 처리"])])
        code, stdout, _ = run_main(["carried", "o", "r", "7", "--marker", "후속"], out)
        self.assertEqual(code, 0)
        self.assertIn('"id":"T1"', stdout)


class TestReplyBatch(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        for name in ("a.md", "b.md", "c.md"):
            (self.dir / name).write_text(name)

    def map_file(self, text):
        path = self.dir / "map.tsv"
        path.write_text(text)
        return str(path)

    def run_batch(self, text, fail_ids=()):
        calls = []

        def fake_gh(*args, env=None):
            tid = next(a.split("=", 1)[1] for a in args if a.startswith("threadId="))
            calls.append(tid)
            if tid in fail_ids:
                return 1, "", "boom"
            return 0, f"https://x/{tid}\n", ""

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(rt.gh_host, "resolve", return_value="github.com"), \
                patch.object(rt, "gh", side_effect=fake_gh), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = rt.main(["review_threads.py", "reply-batch", self.map_file(text)])
        return code, calls, stdout.getvalue(), stderr.getvalue()

    def test_all_succeed(self):
        code, calls, out, _ = self.run_batch("T1\ta.md\n# 주석\n\nT2\tb.md\n")
        self.assertEqual((code, calls), (0, ["T1", "T2"]))
        self.assertIn("https://x/T2", out)

    def test_failure_is_named_and_remaining_still_run(self):
        code, calls, _, err = self.run_batch("T1\ta.md\nT2\tb.md\nT3\tc.md\n", fail_ids={"T2"})
        self.assertEqual((code, calls), (1, ["T1", "T2", "T3"]))
        self.assertIn("줄 2 T2", err)
        self.assertIn("1/3", err)

    def test_missing_body_file_counts_as_failure(self):
        code, calls, _, err = self.run_batch("T1\tnope.md\nT2\tb.md\n")
        self.assertEqual((code, calls), (1, ["T2"]))
        self.assertIn("줄 1 T1", err)

    def test_malformed_line_counts_as_failure(self):
        code, calls, _, err = self.run_batch("T1 a.md\nT2\tb.md\n")
        self.assertEqual((code, calls), (1, ["T2"]))
        self.assertIn("줄 1", err)

    def test_empty_map_is_usage_error(self):
        code, calls, _, _ = self.run_batch("# 비었다\n")
        self.assertEqual((code, calls), (2, []))


class TestResolveIds(unittest.TestCase):
    def run_resolve(self, args, stdin=""):
        calls = []

        def fake_gh(*a, env=None):
            calls.append(next(x.split("=", 1)[1] for x in a if x.startswith("threadId=")))
            return 0, f"{calls[-1]} resolved=true\n", ""

        with patch.object(rt.gh_host, "resolve", return_value="github.com"), \
                patch.object(rt, "gh", side_effect=fake_gh), \
                patch.object(rt.sys, "stdin", io.StringIO(stdin)), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = rt.main(["review_threads.py", "resolve", "--repo", "o/r", *args])
        return code, calls

    def test_separate_args(self):
        self.assertEqual(self.run_resolve(["T1", "T2"]), (0, ["T1", "T2"]))

    def test_zsh_unsplit_variable_arrives_as_one_arg(self):
        # zsh 에서 IDS="T1 T2"; resolve $IDS 는 인자 하나로 온다
        self.assertEqual(self.run_resolve(["T1 T2"]), (0, ["T1", "T2"]))

    def test_dash_reads_stdin(self):
        self.assertEqual(self.run_resolve(["-"], "T1\nT2\n\n"), (0, ["T1", "T2"]))

    def test_empty_stdin_is_usage_error(self):
        self.assertEqual(self.run_resolve(["-"], "\n"), (2, []))


if __name__ == "__main__":
    unittest.main()
