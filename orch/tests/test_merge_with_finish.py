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
        """merge_queue.py 가 값을 받는 옵션이 바뀌면 이 목록도 바꿔야 PR 번호 해석이 어긋나지 않는다."""
        spec = importlib.util.spec_from_file_location("merge_queue", SCRIPTS / "merge_queue.py")
        queue = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(queue)
        self.assertEqual(queue.VALUE_OPTIONS, mwf.VALUE_OPTIONS)


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

    def write_config(self, queue):
        (self.tmp / ".claude").mkdir(exist_ok=True)
        (self.tmp / ".claude" / "orch-finish.json").write_text(json.dumps({"finish": {}, "queue": queue}))

    def test_queue_section_fills_missing_queue_options(self):
        self.write_config({"required": ["ci", "lint"], "verify_merged": 'cd "$1" && make test',
                           "verify_merged_when": "code", "docs_glob": ["docs/*", "*.md"], "method": "squash",
                           "before": "true"})
        code, out = self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        self.assertEqual(0, code, out)
        line = self.lines("queue")[0]
        for part in ("--required ci,lint", '--verify-merged cd "$1" && make test', "--verify-merged-when code",
                     "--docs-glob docs/*,*.md", "--method squash", "--before true"):
            self.assertIn(part, line)
        self.assertTrue(line.endswith(f"--repo {self.tmp} 449"), line)

    def test_queue_section_after_merged_and_skipped_flag(self):
        self.write_config({"after_merged": "bash deploy.sh", "skipped_is_missing": True})
        self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        line = self.lines("queue")[0]
        self.assertIn("--after-merged bash deploy.sh", line)
        self.assertIn("--skipped-is-missing", line)
        self.log.unlink()
        self.write_config({"skipped_is_missing": False})
        self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        self.assertNotIn("--skipped-is-missing", self.lines("queue")[0])

    def test_command_line_wins_over_queue_section(self):
        self.write_config({"required": "ci", "method": "squash"})
        self.wrap("--repo", str(self.tmp), "--no-finish", "--method", "merge", "449")
        line = self.lines("queue")[0]
        self.assertIn("--required ci", line)
        self.assertNotIn("squash", line)

    def test_queue_section_can_enable_docs_overlap_update(self):
        self.write_config({"required": "ci", "docs_glob": ["docs/*", "*.md"], "update_docs_on_overlap": True})
        code, out = self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        self.assertEqual(0, code, out)
        self.assertIn("--update-docs-on-overlap", self.lines("queue")[0])
        self.log.unlink()
        self.write_config({"update_docs_on_overlap": False})
        self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        self.assertNotIn("--update-docs-on-overlap", self.lines("queue")[0])

    def test_queue_section_passes_overlap_options(self):
        self.write_config({"require_up_to_date": True, "up_to_date_when": "overlap", "unit_prefix": "apps/",
                           "shared_paths": ["^apps/common/", r"^build\.gradle$"], "required": "ci"})
        code, out = self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        self.assertEqual(0, code, out)
        line = self.lines("queue")[0]
        for part in ("--require-up-to-date", "--up-to-date-when overlap", "--unit-prefix apps/",
                     r"--shared-paths ^apps/common/|^build\.gradle$"):
            self.assertIn(part, line)
        self.log.unlink()
        self.write_config({"shared_paths": "^lib/", "require_up_to_date": False})
        self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        line = self.lines("queue")[0]
        self.assertIn("--shared-paths ^lib/", line)
        self.assertNotIn("--require-up-to-date", line)

    def test_queue_section_unit_groups_become_repeated_options(self):
        self.write_config({"unit_groups": [["web", "bff"], ["a", "b", "c"]]})
        self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        self.assertIn("--unit-group web,bff --unit-group a,b,c", self.lines("queue")[0])
        self.log.unlink()
        self.wrap("--repo", str(self.tmp), "--no-finish", "--unit-group", "x,y", "449")
        line = self.lines("queue")[0]
        self.assertIn("--unit-group x,y", line)
        self.assertNotIn("web", line)

    def test_command_line_wins_over_overlap_keys(self):
        self.write_config({"up_to_date_when": "overlap", "unit_prefix": "apps/"})
        self.wrap("--repo", str(self.tmp), "--no-finish", "--up-to-date-when", "always", "449")
        line = self.lines("queue")[0]
        self.assertIn("--up-to-date-when always", line)
        self.assertNotIn("overlap", line)
        self.assertIn("--unit-prefix apps/", line)

    def test_sweep_args_become_repeated_sweep_arg_options(self):
        self.write_config({"sweep_args": ["--run", "run_x", "--specs-dir", ".omc/specs"]})
        self.wrap("--repo", str(self.tmp), "--no-finish", "449")
        self.assertIn("--sweep-arg --run --sweep-arg run_x --sweep-arg --specs-dir --sweep-arg .omc/specs",
                      self.lines("queue")[0])

    def test_sweep_arg_on_the_command_line_replaces_the_list(self):
        self.write_config({"sweep_args": ["--run", "run_x"]})
        self.wrap("--repo", str(self.tmp), "--no-finish", "--sweep-arg", "--kill-holders", "449")
        line = self.lines("queue")[0]
        self.assertIn("--sweep-arg --kill-holders", line)
        self.assertNotIn("run_x", line)

    def test_bad_overlap_and_sweep_values_are_usage_errors(self):
        for queue in ({"sweep_args": "--run"}, {"sweep_args": [1]}, {"sweep_args": [""]}, {"up_to_date_when": ""},
                      {"shared_paths": []}, {"require_up_to_date": "yes"}, {"unit_groups": []},
                      {"unit_groups": ["web,bff"]}, {"unit_groups": [["web"]]}, {"unit_groups": [["a,b", "c"]]}):
            with self.subTest(queue=queue):
                self.write_config(queue)
                code, out = self.wrap("--repo", str(self.tmp), "449")
                self.assertEqual(2, code, out)
                self.assertFalse(self.log.exists())

    def write_board(self, items, name=".omc/board.json"):
        target = self.tmp / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"items": items}))

    def finish_lines(self, count):
        deadline = time.time() + 5
        while time.time() < deadline and len(self.lines("finish")) < count:
            time.sleep(0.05)
        return {l.split()[1]: l for l in self.lines("finish")}

    def test_board_item_is_found_by_pr_and_used_only_for_the_last_pr(self):
        self.write_board([{"id": "task-a", "pr": "#492, #495"}, {"id": "task-b", "pr": "500"}, {"id": "none"}])
        code, out = self.wrap("--repo", str(self.tmp), "492", "495!", "500!", "501!")
        self.assertEqual(0, code, out)
        by_pr = self.finish_lines(4)
        self.assertNotIn("--board-id", by_pr["492"])
        self.assertIn("--board-id task-a", by_pr["495"])
        self.assertIn("--board-id task-b", by_pr["500"])
        self.assertNotIn("--board-id", by_pr["501"])
        self.assertIn("보드 항목 task-a 는 PR 492 가 업무의 마지막 PR(!)이 아니라", out)

    def test_numeric_board_ids_are_passed_as_strings(self):
        self.write_board([{"id": 7, "pr": "492"}, {"id": 8, "pr": "495"}, {"id": 9, "pr": "495"}])
        code, out = self.wrap("--repo", str(self.tmp), "492!", "495!")
        self.assertEqual(0, code, out)
        self.assertNotIn("Traceback", out)
        self.assertIn("--board-id 7", self.finish_lines(2)["492"])
        # 항목이 둘 이상이라 건너뛸 때 안내 줄이 숫자 id 로 깨지지 않는다
        self.assertIn("보드 항목이 둘 이상이라 건너뛴다: PR 495 -> 8, 9", out)

    def test_pr_field_numbers_are_not_glued_together(self):
        for field, expected in (("#492 495", {"492", "495"}), ("492/495", {"492", "495"}), ("#492 (v2)", {"492"}),
                                ("492, #495", {"492", "495"}), ("", set()), (None, set())):
            with self.subTest(field=field):
                self.assertEqual(expected, mwf.pr_numbers(field))

    def test_explicit_board_item_wins_and_ignores_the_bang(self):
        self.write_board([{"id": "found", "pr": "492"}])
        self.wrap("--repo", str(self.tmp), "--board-item", "492=explicit", "492", "493")
        by_pr = self.finish_lines(2)
        self.assertIn("--board-id explicit", by_pr["492"])

    def test_ambiguous_board_items_are_skipped(self):
        self.write_board([{"id": "a", "pr": "7"}, {"id": "b", "pr": "#7"}])
        code, out = self.wrap("--repo", str(self.tmp), "7!")
        self.assertEqual(0, code, out)
        self.assertNotIn("--board-id", self.finish_lines(1)["7"])
        self.assertIn("보드 항목이 둘 이상이라 건너뛴다: PR 7 -> a, b", out)

    def test_board_file_follows_finish_arg_then_finish_section_then_nested_default(self):
        self.write_board([{"id": "plain", "pr": "9"}])
        self.write_board([{"id": "nested", "pr": "9"}], ".omc/handoffs/board.json")
        self.wrap("--repo", str(self.tmp), "9!")
        self.assertIn("--board-id nested", self.finish_lines(1)["9"])
        self.log.unlink()
        shutil.rmtree(self.logs)
        self.write_board([{"id": "configured", "pr": "9"}], "boards/main.json")
        (self.tmp / ".claude").mkdir(exist_ok=True)
        (self.tmp / ".claude" / "orch-finish.json").write_text(json.dumps({"finish": {"board": "boards/main.json"}}))
        self.wrap("--repo", str(self.tmp), "9!")
        self.assertIn("--board-id configured", self.finish_lines(1)["9"])
        self.log.unlink()
        shutil.rmtree(self.logs)
        self.write_board([{"id": "arg", "pr": "9"}], "boards/other.json")
        self.wrap("--repo", str(self.tmp), "--finish-arg=--board=boards/other.json", "9!")
        self.assertIn("--board-id arg", self.finish_lines(1)["9"])

    def test_missing_or_broken_board_is_not_an_error(self):
        code, out = self.wrap("--repo", str(self.tmp), "9!")
        self.assertEqual(0, code, out)
        self.assertNotIn("--board-id", self.finish_lines(1)["9"])
        self.log.unlink()
        shutil.rmtree(self.logs)
        (self.tmp / ".omc").mkdir(exist_ok=True)
        (self.tmp / ".omc" / "board.json").write_text("{broken")
        code, out = self.wrap("--repo", str(self.tmp), "9!")
        self.assertEqual(0, code, out)
        self.assertNotIn("--board-id", self.finish_lines(1)["9"])

    def test_finish_config_option_picks_the_file(self):
        other = self.tmp / "other.json"
        other.write_text(json.dumps({"queue": {"method": "rebase"}}))
        self.write_config({"method": "squash"})
        self.wrap("--repo", str(self.tmp), "--no-finish", "--finish-config", str(other), "449")
        self.assertIn("--method rebase", self.lines("queue")[0])

    def test_bad_queue_section_is_usage_error_before_anything_starts(self):
        for queue in ({"verify": "x"}, {"method": 3}, {"required": ""}, [], {"skipped_is_missing": "yes"}):
            with self.subTest(queue=queue):
                self.write_config(queue)
                code, out = self.wrap("--repo", str(self.tmp), "449")
                self.assertEqual(2, code, out)
                self.assertFalse(self.log.exists())

    def test_usage_errors(self):
        self.assertEqual(2, self.wrap()[0])
        self.assertEqual(2, self.wrap("abc")[0])
        self.assertFalse(self.log.exists())


if __name__ == "__main__":
    unittest.main()
