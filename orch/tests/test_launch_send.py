"""launch-worker.sh, send-to-worker.py, notify-conflicts.py 를 가짜 orca 와 gh 로 검증한다. Orca 와 GitHub 에는 닿지 않는다."""

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


class LaunchWorkerTest(FakeBase):
    def setUp(self):
        super().setUp()
        self.spec = self.tmp / "spec.md"
        self.spec.write_text("# 일\n\n허락: push 와 draft PR 생성은 사용자가 허락했다.\n")
        self.worktree = self.tmp / "wt"
        self.worktree.mkdir()
        self.make = self.tmp / "make-worktree.sh"
        self.make.write_text(f'echo "make $*" >> "$FAKE_LOG"; mkdir -p {self.tmp}/new; echo {self.tmp}/new\n')
        self.env["MAKE_WORKTREE"] = str(self.make)
        self.env.update(LAUNCH_WT_POLL="0", LAUNCH_WT_WAIT="3", FAKE_WT_DEFAULT=f"{self.worktree}:{self.tmp}/new")

    def launch(self, *args, shell="bash"):
        if not shutil.which(shell):
            self.skipTest(f"{shell} 가 없다")
        cmd = [shell, str(SCRIPTS / "launch-worker.sh"), "--spec", str(self.spec), *args]
        return subprocess.run(cmd, capture_output=True, text=True, env=self.env)

    def shown(self, *stages):
        return {"dispatch": {"id": "x", "status": "dispatched"}, "stages": list(stages)}

    def test_spec_without_permission_line_is_refused(self):
        self.spec.write_text("# 일\n")
        self.state(next_ids=["ctx_1"])
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("허락:", r.stderr)
        self.assertEqual([], self.lines("orca orchestration worker-start"))

    def test_leftover_terminal_on_existing_worktree_is_refused_with_the_list(self):
        self.state(next_ids=["ctx_1"], terminals=[{"handle": "term_old", "title": "claude 앞 세션",
                                                    "worktreePath": str(self.worktree)},
                                                   {"handle": "term_other", "worktreePath": "/elsewhere"}])
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("터미널이 남아 있다", r.stdout)
        self.assertIn("term_old claude 앞 세션", r.stdout)
        self.assertNotIn("term_other", r.stdout)
        self.assertEqual([], self.lines("orca orchestration worker-start"))

    def test_terminal_reused_with_terminal_option_is_not_a_leftover(self):
        self.state(next_ids=["ctx_1"], terminals=[{"handle": "term_old", "worktreePath": str(self.worktree)}],
                   dispatches={"ctx_1": self.shown("input_accepted")})
        r = self.launch("--worktree", str(self.worktree), "--", "--terminal", "term_old")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        start = self.lines("orca orchestration worker-start")[0]
        self.assertIn(f"--worktree path:{self.worktree} --terminal term_old", start)

    def test_terminal_with_agent_model_or_effort_is_refused_before_orca(self):
        self.state(next_ids=["ctx_1"])
        for opt in ("--agent", "--model", "--effort"):
            r = self.launch("--worktree", str(self.worktree), "--", "--terminal", "term_old", opt, "x")
            self.assertEqual(1, r.returncode, r.stdout + r.stderr)
            self.assertIn("함께 쓰지 못한다", r.stderr)
            self.assertIn(opt, r.stderr)
        self.assertFalse(self.log.exists())

    def test_agent_unconfigured_on_reused_terminal_exits_3_without_closing_it(self):
        self.state(next_ids=["ctx_1"], terminals=[{"handle": "term_old", "worktreePath": str(self.worktree)}],
                   start_errors=["agent_unconfigured: Terminal term_old is not running a recognized agent"])
        r = self.launch("--worktree", str(self.worktree), "--", "--terminal", "term_old")
        self.assertEqual(3, r.returncode, r.stdout + r.stderr)
        self.assertIn("agent_unconfigured", r.stderr)
        self.assertIn("orca terminal close", r.stderr)
        self.assertEqual([], self.lines("orca terminal close"))
        self.assertEqual(1, len(self.lines("orca orchestration worker-start")))

    def test_hooks_review_prompt_names_the_codex_manifest_fix(self):
        self.state(next_ids=["ctx_1"], start_errors=["Agent startup blocked: agent-hooks-review-prompt"])
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "codex")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("codex plugin marketplace upgrade fos-skills", r.stderr)

    def test_agent_unconfigured_without_terminal_option_is_a_plain_failure(self):
        self.state(next_ids=["ctx_1"], start_errors=["agent_unconfigured: x"])
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)

    def test_new_worktree_is_made_and_spec_line_carries_permission(self):
        self.state(next_ids=["ctx_1"], dispatches={"ctx_1": self.shown("input_accepted")})
        r = self.launch("--repo", str(self.tmp), "--name", "feat", "--base", "develop", "--run", "run_x",
                        "--", "--agent", "codex", "--model", "m")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual([f"make --repo {self.tmp} --spec {self.spec} --name feat --base develop"], self.lines("make"))
        start = self.lines("orca orchestration worker-start")[0]
        self.assertIn("--run run_x --spec 지시서 ", start)
        self.assertIn("push 와 draft PR 생성은 사용자가 허락했다.", start)
        self.assertIn(f"--worktree path:{self.tmp}/new --agent codex --model m", start)
        self.assertTrue(r.stdout.rstrip().endswith(f"LAUNCHED ctx_1 {self.tmp}/new"), r.stdout)

    def test_optional_flags_are_separate_words_in_bash_and_zsh(self):
        """zsh 는 ${run:+--run "$run"} 를 나누지 않아 worker-start 가 Unknown flag --run run_x 로 실패했다"""
        for shell in ("bash", "zsh"):
            with self.subTest(shell=shell):
                if self.log.exists():
                    self.log.unlink()
                self.state(next_ids=["ctx_1", "ctx_2"],
                           dispatches={"ctx_1": self.shown("worktree_creating"), "ctx_2": self.shown("input_accepted")})
                r = self.launch("--repo", str(self.tmp), "--name", "feat", "--base", "develop", "--run", "run_x",
                                "--watch", "1", "--", "--agent", "codex", shell=shell)
                self.assertEqual(0, r.returncode, r.stdout + r.stderr)
                self.assertEqual([f"make --repo {self.tmp} --spec {self.spec} --name feat --base develop"], self.lines("make"))
                first, retry = self.lines("orca orchestration worker-start")
                self.assertTrue(first.startswith("orca orchestration worker-start --run run_x --spec "), first)
                self.assertIn("--run run_x --task task_1 --retry-of ctx_1", retry)

    def test_without_run_and_base_no_empty_words_are_passed(self):
        for shell in ("bash", "zsh"):
            with self.subTest(shell=shell):
                if self.log.exists():
                    self.log.unlink()
                self.state(next_ids=["ctx_1"], dispatches={"ctx_1": self.shown("input_accepted")})
                r = self.launch("--repo", str(self.tmp), "--name", "feat", "--", "--agent", "codex", shell=shell)
                self.assertEqual(0, r.returncode, r.stdout + r.stderr)
                self.assertEqual([f"make --repo {self.tmp} --spec {self.spec} --name feat"], self.lines("make"))
                self.assertTrue(self.lines("orca orchestration worker-start")[0].startswith("orca orchestration worker-start --spec "))

    def test_worktree_accepts_the_path_prefix(self):
        self.state(next_ids=["ctx_1"], dispatches={"ctx_1": self.shown("input_accepted")})
        r = self.launch("--worktree", f"path:{self.worktree}", "--", "--agent", "claude")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn(f"--worktree path:{self.worktree} --agent claude", self.lines("orca orchestration worker-start")[0])
        self.assertTrue(r.stdout.rstrip().endswith(f"LAUNCHED ctx_1 {self.worktree}"), r.stdout)

    def test_failure_after_making_the_worktree_says_how_to_resume(self):
        for shell in ("bash", "zsh"):
            with self.subTest(shell=shell):
                self.state(start_fails=True,
                           terminals=[{"handle": "term_left", "title": "codex hooks review", "worktreePath": f"{self.tmp}/new"}])
                r = self.launch("--repo", str(self.tmp), "--name", "feat", "--run", "run_x", "--",
                                "--agent", "codex", "--model", "gpt 6", shell=shell)
                self.assertEqual(1, r.returncode, r.stdout + r.stderr)
                self.assertIn(f"워크트리는 남아 있다: {self.tmp}/new", r.stderr)
                self.assertIn(f"--worktree {self.tmp}/new --run run_x -- --agent codex --model gpt\\ 6", r.stderr)
                self.assertIn("term_left codex hooks review", r.stderr)

    def test_failure_after_worker_start_succeeded_gives_no_resume_hint(self):
        """dispatch 가 이미 떠 있으면 --worktree 로 다시 띄우라고 하지 않는다. 같은 일의 task 가 하나 더 생긴다"""
        self.state(next_ids=["ctx_1", "ctx_2"],
                   dispatches={"ctx_1": self.shown("worktree_creating"), "ctx_2": self.shown("worktree_creating")})
        r = self.launch("--repo", str(self.tmp), "--name", "feat", "--watch", "1", "--", "--agent", "claude")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("워크트리는 남아 있다", r.stderr)

    def test_existing_worktree_or_success_gives_no_resume_hint(self):
        self.state(start_fails=True)
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(1, r.returncode)
        self.assertNotIn("워크트리는 남아 있다", r.stderr)
        self.state(next_ids=["ctx_1"], dispatches={"ctx_1": self.shown("input_accepted")})
        r = self.launch("--repo", str(self.tmp), "--name", "feat", "--", "--agent", "claude")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("워크트리는 남아 있다", r.stderr)

    def test_stuck_in_worktree_creating_is_abandoned_and_retried_once(self):
        self.state(next_ids=["ctx_1", "ctx_2"],
                   dispatches={"ctx_1": self.shown("worktree_creating"), "ctx_2": self.shown("input_accepted")})
        r = self.launch("--worktree", str(self.worktree), "--watch", "3", "--", "--agent", "claude")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["orca orchestration worker-abandon --dispatch ctx_1"], self.lines("orca orchestration worker-abandon"))
        retry = self.lines("orca orchestration worker-start")[1]
        self.assertIn(f"--task task_1 --retry-of ctx_1 --worktree path:{self.worktree} --agent claude", retry)
        self.assertNotIn("--spec", retry)
        self.assertIn("LAUNCHED ctx_2", r.stdout)

    def test_stuck_again_after_retry_fails(self):
        self.state(next_ids=["ctx_1", "ctx_2"],
                   dispatches={"ctx_1": self.shown("worktree_creating"), "ctx_2": self.shown("worktree_creating")})
        r = self.launch("--worktree", str(self.worktree), "--watch", "2", "--", "--agent", "claude")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertEqual(2, len(self.lines("orca orchestration worker-start")))
        self.assertNotIn("LAUNCHED", r.stdout)

    def test_stage_that_moves_on_within_the_watch_is_kept(self):
        self.state(next_ids=["ctx_1"], dispatches={"ctx_1": self.shown("worktree_creating", "agent_starting")})
        r = self.launch("--worktree", str(self.worktree), "--watch", "5", "--", "--agent", "claude")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual([], self.lines("orca orchestration worker-abandon"))
        self.assertIn("ctx_1 단계: agent_starting", r.stdout)

    def test_failed_worker_start_is_not_relaunched(self):
        self.state(start_fails=True)
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(1, r.returncode)
        self.assertEqual(1, len(self.lines("orca orchestration worker-start")))

    def test_waits_until_orca_lists_the_worktree(self):
        self.state(next_ids=["ctx_1"], dispatches={"ctx_1": self.shown("input_accepted")},
                   worktree_lists=[[], [], [str(self.worktree)]])
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(3, len(self.lines("orca worktree list")))
        self.assertIn("알아보기까지 2초 기다렸다", r.stderr)

    def test_worktree_never_listed_stops_without_starting(self):
        self.state(next_ids=["ctx_1"], worktree_lists=[[]] * 20)
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("Orca 가 워크트리를 알아보지 못했다", r.stderr)
        self.assertEqual([], self.lines("orca orchestration worker-start"))

    def test_selector_not_found_is_retried_once(self):
        self.state(next_ids=["ctx_1"], dispatches={"ctx_1": self.shown("input_accepted")},
                   start_errors=["selector_not_found"])
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(2, len(self.lines("orca orchestration worker-start")))
        self.assertIn("LAUNCHED ctx_1", r.stdout)

    def test_selector_not_found_twice_fails_and_other_errors_are_not_retried(self):
        self.state(next_ids=["ctx_1"], start_errors=["selector_not_found", "selector_not_found"])
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertEqual(2, len(self.lines("orca orchestration worker-start")))
        self.log.unlink()
        self.state(next_ids=["ctx_1"], start_errors=["agent_not_found"])
        r = self.launch("--worktree", str(self.worktree), "--", "--agent", "claude")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertEqual(1, len(self.lines("orca orchestration worker-start")))

    def test_usage_errors(self):
        for args in ([], ["--worktree", "x", "--name", "y"], ["--repo", "x"], ["--worktree", "x", "--agent", "c"],
                     ["--worktree", "x", "--watch", "1.5"]):
            with self.subTest(args=args):
                self.assertEqual(2, self.launch(*args).returncode)


class SendToWorkerTest(FakeBase):
    def setUp(self):
        super().setUp()
        self.env["NUDGE_WORKER"] = str(self.recorder("nudge"))
        self.env["LAUNCH_WORKER"] = str(self.tmp / "launch.sh")
        (self.tmp / "launch.sh").write_text('echo "launch $*" >> "$FAKE_LOG"\n')

    def worker(self, status, **extra):
        return {"ctx_1": {"dispatch": {"id": "ctx_1", "status": status, "runId": "run_x"},
                          "worker": {"agentTerminalHandle": "term_w", "worktreeId": "repo::/w/feat"}}, **extra}

    def message(self, mid, sender, kind="status", seq=1):
        return {"id": mid, "from_handle": sender, "type": kind, "sequence": seq, "payload": None}

    def send(self, *args):
        cmd = ["python3", str(SCRIPTS / "send-to-worker.py"), "--dispatch", "ctx_1", *args]
        return subprocess.run(cmd, capture_output=True, text=True, env=self.env)

    def test_active_dispatch_replies_to_its_last_message_and_nudges(self):
        inbox = [self.message("m_hb", "term_w", "heartbeat", 9), self.message("m_q", "dispatch:ctx_1", "question", 5),
                 self.message("m_st", "term_w", "status", 3), self.message("m_other", "term_x", "status", 8),
                 self.message("m_coord", "run:run_x", "status", 7)]
        self.state(dispatches=self.worker("dispatched"), inbox=inbox)
        r = self.send("--body", "그렇게 한다")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["orca orchestration reply --id m_q --body 그렇게 한다 --run run_x"],
                         self.lines("orca orchestration reply"))
        self.assertEqual(["nudge --terminal term_w --msg-id msg_new"], self.lines("nudge"))

    def test_answered_question_is_skipped_for_the_next_message(self):
        # orca 가 「already has a different answer」 로 거부하면 다음 후보로 한 번 더 시도한다
        inbox = [self.message("m_q", "dispatch:ctx_1", "question", 5), self.message("m_st", "term_w", "status", 3)]
        self.state(dispatches=self.worker("dispatched"), inbox=inbox, answered=["m_q"])
        r = self.send("--body", "x")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("skipped: m_q", r.stdout)
        self.assertEqual(["--id m_q", "--id m_st"],
                         [" ".join(line.split()[3:5]) for line in self.lines("orca orchestration reply")])
        self.assertEqual(["nudge --terminal term_w --msg-id msg_new"], self.lines("nudge"))

    def test_question_with_a_visible_answer_is_not_tried(self):
        answer = dict(self.message("m_ans", "run:run_x", "status", 6), thread_id="m_q")
        question = dict(self.message("m_q", "dispatch:ctx_1", "question", 5), thread_id="m_q")
        self.state(dispatches=self.worker("dispatched"), inbox=[question, answer, self.message("m_st", "term_w", "status", 3)])
        r = self.send("--body", "x")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["orca orchestration reply --id m_st --body x --run run_x"], self.lines("orca orchestration reply"))

    def test_second_answered_rejection_is_not_retried_again(self):
        inbox = [self.message(m, "term_w", "question", s) for m, s in (("m_a", 5), ("m_b", 4), ("m_c", 3))]
        self.state(dispatches=self.worker("dispatched"), inbox=inbox, answered=["m_a", "m_b"])
        r = self.send("--body", "x")
        self.assertEqual(5, r.returncode, r.stdout)
        self.assertEqual(2, len(self.lines("orca orchestration reply")))

    def test_explicit_reply_to_and_nudge_exit_code_pass_through(self):
        self.state(dispatches=self.worker("dispatched"))
        self.env["FAKE_EXIT"] = "4"
        body = self.tmp / "body.txt"
        body.write_text("파일 본문\n")
        r = self.send("--body-file", str(body), "--reply-to", "m_given")
        self.assertEqual(4, r.returncode)
        self.assertIn("--id m_given --body 파일 본문", self.lines("orca orchestration reply")[0])

    def test_active_dispatch_without_messages_asks_for_reply_to(self):
        self.state(dispatches=self.worker("dispatched"), inbox=[])
        r = self.send("--body", "x")
        self.assertEqual(3, r.returncode)
        self.assertIn("--reply-to", r.stdout)
        self.assertEqual([], self.lines("orca orchestration reply"))

    def test_settled_dispatch_with_live_terminal_needs_a_spec(self):
        self.state(dispatches=self.worker("completed"), terminals=[{"handle": "term_w"}])
        r = self.send("--body", "x")
        self.assertEqual(3, r.returncode)
        self.assertIn("--spec", r.stdout)
        self.assertEqual([], self.lines("orca orchestration reply"))
        self.assertEqual([], self.lines("launch"))

    def test_settled_dispatch_whose_agent_still_works_gets_the_body_with_a_warning(self):
        # worker 가 phase 중간에 worker_done 을 보내 dispatch 가 닫혔지만 계속 일하는 경우다
        self.state(dispatches=self.worker("succeeded"), terminals=[{"handle": "term_w"}])
        self.env["FAKE_OUT"] = "working"
        r = self.send("--body", "main 을 합쳐라")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("Task 기록에 묶이지 않는다", r.stdout)
        self.assertEqual(["nudge --terminal term_w --state",
                          "nudge --terminal term_w --text 코디네이터(닫힌 dispatch ctx_1): main 을 합쳐라"],
                         self.lines("nudge"))
        self.assertEqual([], self.lines("orca orchestration reply"))
        self.assertEqual([], self.lines("launch"))

    def test_settled_dispatch_with_live_terminal_relaunches_on_that_terminal(self):
        self.state(dispatches=self.worker("completed"), terminals=[{"handle": "term_w"}])
        r = self.send("--body", "x", "--spec", "/s/next.md")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["launch --spec /s/next.md --worktree /w/feat --run run_x -- --terminal term_w"],
                         self.lines("launch"))

    def test_settled_dispatch_without_terminal_says_to_launch_anew(self):
        self.state(dispatches=self.worker("failed"), terminals=[{"handle": "term_other"}])
        r = self.send("--body", "x", "--spec", "/s/next.md")
        self.assertEqual(3, r.returncode)
        self.assertIn("launch-worker.sh --spec <지시서> --worktree /w/feat", r.stdout)
        self.assertEqual([], self.lines("launch"))

    def restart_setup(self, **state):
        workers = self.worker("completed")
        workers["ctx_1"]["worker"]["startOptions"] = {
            "launch": {"effective": {"agent": "codex", "model": "original-model", "effort": "high"}}}
        self.state(dispatches=workers, terminals=[{"handle": "term_w"}], **state)
        (self.tmp / "launch.sh").write_text(
            'echo "launch $*" >> "$FAKE_LOG"\n'
            'case " $* " in *" --terminal "*) exit 3 ;; esac\n')

    def test_shell_only_terminal_is_closed_and_restarted_with_original_settings(self):
        self.restart_setup()
        r = self.send("--body", "x", "--spec", "/s/next.md")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["orca terminal close --terminal term_w"], self.lines("orca terminal close"))
        self.assertEqual("launch --spec /s/next.md --worktree /w/feat --run run_x -- --agent codex --model original-model --effort high",
                         self.lines("launch")[-1])
        self.assertLess(self.log.read_text().index("orca terminal close"), self.log.read_text().rindex("launch --spec"))

    def test_restart_settings_can_be_overridden(self):
        self.restart_setup()
        r = self.send("--body", "x", "--spec", "/s/next.md", "--agent", "claude", "--model", "new-model", "--effort", "low")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("--agent claude --model new-model --effort low", self.lines("launch")[-1])

    def test_restart_does_not_close_terminal_reused_by_an_active_dispatch(self):
        self.restart_setup(workers=[{"dispatchStatus": "dispatched", "agentTerminalHandle": "term_w"}])
        self.assertEqual(1, self.send("--body", "x", "--spec", "/s/next.md").returncode)
        self.assertEqual([], self.lines("orca terminal close"))
        self.assertEqual(1, len(self.lines("launch")))

    def test_restart_close_failure_does_not_launch_a_replacement(self):
        self.restart_setup(close_fails=True)
        self.assertEqual(5, self.send("--body", "x", "--spec", "/s/next.md").returncode)
        self.assertEqual(1, len(self.lines("launch")))

    def test_other_launch_failure_is_not_retried(self):
        self.restart_setup()
        (self.tmp / "launch.sh").write_text('echo "launch $*" >> "$FAKE_LOG"\nexit 1\n')
        self.assertEqual(1, self.send("--body", "x", "--spec", "/s/next.md").returncode)
        self.assertEqual([], self.lines("orca terminal close"))

    def test_missing_original_settings_preserves_the_terminal(self):
        self.restart_setup()
        data = json.loads(self.state_file.read_text())
        data["dispatches"]["ctx_1"]["worker"].pop("startOptions")
        self.state(**data)
        self.assertEqual(1, self.send("--body", "x", "--spec", "/s/next.md").returncode)
        self.assertEqual([], self.lines("orca terminal close"))

    def test_changed_terminal_owner_is_preserved(self):
        self.restart_setup()
        data = json.loads(self.state_file.read_text())
        data["dispatches"]["ctx_1"]["terminalResource"] = {"ownerDispatchId": "ctx_other"}
        self.state(**data)
        self.assertEqual(1, self.send("--body", "x", "--spec", "/s/next.md").returncode)
        self.assertEqual([], self.lines("orca terminal close"))

    def test_active_dispatch_on_later_page_prevents_close(self):
        self.restart_setup(worker_pages=[
            {"workers": [], "page": {"hasMore": True, "nextCursor": "page2"}},
            {"workers": [{"agentTerminalHandle": "term_w", "dispatchStatus": "running"}]}])
        self.assertEqual(1, self.send("--body", "x", "--spec", "/s/next.md").returncode)
        self.assertEqual([], self.lines("orca terminal close"))
        self.assertIn("--cursor page2", self.lines("orca orchestration worker-list")[-1])

    def test_user_retained_terminal_is_not_closed(self):
        self.restart_setup()
        data = json.loads(self.state_file.read_text())
        data["dispatches"]["ctx_1"]["terminalResource"] = {"ownerDispatchId": "ctx_1", "ownershipState": "user_owned"}
        self.state(**data)
        self.assertEqual(1, self.send("--body", "x", "--spec", "/s/next.md").returncode)
        self.assertEqual([], self.lines("orca terminal close"))

    def test_orca_failure_is_exit_5(self):
        self.state(fail=True)
        self.assertEqual(5, self.send("--body", "x").returncode)

    def test_usage_errors(self):
        self.state()
        self.assertEqual(2, self.send().returncode)
        self.assertEqual(2, self.send("--body", "a", "--body-file", "b").returncode)


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
