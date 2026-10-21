"""handoff-cleanup.py 의 판정은 순수 함수로, 옮기기는 임시 폴더와 임시 git 저장소, 가짜 gh 로 검증한다.

휴지통 폴더도 임시 폴더라 홈 디렉터리의 휴지통에는 아무것도 옮기지 않는다.
"""

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "handoff-cleanup.py"
SPEC = importlib.util.spec_from_file_location("handoff_cleanup", SCRIPT)
hc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hc)

DAY = 86400
NOW = 1_800_000_000


class PureTest(unittest.TestCase):
    def test_queue_log_finished_looks_only_at_the_last_three_lines(self):
        self.assertTrue(hc.queue_log_finished("a\nb\nQUEUE-DONE\n"))
        self.assertTrue(hc.queue_log_finished("x\nSTOP 12 체크 실패\n"))
        self.assertTrue(hc.queue_log_finished("x\nFINISH-FAIL\n"))
        self.assertTrue(hc.queue_log_finished("FINISH-DONE"))
        self.assertFalse(hc.queue_log_finished("QUEUE-DONE\n1\n2\n3\n"))
        self.assertFalse(hc.queue_log_finished("진행 중 STOP 이라는 말이 줄 가운데 있다\n"))

    def test_board_statuses_accepts_list_and_mapping(self):
        self.assertEqual({"a": "done", "b": "doing"}, hc.board_statuses(
            json.dumps({"items": [{"id": "a", "status": "done"}, {"id": "b", "status": "doing"}]})))
        self.assertEqual({"a": "done"}, hc.board_statuses(json.dumps({"items": {"k": {"id": "a", "status": "done"}}})))
        self.assertEqual({}, hc.board_statuses("not json"))
        self.assertEqual({}, hc.board_statuses(""))

    def spec(self, text, statuses=None, open_heads=(), remote=(), worktrees=()):
        return hc.spec_finished(text, statuses or {}, set(open_heads), lambda b: b in remote, lambda b: b in worktrees)

    def test_spec_is_finished_only_when_board_is_done_and_branch_is_gone(self):
        text = "# 지시서\n브랜치: `feat/a`\n보드 항목 id: `item-1`\n"
        self.assertTrue(self.spec(text, {"item-1": "done"}))

    def test_spec_stays_when_board_item_is_not_done_or_missing(self):
        text = "브랜치: `feat/a`\n보드 항목 id: `item-1`\n"
        self.assertFalse(self.spec(text, {"item-1": "doing"}))
        self.assertFalse(self.spec(text, {"item-1": "wait"}))
        self.assertFalse(self.spec(text, {}))

    def test_spec_without_board_line_skips_that_condition(self):
        self.assertTrue(self.spec("브랜치: `feat/a`\n"))

    def test_spec_stays_while_the_branch_is_alive(self):
        text = "브랜치: `feat/a`\n"
        self.assertFalse(self.spec(text, open_heads=["feat/a"]))
        self.assertFalse(self.spec(text, remote=["feat/a"]))
        self.assertFalse(self.spec(text, worktrees=["feat/a"]))

    def test_spec_without_branch_line_stays(self):
        self.assertFalse(self.spec("# 브랜치가 없는 문서\n"))

    def test_referenced(self):
        self.assertTrue(hc.referenced("demo", '{"x": "demo"}', set()))
        self.assertTrue(hc.referenced("demo", "", {"demo"}))
        self.assertFalse(hc.referenced("demo", "", {"demo2", "de"}))

    def test_drop_nested_and_unique_dest(self):
        a, b = Path("/o/dir"), Path("/o/dir/x.csv")
        self.assertEqual([a], hc.drop_nested([b, a]))
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        (tmp / "f").write_text("1")
        (tmp / "f.2").write_text("2")
        self.assertEqual(tmp / "f.3", hc.unique_dest(tmp / "f"))
        self.assertEqual(tmp / "g", hc.unique_dest(tmp / "g"))

    def test_is_old_is_strictly_greater(self):
        self.assertFalse(hc.is_old(NOW - DAY, NOW, 1))
        self.assertTrue(hc.is_old(NOW - DAY - 1, NOW, 1))


FAKE_GH = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    if os.environ.get("FAKE_GH_FAILS") == "1":
        sys.exit(1)
    print(json.dumps([{"headRefName": b} for b in json.loads(os.environ.get("FAKE_OPEN", "[]"))]))
    """)


def sh(*cmd, env=None):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, env=env).stdout.strip()


class CleanupRunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bin = Path(tempfile.mkdtemp()).resolve()
        cls.addClassCleanup(shutil.rmtree, cls.bin, True)
        cls.gh = cls.bin / "gh"
        cls.gh.write_text(FAKE_GH)
        cls.gh.chmod(0o755 | stat.S_IEXEC)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com", GH=str(self.gh))
        origin, self.repo = self.tmp / "origin.git", self.tmp / "repo"
        sh("git", "init", "-q", "--bare", "-b", "main", str(origin))
        sh("git", "clone", "-q", str(origin), str(self.repo))
        sh("git", "-C", str(self.repo), "commit", "-q", "--allow-empty", "-m", "init", env=self.env)
        sh("git", "-C", str(self.repo), "push", "-q", "-u", "origin", "main", env=self.env)
        self.omc = self.repo / ".omc"
        self.handoffs = self.omc / "handoffs"
        self.previews = self.omc / "previews"
        for d in ("queue", "specs", "bin"):
            (self.handoffs / d).mkdir(parents=True)
        self.previews.mkdir()
        self.trash = self.tmp / "trash"
        self.board = self.handoffs / "board.json"
        self.board.write_text(json.dumps({"items": [{"id": "item-done", "status": "done"},
                                                    {"id": "item-doing", "status": "doing", "details": ["keep-me"]}]}))

    def make(self, rel, text="x", age_days=0):
        path = self.omc / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if text is None:
            path.mkdir()
        else:
            path.write_text(text)
        stamp = time.time() - age_days * DAY - 60
        os.utime(path, (stamp, stamp))
        return path

    def clean(self, *args, **env):
        done = subprocess.run(["python3", str(SCRIPT), "--repo", str(self.repo), "--trash", str(self.trash), *args],
                              capture_output=True, text=True, env=dict(self.env, **env))
        self.assertEqual(0, done.returncode, done.stderr)
        return done.stdout, done.stderr

    def test_dry_run_lists_candidates_and_moves_nothing(self):
        old = self.make("handoffs/queue/q.out", "QUEUE-DONE\n", age_days=2)
        out, _ = self.clean()
        self.assertIn("후보 handoffs/queue/q.out", out)
        self.assertTrue(old.exists())
        self.assertFalse(self.trash.exists())

    def test_queue_logs(self):
        self.make("handoffs/queue/done.out", "a\nQUEUE-DONE\n", age_days=2)
        self.make("handoffs/queue/finish-7.out", "FINISH-FAIL\n", age_days=2)
        self.make("handoffs/queue/recent.out", "QUEUE-DONE\n", age_days=0)
        self.make("handoffs/queue/running.out", "진행 중\n", age_days=5)
        self.clean("--apply")
        self.assertTrue((self.trash / "handoffs/queue/done.out").exists())
        self.assertTrue((self.trash / "handoffs/queue/finish-7.out").exists())
        self.assertTrue((self.handoffs / "queue/recent.out").exists())
        self.assertTrue((self.handoffs / "queue/running.out").exists())

    def test_specs_keep_unless_board_done_and_branch_gone(self):
        self.make("handoffs/specs/spec-common.md", "공통\n", age_days=9)
        self.make("handoffs/specs/spec-finished.md", "브랜치: `feat/finished`\n보드 항목 id: `item-done`\n")
        self.make("handoffs/specs/spec-not-yet.md", "브랜치: `feat/not-yet`\n보드 항목 id: `item-doing`\n")
        self.make("handoffs/specs/spec-open-pr.md", "브랜치: `feat/open`\n보드 항목 id: `item-done`\n")
        self.make("handoffs/specs/spec-remote.md", "브랜치: `feat/remote`\n보드 항목 id: `item-done`\n")
        sh("git", "-C", str(self.repo), "push", "-q", "origin", "main:refs/heads/feat/remote", env=self.env)
        self.clean("--apply", FAKE_OPEN=json.dumps(["feat/open"]))
        self.assertTrue((self.trash / "handoffs/specs/spec-finished.md").exists())
        for name in ("spec-common.md", "spec-not-yet.md", "spec-open-pr.md", "spec-remote.md"):
            self.assertTrue((self.handoffs / "specs" / name).exists(), name)

    def test_spec_with_live_worktree_stays(self):
        self.make("handoffs/specs/spec-wt.md", "브랜치: `feat/wt`\n보드 항목 id: `item-done`\n")
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "-b", "feat/wt", str(self.tmp / "wt"), env=self.env)
        self.clean("--apply")
        self.assertTrue((self.handoffs / "specs/spec-wt.md").exists())

    def test_specs_are_not_moved_when_open_prs_cannot_be_read(self):
        self.make("handoffs/specs/spec-finished.md", "브랜치: `feat/finished`\n보드 항목 id: `item-done`\n")
        _, err = self.clean("--apply", FAKE_GH_FAILS="1")
        self.assertIn("열린 PR 을 읽지 못해", err)
        self.assertTrue((self.handoffs / "specs/spec-finished.md").exists())

    def test_old_handoff_folders_and_previews_respect_board_and_keep(self):
        self.make("handoffs/old-report", None, age_days=4)
        self.make("handoffs/keep-me", None, age_days=4)  # 보드 details 에 이름이 있다
        self.make("handoffs/fresh", None, age_days=1)
        self.make("previews/old.html", "<html>", age_days=4)
        self.make("previews/pinned.html", "<html>", age_days=9)
        self.make("previews/pinned-too", None, age_days=9)
        self.make("previews/.keep", "pinned.html\n pinned-too \n", age_days=9)
        self.clean("--apply")
        self.assertTrue((self.trash / "handoffs/old-report").exists())
        self.assertTrue((self.trash / "previews/old.html").exists())
        for rel in ("handoffs/keep-me", "handoffs/fresh", "previews/pinned.html", "previews/pinned-too",
                    "previews/.keep", "handoffs/bin", "handoffs/queue", "handoffs/specs", "handoffs/board.json"):
            self.assertTrue((self.omc / rel).exists(), rel)

    def test_csv_and_tsv_older_than_a_day_except_under_bin(self):
        self.make("handoffs/data/raw.csv", "a,b\n", age_days=2)
        self.make("scratch/raw.TSV", "a\tb\n", age_days=2)
        self.make("scratch/new.csv", "a,b\n", age_days=0)
        self.make("handoffs/bin/lookup.csv", "a,b\n", age_days=30)
        self.make("scratch/notes.txt", "n", age_days=30)
        self.clean("--apply", "--folder-days", "100")
        self.assertTrue((self.trash / "handoffs/data/raw.csv").exists())
        self.assertTrue((self.trash / "scratch/raw.TSV").exists())
        for rel in ("scratch/new.csv", "handoffs/bin/lookup.csv", "scratch/notes.txt"):
            self.assertTrue((self.omc / rel).exists(), rel)

    def test_file_inside_a_moved_folder_is_listed_once(self):
        self.make("previews/old-dir/data.csv", "a,b\n", age_days=5)
        os.utime(self.previews / "old-dir", (time.time() - 5 * DAY,) * 2)
        out, _ = self.clean()
        self.assertEqual(["후보 previews/old-dir"], out.splitlines())

    def test_existing_trash_entry_is_not_overwritten(self):
        self.make("handoffs/queue/q.out", "QUEUE-DONE\n", age_days=2)
        (self.trash / "handoffs/queue").mkdir(parents=True)
        (self.trash / "handoffs/queue/q.out").write_text("older")
        self.clean("--apply")
        self.assertEqual("older", (self.trash / "handoffs/queue/q.out").read_text())
        self.assertEqual("QUEUE-DONE\n", (self.trash / "handoffs/queue/q.out.2").read_text())

    def test_options_and_config_supply_paths_and_thresholds(self):
        self.make("previews/mid.html", "<html>", age_days=2)
        self.clean("--apply", "--folder-days", "1")
        self.assertTrue((self.trash / "previews/mid.html").exists())

        self.make("previews/cfg.html", "<html>", age_days=2)
        cfg = self.tmp / "cfg.json"
        cfg.write_text(json.dumps({"cleanup": {"folder_days": 1, "trash": str(self.tmp / "trash2")}, "finish": {"run": "r"}}))
        subprocess.run(["python3", str(SCRIPT), "--repo", str(self.repo), "--config", str(cfg), "--apply"],
                       check=True, capture_output=True, env=self.env)
        self.assertTrue((self.tmp / "trash2/previews/cfg.html").exists())

    def test_unknown_config_key_is_a_usage_error(self):
        cfg = self.tmp / "bad.json"
        cfg.write_text(json.dumps({"cleanup": {"typo_key": 1}}))
        done = subprocess.run(["python3", str(SCRIPT), "--repo", str(self.repo), "--config", str(cfg)],
                              capture_output=True, text=True, env=self.env)
        self.assertEqual(2, done.returncode)
        self.assertIn("typo_key", done.stderr)

    def test_nothing_to_do_prints_nothing(self):
        out, _ = self.clean()
        self.assertEqual("", out)


if __name__ == "__main__":
    unittest.main()
