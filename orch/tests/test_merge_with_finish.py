"""merge-with-finish.py 가 PR 인자를 해석하고, 마무리를 PR 마다 한 번만 걸고, 머지 큐에 `!` 를 뗀 인자를 넘기는지 본다.

머지 큐와 마무리는 인자를 기록하는 가짜 스크립트로 바꾼다. GitHub 와 Orca 에는 닿지 않는다.
"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
WRAPPER = SCRIPTS / "merge-with-finish.py"
SPEC = importlib.util.spec_from_file_location("merge_with_finish", WRAPPER)
mwf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mwf)


class ParseTest(unittest.TestCase):
    def test_queue_spec_forms(self):
        self.assertEqual(("449", False, "449"), mwf.parse_queue_spec("449"))
        self.assertEqual(("449", True, "449"), mwf.parse_queue_spec("449!"))
        self.assertEqual(("102", False, "102:./bin/backup.sh a:b"), mwf.parse_queue_spec("102:./bin/backup.sh a:b"))
        self.assertEqual(("446", True, '446:./backup.sh "pre-446"'), mwf.parse_queue_spec('446!:./backup.sh "pre-446"'))

    def test_not_a_pr(self):
        for arg in ("abc", "12a", "!449", "449!!", ""):
            with self.subTest(arg=arg):
                self.assertIsNone(mwf.parse_queue_spec(arg))

    def test_split_separates_wrapper_options_from_queue_options(self):
        wrapper, queue, prs = mwf.split_args(
            ["--repo", "/r", "--check-timeout", "30", "--finish-arg=--run", "--finish-arg", "run_1",
             "--require-up-to-date", "--finish-config", "/c.json", "--finish-log-dir", "/logs", "101", "102!"])
        self.assertEqual(["--repo", "/r", "--check-timeout", "30", "--require-up-to-date", "101", "102"], queue)
        self.assertEqual([("101", False), ("102", True)], prs)
        self.assertEqual("/r", wrapper["repo"])
        self.assertEqual(["--run", "run_1"], wrapper["finish_arg"])
        self.assertEqual("/c.json", wrapper["finish_config"])
        self.assertEqual("/logs", wrapper["log_dir"])

    def test_option_value_that_looks_like_a_pr_number_is_not_a_pr(self):
        _, queue, prs = mwf.split_args(["--check-timeout", "30", "--sweep-arg", "5", "7"])
        self.assertEqual([("7", False)], prs)
        self.assertEqual(["--check-timeout", "30", "--sweep-arg", "5", "7"], queue)

    def test_errors(self):
        for argv in (["--repo"], ["--finish-arg"], ["abc"], ["--board-item", "x"], ["--board-item", "5="], ["--board-item"]):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                mwf.split_args(argv)

    def test_value_options_match_merge_queue(self):
        """merge-queue.sh 가 값을 받는 옵션이 바뀌면 이 목록도 바꿔야 PR 번호 해석이 어긋나지 않는다."""
        script = (SCRIPTS / "merge-queue.sh").read_text(encoding="utf-8")
        valued = set(re.findall(r'^\s+(--[a-z-]+)\) need "\$1"', script, re.M))
        self.assertEqual(valued, mwf.VALUE_OPTIONS)


FAKE_QUEUE_SH = """\
echo "queue $*" >> "$FAKE_LOG"
exit "${FAKE_QUEUE_EXIT:-0}"
"""
FAKE_FINISH = """\
import os, sys, time
open(os.environ["FAKE_LOG"], "a").write("finish " + " ".join(sys.argv[1:]) + "\\n")
pid = sys.argv[sys.argv.index("--pid-file") + 1]
open(pid, "w").write(str(os.getpid()))
time.sleep(float(os.environ.get("FAKE_FINISH_SLEEP", "0")))
"""


class WrapperRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / "queue.sh").write_text(FAKE_QUEUE_SH)
        (self.tmp / "finish.py").write_text(FAKE_FINISH)
        self.log = self.tmp / "log.txt"
        self.logs = self.tmp / "logs"
        self.env = dict(os.environ, MERGE_QUEUE=str(self.tmp / "queue.sh"), FINISH_PR=str(self.tmp / "finish.py"),
                        FAKE_LOG=str(self.log))

    def wrap(self, *args, **env):
        done = subprocess.run(["python3", str(WRAPPER), "--finish-log-dir", str(self.logs), *args],
                              capture_output=True, text=True, env=dict(self.env, **env))
        return done.returncode, done.stdout + done.stderr

    def lines(self, prefix):
        deadline = time.time() + 5
        while time.time() < deadline:
            found = [l for l in (self.log.read_text().splitlines() if self.log.exists() else []) if l.startswith(prefix)]
            if found:
                return found
            time.sleep(0.05)
        return []

    def test_starts_finish_per_pr_and_passes_bang_free_args_to_the_queue(self):
        code, out = self.wrap("--repo", str(self.tmp), "--required", "ci", "449!", "450")
        self.assertEqual(0, code, out)
        self.assertEqual([f"queue --repo {self.tmp} --required ci 449 450"], self.lines("queue"))
        deadline = time.time() + 5
        finish = []
        while time.time() < deadline and len(finish) < 2:
            finish = self.lines("finish")
            time.sleep(0.05)
        self.assertEqual(2, len(finish), finish)
        by_pr = {l.split()[1]: l for l in finish}
        self.assertIn("--complete", by_pr["449"])
        self.assertNotIn("--complete", by_pr["450"])
        self.assertIn(f"--repo {self.tmp}", by_pr["449"])
        self.assertIn(f"--pid-file {self.logs}/finish-449.pid", by_pr["449"])
        self.assertIn("finish-449.out", out)

    def test_extra_finish_args_and_config_are_forwarded(self):
        self.wrap("--finish-config", "/c.json", "--finish-arg=--run", "--finish-arg", "run_1", "449")
        line = self.lines("finish")[0]
        self.assertIn("--config /c.json", line)
        self.assertIn("--run run_1", line)

    def test_board_item_is_passed_to_that_pr_only(self):
        self.wrap("--board-item", "449=item-1", "--board-item=450=item-2", "449", "450", "451")
        deadline = time.time() + 5
        while time.time() < deadline and len(self.lines("finish")) < 3:
            time.sleep(0.05)
        by_pr = {l.split()[1]: l for l in self.lines("finish")}
        self.assertIn("--board-id item-1", by_pr["449"])
        self.assertIn("--board-id item-2", by_pr["450"])
        self.assertNotIn("--board-id", by_pr["451"])

    def test_running_finish_is_not_started_twice(self):
        self.wrap("449", FAKE_FINISH_SLEEP="30")
        self.assertEqual(1, len(self.lines("finish")))
        pid = int((self.logs / "finish-449.pid").read_text())
        try:
            code, out = self.wrap("449")
            self.assertEqual(0, code)
            self.assertIn("이미 돌고 있다", out)
            time.sleep(0.3)
            self.assertEqual(1, len(self.lines("finish")))
        finally:
            os.kill(pid, 15)

    def test_stale_pid_file_does_not_block_a_new_finish(self):
        self.logs.mkdir()
        (self.logs / "finish-449.pid").write_text("999999")
        self.wrap("449")
        self.assertEqual(1, len(self.lines("finish")))

    def test_no_finish_runs_only_the_queue(self):
        code, _ = self.wrap("--no-finish", "449!")
        self.assertEqual(0, code)
        self.assertEqual(["queue 449"], self.lines("queue"))
        time.sleep(0.3)
        self.assertEqual(["queue 449"], self.log.read_text().splitlines())

    def test_exit_code_of_the_queue_is_returned(self):
        self.assertEqual(1, self.wrap("449", FAKE_QUEUE_EXIT="1")[0])

    def test_usage_errors(self):
        self.assertEqual(2, self.wrap()[0])
        self.assertEqual(2, self.wrap("abc")[0])
        self.assertFalse(self.log.exists())


if __name__ == "__main__":
    unittest.main()
