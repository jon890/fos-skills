"""orch 스크립트를 검증한다. orca 와 GitHub 에는 닿지 않는다. gh, git, sleep 은 가짜를 PATH 앞에 둔다."""

import datetime as dt
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tm = load("triage-messages")
gp = load("goal-progress")


def msg(i, kind, created="2026-10-12T15:00:00Z", who="term_a", body="본문"):
    return {"id": i, "type": kind, "subject": f"s{i}", "body": body, "payload": None,
            "created_at": created, "from_handle": who}


class TriageTest(unittest.TestCase):
    def test_parses_objects_mixed_with_noise(self):
        text = '{"_keepalive":true}\n{"result":{"deliveryId":"d1","messages":[]}}\nexit code 0\n{"result":{}}'
        objs = tm.parse_objects(text)
        self.assertEqual(3, len(objs))
        self.assertEqual(["d1"], tm.collect(objs)[0])

    def test_groups_priority_first_and_counts_heartbeats(self):
        msgs = [msg("1", "heartbeat"), msg("2", "status"), msg("3", "worker_done"),
                msg("4", "heartbeat", who="term_b"), msg("5", "question"), msg("6", "heartbeat")]
        r = tm.triage(msgs)
        self.assertEqual(["worker_done", "question", "status"], list(r["groups"]))
        self.assertEqual({"term_a": 2, "term_b": 1}, r["heartbeats"])

    def test_dedups_by_id_across_deliveries(self):
        obj = {"result": {"deliveryId": "d", "messages": [msg("1", "worker_done")]}}
        _, messages = tm.collect([obj, obj])
        self.assertEqual(1, len(messages))

    def test_since_filters_old_messages(self):
        msgs = [msg("1", "worker_done", "2026-10-12T14:00:00Z"), msg("2", "worker_done", "2026-10-12T16:00:00Z")]
        r = tm.triage(msgs, tm.parse_since("2026-10-12T15:00:00Z"))
        self.assertEqual(["2"], [m["id"] for m in r["groups"]["worker_done"]])

    def test_relative_since(self):
        now = dt.datetime(2026, 10, 12, 16, tzinfo=dt.timezone.utc)
        self.assertEqual(dt.datetime(2026, 10, 12, 14, 30, tzinfo=dt.timezone.utc), tm.parse_since("90m", now))
        self.assertEqual(dt.datetime(2026, 10, 11, 16, tzinfo=dt.timezone.utc), tm.parse_since("1d", now))

    def test_render_truncates_body(self):
        r = tm.triage([msg("1", "escalation", body="가" * 20)])
        out = tm.render(["d"], r, 5)
        self.assertIn("가" * 5 + " …(잘림)", out)

    def test_file_without_result_fails(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write("nothing here")
        try:
            self.assertEqual(1, tm.main([f.name]))
        finally:
            os.unlink(f.name)


class GoalProgressTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.board = self.tmp / "board.json"
        self.board.write_text(json.dumps({"items": [
            {"id": "goal", "status": "goal", "title": "목표"},
            {"id": "a", "status": "done", "title": "A"},
            {"id": "b", "status": "doing", "title": "B"},
        ]}), encoding="utf-8")
        self.calls = self.tmp / "calls.json"
        self.bin = self.tmp / "board.py"
        self.bin.write_text(f"import json,sys\njson.dump(sys.argv[1:], open({str(self.calls)!r}, 'w'))\n")

    def test_progress_counts_done_and_missing(self):
        by_id = gp.board_items(json.loads(self.board.read_text()))
        done, details, missing = gp.progress(by_id, ["a", "b", "gone"])
        self.assertEqual(1, done)
        self.assertEqual(["✓ A", "B", "gone"], details)
        self.assertEqual(["gone"], missing)

    def test_sets_progress_and_details(self):
        items = self.tmp / "items.txt"
        items.write_text("# 오늘\na\n\nb\n", encoding="utf-8")
        rc = gp.main(["goal", "--items-file", str(items), "--board", str(self.board),
                      "--board-bin", str(self.bin), "--details"])
        self.assertEqual(0, rc)
        argv = json.loads(self.calls.read_text())
        self.assertEqual(["set", "goal", "--progress", "1/2", "--file", str(self.board),
                          "--detail", "✓ A", "--detail", "B"], argv)

    def test_dry_run_does_not_call_board(self):
        rc = gp.main(["goal", "a", "--board", str(self.board), "--board-bin", str(self.bin), "--dry-run"])
        self.assertEqual(0, rc)
        self.assertFalse(self.calls.exists())

    def test_unknown_goal_fails(self):
        self.assertEqual(1, gp.main(["nope", "a", "--board", str(self.board), "--dry-run"]))


FAKE_GH = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, subprocess, sys
    state = json.load(open(os.environ["FAKE_STATE"]))
    args = sys.argv[1:]
    log = open(os.environ["FAKE_LOG"], "a")
    log.write(" ".join(args) + "\\n")
    if args[:2] == ["pr", "merge"]:
        pr = state[args[2]]
        if "--match-head-commit" in args and args[args.index("--match-head-commit") + 1] == pr["headRefOid"]:
            pr["state"] = "MERGED"
            json.dump(state, open(os.environ["FAKE_STATE"], "w"))
            print("merged")
            sys.exit(0)
        print("head mismatch"); sys.exit(1)
    if args[:2] == ["pr", "list"]:
        print(os.environ.get("FAKE_BASED", "0")); sys.exit(0)
    if args[0] == "api":
        path = [a for a in args[1:] if a.startswith("repos/")][0]
        if "update-branch" in path:
            pr = state[path.split("/")[-2]]
            if pr.get("update_fails"):
                sys.exit(1)
            pr["headRefOid"] = "new"
            pr["statusCheckRollup"] = []
            pr["appear"] = {"left": 2, "checks": pr.get("after_update", [])}
            state["_behind"] = 0
            state["_remote_head"] = "new"
            json.dump(state, open(os.environ["FAKE_STATE"], "w"))
            sys.exit(0)
        if state.get("_api_fails"):
            sys.exit(1)
        if "/rules/branches/" in path:
            data = state.get("_rules", [])
        else:
            data = {"behind_by": state.get("_behind", 0)}
        jq = args[args.index("--jq") + 1] if "--jq" in args else "."
        out = subprocess.run(["jq", "-r", jq], input=json.dumps(data), capture_output=True, text=True)
        sys.stdout.write(out.stdout)
        sys.exit(out.returncode)
    if args[:2] == ["pr", "view"]:
        pr = state[args[2]]
        # 체크가 나중에 나타나는 PR 을 흉내 낸다. 조회할 때마다 left 가 줄고 0 이 되면 체크가 붙는다
        if "appear" in pr:
            pr["appear"]["left"] -= 1
            if pr["appear"]["left"] <= 0:
                pr["statusCheckRollup"] += pr.pop("appear")["checks"]
            json.dump(state, open(os.environ["FAKE_STATE"], "w"))
        jq = args[args.index("--jq") + 1]
        out = subprocess.run(["jq", "-r", jq], input=json.dumps(pr), capture_output=True, text=True)
        sys.stdout.write(out.stdout)
        sys.exit(out.returncode)
    sys.exit(3)
    """)

FAKE_GIT = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    args = sys.argv[1:]
    open(os.environ["FAKE_LOG"], "a").write("git " + " ".join(args) + "\\n")
    if args[:1] == ["rev-parse"]:
        state = json.load(open(os.environ["FAKE_STATE"]))
        print(state.get("_remote_head", os.environ.get("FAKE_REMOTE_HEAD", "")))
    sys.exit(0)
    """)


@unittest.skipUnless(shutil.which("jq") and shutil.which("bash"), "jq 와 bash 가 필요하다")
class MergeQueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        bindir = self.tmp / "bin"
        bindir.mkdir()
        for name, body in (("gh", FAKE_GH), ("git", FAKE_GIT), ("sleep", "#!/bin/sh\nexit 0\n")):
            p = bindir / name
            p.write_text(body)
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
        self.state = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        self.env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", FAKE_STATE=str(self.state),
                        FAKE_LOG=str(self.log), FAKE_REMOTE_HEAD="abc")

    def pr(self, **over):
        base = {"state": "OPEN", "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}],
                "mergeable": "MERGEABLE", "url": "https://git.example.com/owner/repo/pull/1",
                "headRefName": "feat", "baseRefName": "main", "headRefOid": "abc",
                "isCrossRepository": False}
        base.update(over)
        return base

    def run_queue(self, state, *args, threads="0"):
        self.state.write_text(json.dumps(state))
        cmd = ["bash", str(SCRIPTS / "merge-queue.sh"), "--repo", str(self.tmp),
               "--threads-cmd", f"echo {threads}", *args]
        return subprocess.run(cmd, capture_output=True, text=True, env=self.env)

    def test_merges_and_runs_before_command_with_env(self):
        marker = self.tmp / "before.txt"
        r = self.run_queue({"1": self.pr()}, f"1:echo \"$PR $BRANCH $OWNER/$REPO\" > {marker}")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("QUEUE-DONE", r.stdout)
        self.assertEqual("1 feat owner/repo\n", marker.read_text())
        self.assertIn("pr merge 1 --merge --match-head-commit abc", self.log.read_text())
        self.assertIn("git push -q origin --delete feat", self.log.read_text())

    def test_stops_on_unresolved_threads(self):
        r = self.run_queue({"1": self.pr()}, "1", threads="2")
        self.assertEqual(1, r.returncode)
        self.assertIn("threads=2", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_stops_on_failed_check(self):
        r = self.run_queue({"1": self.pr(statusCheckRollup=[{"status": "COMPLETED", "conclusion": "FAILURE"}])}, "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("실패한 체크 1 개", r.stdout)

    def test_stops_on_head_mismatch(self):
        self.env["FAKE_REMOTE_HEAD"] = "def"
        r = self.run_queue({"1": self.pr()}, "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("head 불일치", r.stdout)

    def test_stops_when_before_command_fails(self):
        r = self.run_queue({"1": self.pr()}, "--before", "exit 3", "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("머지 전 명령 실패", r.stdout)

    def test_skips_already_merged_and_keeps_fork_branch(self):
        state = {"1": self.pr(state="MERGED"), "2": self.pr(isCrossRepository=True)}
        r = self.run_queue(state, "1", "2")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 이미 MERGED", r.stdout)
        self.assertNotIn("--delete", self.log.read_text())

    def test_stops_when_head_moves_during_before_command(self):
        move = (f"python3 -c \"import json; p='{self.state}'; d=json.load(open(p)); "
                f"d['1']['headRefOid']='new'; json.dump(d, open(p, 'w'))\"")
        r = self.run_queue({"1": self.pr()}, f"1:{move}")
        self.assertEqual(1, r.returncode)
        self.assertIn("검사 뒤 HEAD 가 바뀌었다", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_keeps_release_and_stacked_base_branches(self):
        r = self.run_queue({"1": self.pr(headRefName="release/1.0")}, "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.env["FAKE_BASED"] = "1"
        r2 = self.run_queue({"2": self.pr()}, "2")
        self.assertEqual(0, r2.returncode, r2.stdout + r2.stderr)
        self.assertNotIn("--delete", self.log.read_text())

    def check(self, name, conclusion="SUCCESS"):
        return {"name": name, "status": "COMPLETED", "conclusion": conclusion}

    def rules(self, *names):
        return [{"type": "required_status_checks",
                 "parameters": {"required_status_checks": [{"context": n} for n in names]}}]

    def test_waits_until_required_checks_appear(self):
        # 열린 직후에는 체크 목록이 비어 있다. 대기 0 을 완료로 보면 머지해 버린다
        pr = self.pr(statusCheckRollup=[], appear={"left": 30, "checks": [self.check("backend")]})
        r = self.run_queue({"1": pr, "_rules": self.rules("backend")}, "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 MERGED", r.stdout)
        # 머지된 시점에 필수 체크가 이미 나타나 있어야 한다
        self.assertEqual(["backend"], [c["name"] for c in json.loads(self.state.read_text())["1"]["statusCheckRollup"]])

    def test_required_option_overrides_rules_and_stops_on_timeout(self):
        pr = self.pr(statusCheckRollup=[self.check("backend")])
        r = self.run_queue({"1": pr, "_rules": self.rules("backend")}, "--required", "backend,frontend",
                           "--check-timeout", "0", "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("나타나지 않은 필수 체크 frontend", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_required_checks_read_from_repository_rules(self):
        pr = self.pr(statusCheckRollup=[self.check("backend")])
        r = self.run_queue({"1": pr, "_rules": self.rules("backend", "lint")}, "--check-timeout", "0", "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("나타나지 않은 필수 체크 lint", r.stdout)

    def test_rules_lookup_failure_stops(self):
        r = self.run_queue({"1": self.pr(), "_api_fails": True}, "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("필수 체크 규칙 조회 실패", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_empty_required_list_warns_and_keeps_old_behavior(self):
        r = self.run_queue({"1": self.pr()}, "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("필수 체크 목록이 비어 있다", r.stdout)

    def test_up_to_date_updates_branch_waits_and_merges_new_head(self):
        pr = self.pr(statusCheckRollup=[self.check("backend")], after_update=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 2}, "--required", "backend", "--require-up-to-date", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        log = self.log.read_text()
        self.assertIn("api -X PUT repos/owner/repo/pulls/1/update-branch", log)
        self.assertIn("pr merge 1 --merge --match-head-commit new", log)
        self.assertLess(log.index("update-branch"), log.index("pr merge"))

    def test_up_to_date_is_off_by_default(self):
        r = self.run_queue({"1": self.pr(), "_behind": 2}, "--required", "backend", "1")
        self.assertNotIn("update-branch", self.log.read_text())

    def test_up_to_date_skips_update_when_current(self):
        pr = self.pr(statusCheckRollup=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 0}, "--required", "backend", "--require-up-to-date", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("update-branch", self.log.read_text())

    def test_up_to_date_stops_when_update_fails(self):
        pr = self.pr(statusCheckRollup=[self.check("backend")], update_fails=True)
        r = self.run_queue({"1": pr, "_behind": 1}, "--required", "backend", "--require-up-to-date", "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("update-branch 실패", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_up_to_date_needs_required_checks(self):
        r = self.run_queue({"1": self.pr()}, "--require-up-to-date", "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("--required 로 준다", r.stdout)

    def test_missing_option_value_is_usage_error(self):
        r = self.run_queue({}, "1", "--check-timeout")
        self.assertEqual(2, r.returncode)
        r = self.run_queue({}, "--check-timeout", "1.5", "1")
        self.assertEqual(2, r.returncode)

    def test_unknown_option_is_usage_error(self):
        r = self.run_queue({}, "--nope", "1")
        self.assertEqual(2, r.returncode)


class WorkerAskTest(unittest.TestCase):
    """가짜 orca 로 ask 의 성공, 시간 제한, 실패 뒤 대신 보내기를 본다."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.log = self.tmp / "calls.log"
        self.orca = self.tmp / "orca"

    def fake(self, ask_out, ask_rc, check_out='{"result":{"runId":"run_x"}}', send_rc=0):
        self.orca.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            for a in "$@"; do printf '[%s]' "$a" >> "{self.log}"; done; echo >> "{self.log}"
            case "$2" in
              ask) printf '%s\\n' '{ask_out}'; exit {ask_rc} ;;
              check) printf '%s\\n' '{check_out}' ;;
              send) exit {send_rc} ;;
            esac
        """))
        self.orca.chmod(0o755)

    def run_ask(self, *args):
        env = dict(os.environ, ORCA=str(self.orca))
        done = subprocess.run([str(SCRIPTS / "worker-ask.sh"), *args],
                              capture_output=True, text=True, env=env)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        return done.returncode, done.stdout, calls

    def test_answer_is_printed(self):
        self.fake('{"result":{"reply":"그렇게 한다"}}', 0)
        code, out, calls = self.run_ask("--from", "term_w", "--question", "두 단어 질문", "--options", "a,b")
        self.assertEqual(code, 0)
        self.assertIn("그렇게 한다", out)
        self.assertIn("[--question][두 단어 질문]", calls[0])
        self.assertIn("[--options][a,b]", calls[0])

    def test_timeout_keeps_question_for_resume(self):
        self.fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0)
        code, _, calls = self.run_ask("--from", "term_w", "--question", "q", "--timeout-ms", "1000")
        self.assertEqual((code, len(calls)), (4, 1))

    def test_failed_ask_sends_to_run_mailbox(self):
        self.fake('dispatch is not active', 1)
        code, _, calls = self.run_ask("--from", "term_w", "--question", "q")
        self.assertEqual(code, 3)
        self.assertIn("[send]", calls[-1])
        self.assertIn("[--to][run:run_x]", calls[-1])
        self.assertIn("[--type][question]", calls[-1])

    def test_explicit_run_skips_lookup(self):
        self.fake('dispatch is not active', 1)
        code, _, calls = self.run_ask("--from", "term_w", "--question", "q", "--run", "run_y")
        self.assertEqual(code, 3)
        self.assertFalse(any("[check]" in c for c in calls))
        self.assertIn("[--to][run:run_y]", calls[-1])

    def test_failed_resume_does_not_send(self):
        self.fake('unknown message', 1)
        code, _, calls = self.run_ask("--from", "term_w", "--resume", "m1")
        self.assertEqual((code, len(calls)), (2, 1))

    def test_usage_text_mentioning_timeout_is_not_a_timeout(self):
        self.fake('Usage: ask [--timeout-ms <n>]', 1)
        code, _, _ = self.run_ask("--from", "term_w", "--question", "q", "--run", "run_y")
        self.assertEqual(code, 3)

    def test_question_in_variable_from_zsh(self):
        # 호출하는 셸이 zsh 여도 질문 변수를 따옴표로 넘기면 인자 하나로 간다
        if not shutil.which("zsh"):
            self.skipTest("zsh 없음")
        self.fake('{"result":{"reply":"ok"}}', 0)
        env = dict(os.environ, ORCA=str(self.orca), ASK=str(SCRIPTS / "worker-ask.sh"))
        done = subprocess.run(["zsh", "-c", 'Q="두 단어 질문"; "$ASK" --from term_w --question "$Q"'],
                              capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("[--question][두 단어 질문]", self.log.read_text())


if __name__ == "__main__":
    unittest.main()
