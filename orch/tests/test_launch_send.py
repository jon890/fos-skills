"""notify-conflicts.py 를 가짜 orca 와 gh 로 검증한다. Orca 와 GitHub 에는 닿지 않는다."""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

# 상태 파일로 움직이는 가짜 orca. 받은 인자를 한 줄씩 기록한다
FAKE_ORCA = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    path = os.environ["FAKE_STATE"]
    state = json.load(open(path))
    args = [a for a in sys.argv[1:] if a != "--json"]
    open(os.environ["FAKE_LOG"], "a").write("orca " + " ".join(args) + "\\n")
    def out(result, code=0):
        json.dump(state, open(path, "w"))
        print(json.dumps({"ok": code == 0, "result": result})); sys.exit(code)
    def opt(name):
        return args[args.index(name) + 1] if name in args else None
    if state.get("fail"):
        print("boom"); sys.exit(1)
    # 실제 orca 처럼 「--run run_x」 같은 한 낱말 플래그를 거부한다(zsh 가 ${run:+--run "$run"} 를 나누지 않은 경우)
    joined = [a for a in args if a.startswith("--") and " " in a]
    if joined:
        print("Unknown flag " + joined[0]); sys.exit(1)
    if args[:2] == ["worktree", "list"]:
        lists = state.get("worktree_lists")
        paths = lists.pop(0) if lists else [p for p in os.environ.get("FAKE_WT_DEFAULT", "").split(":") if p]
        out({"worktrees": [{"path": p} for p in paths]})
    if args[:2] == ["repo", "show"]:
        out({"repo": {"externalWorktreeVisibility": state.get("visibility", "hide")}})
    if args[:2] == ["terminal", "list"]:
        out({"terminals": state.get("terminals", [])})
    if args[:2] == ["terminal", "close"]:
        out({}, 1 if state.get("close_fails") else 0)
    if args[:2] == ["orchestration", "worker-start"]:
        if state.get("start_errors"):
            out({"error": state["start_errors"].pop(0)}, 1)
        if state.get("start_fails"):
            out({"failedStage": "agent_readiness"}, 1)
        dispatch = state["next_ids"].pop(0)
        out({"dispatch": {"id": dispatch, "taskId": "task_1"}, "launch": {"effective": {}}})
    if args[:2] == ["orchestration", "worker-show"]:
        d = state["dispatches"][opt("--dispatch")]
        stages = d.get("stages") or []
        stage = stages.pop(0) if len(stages) > 1 else (stages[0] if stages else "input_accepted")
        out({"dispatch": d["dispatch"], "worker": dict(d.get("worker", {}), stage=stage),
             "terminalResource": d.get("terminalResource", {})})
    if args[:2] == ["orchestration", "worker-abandon"]:
        out({})
    if args[:2] == ["orchestration", "inbox"]:
        out({"messages": state.get("inbox", [])})
    if args[:2] == ["orchestration", "reply"]:
        if opt("--id") in state.get("answered", []):
            print(json.dumps({"ok": False, "error": {"message": "Question " + opt("--id") + " already has a different answer"}}))
            sys.exit(1)
        out({"message": {"id": "msg_new"}})
    if args[:2] == ["orchestration", "worker-list"]:
        if state.get("worker_pages"):
            out(state["worker_pages"].pop(0))
        out({"workers": state.get("workers", [])})
    sys.exit(3)
    """)

# 받은 인자를 기록하고 FAKE_EXIT 로 끝나는 가짜 스크립트
FAKE_RECORDER = textwrap.dedent("""\
    #!/usr/bin/env python3
    import os, sys
    open(os.environ["FAKE_LOG"], "a").write(os.environ["FAKE_NAME"] + " " + " ".join(sys.argv[1:]) + "\\n")
    print(os.environ.get("FAKE_OUT", "ok"))
    sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
    """)


class FakeBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bindir = Path(tempfile.mkdtemp())
        cls.addClassCleanup(shutil.rmtree, cls.bindir, True)
        for name, body in (("orca", FAKE_ORCA), ("recorder", FAKE_RECORDER)):
            f = cls.bindir / name
            f.write_text(body)
            f.chmod(f.stat().st_mode | stat.S_IEXEC)

    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state_file = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        self.env = dict(os.environ, ORCA=str(self.bindir / "orca"), FAKE_STATE=str(self.state_file),
                        FAKE_LOG=str(self.log), LAUNCH_POLL="0")

    def state(self, **values):
        self.state_file.write_text(json.dumps(values))

    def lines(self, prefix):
        text = self.log.read_text() if self.log.exists() else ""
        return [line for line in text.splitlines() if line.startswith(prefix)]

    def recorder(self, name):
        """FAKE_NAME 을 박은 기록용 스크립트 경로."""
        f = self.tmp / f"{name}.py"
        f.write_text(FAKE_RECORDER.replace('os.environ["FAKE_NAME"]', repr(name)))
        return f


class NotifyConflictsTest(FakeBase):
    def setUp(self):
        super().setUp()
        gitconfig = self.tmp / "gitconfig"
        gitconfig.write_text("")
        self.env.update(GIT_CONFIG_GLOBAL=str(gitconfig), GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@x",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@x", SEND_TO_WORKER=str(self.recorder("send")),
                        GH=str(self.tmp / "gh"))
        (self.tmp / "gh").write_text(f"#!/bin/sh\ncat {self.tmp}/prs.json\n")
        (self.tmp / "gh").chmod(0o755)
        self.git("init", "-q", "--bare", "-b", "main", str(self.tmp / "origin.git"), cwd=self.tmp)
        self.repo = self.tmp / "repo"
        self.git("clone", "-q", str(self.tmp / "origin.git"), str(self.repo), cwd=self.tmp)
        self.commit({"a.txt": "1\n2\n3\n", "b.txt": "b\n"}, "init")
        self.git("push", "-q", "origin", "HEAD:main")

    def git(self, *args, cwd=None):
        done = subprocess.run(["git", *args], cwd=cwd or self.repo, capture_output=True, text=True, env=self.env)
        self.assertEqual(0, done.returncode, done.stderr)
        return done.stdout.strip()

    def commit(self, files, message, cwd=None):
        for name, text in files.items():
            (Path(cwd or self.repo) / name).write_text(text)
        self.git("add", "-A", cwd=cwd)
        self.git("commit", "-q", "-m", message, cwd=cwd)

    def branch(self, name, files):
        """origin/main 위에 브랜치를 만들어 워크트리에 커밋하고 push 한다."""
        path = self.tmp / name
        self.git("worktree", "add", "-q", "-b", name, str(path), "origin/main")
        self.commit(files, name, cwd=path)
        self.git("push", "-q", "origin", name, cwd=path)
        return path, self.git("rev-parse", "HEAD", cwd=path)

    def advance_main(self, files):
        self.git("checkout", "-q", "main")
        self.git("pull", "-q", "origin", "main")
        self.commit(files, "main")
        self.git("push", "-q", "origin", "main")

    def prs(self, *rows):
        (self.tmp / "prs.json").write_text(json.dumps(
            [{"number": n, "headRefName": b, "headRefOid": h, "isCrossRepository": False} for n, b, h in rows]))

    def notify(self, *args):
        cmd = ["python3", str(SCRIPTS / "notify-conflicts.py"), "--repo", str(self.repo), "--base", "main", *args]
        return subprocess.run(cmd, capture_output=True, text=True, env=self.env)

    def setup_conflict(self):
        path, head = self.branch("feat", {"a.txt": "1\nfeat\n3\n", "c.txt": "c\n"})
        _, clean = self.branch("other", {"d.txt": "d\n"})
        self.advance_main({"a.txt": "1\nmain\n3\n"})
        self.prs((7, "feat", head), (8, "other", clean))
        self.state(workers=[{"dispatchId": "ctx_old", "dispatchStatus": "completed",
                             "resource": {"worktreeId": f"repo::{path}"}},
                            {"dispatchId": "ctx_live", "dispatchStatus": "dispatched",
                             "resource": {"worktreeId": f"repo::{path}"}}])
        return path

    def test_conflicting_pr_is_listed_and_its_live_worker_told_once(self):
        self.setup_conflict()
        r = self.notify("--run", "run_x")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("#7 CONFLICTING feat: a.txt", r.stdout)
        self.assertNotIn("#8", r.stdout)
        sent = self.lines("send")
        self.assertEqual(1, len(sent), sent)
        self.assertTrue(sent[0].startswith("send --dispatch ctx_live --body PR #7 이 base main("), sent[0])
        self.assertIn("충돌 파일: a.txt", sent[0])
        self.assertTrue(sent[0].endswith("--run run_x"), sent[0])
        r2 = self.notify("--run", "run_x")
        self.assertEqual(1, r2.returncode)
        self.assertIn("이미 알렸다(ctx_live)", r2.stdout)
        self.assertEqual(1, len(self.lines("send")))

    def test_base_that_moved_is_told_again(self):
        self.setup_conflict()
        self.notify()
        self.advance_main({"b.txt": "b2\n"})
        self.notify()
        self.assertEqual(2, len(self.lines("send")))

    def test_undelivered_message_is_not_recorded(self):
        self.setup_conflict()
        self.env["FAKE_EXIT"] = "3"
        r = self.notify()
        self.assertIn("보내지 못했다(send-to-worker.py 종료 코드 3)", r.stdout)
        self.env["FAKE_EXIT"] = "0"
        self.notify()
        self.assertEqual(2, len(self.lines("send")))

    def test_missing_worker_is_reported_and_dry_run_sends_nothing(self):
        self.setup_conflict()
        self.state(workers=[])
        r = self.notify()
        self.assertIn("worker 를 찾지 못했다", r.stdout)
        self.state(workers=[{"dispatchId": "ctx_live", "dispatchStatus": "dispatched",
                             "resource": {"worktreeId": f"repo::{self.tmp / 'feat'}"}}])
        r = self.notify("--dry-run")
        self.assertIn("ctx_live 에 알릴 것", r.stdout)
        self.assertEqual([], self.lines("send"))

    def test_no_conflict_is_exit_0(self):
        _, clean = self.branch("other", {"d.txt": "d\n"})
        self.prs((8, "other", clean))
        self.state()
        r = self.notify()
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("충돌한 열린 PR 이 없다", r.stdout)

    def test_gh_failure_is_exit_2(self):
        (self.tmp / "gh").write_text("#!/bin/sh\nexit 1\n")
        self.state()
        self.assertEqual(2, self.notify().returncode)


if __name__ == "__main__":
    unittest.main()
