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
    def test_read_only_contract_does_not_require_pr(self):
        result = tm.triage([msg("1", "worker_done")], completion_contract="none")
        self.assertIn("worker_done", result["groups"])

    def test_ready_before_since_still_proves_completion(self):
        ids = {"task_id": "task_a", "dispatch_id": "ctx_a"}
        status = dict(msg("s", "status", "2026-10-12T14:00:00Z"), **ids,
                      subject="준비됨 #12, head " + "a" * 40)
        done = dict(msg("d", "worker_done", "2026-10-12T16:00:00Z"), **ids)
        result = tm.triage([status, done], tm.parse_since("2026-10-12T15:00:00Z"))
        self.assertEqual(list(result["groups"]), ["worker_done"])

    def test_parses_objects_mixed_with_noise(self):
        text = '{"_keepalive":true}\n{"result":{"deliveryId":"d1","messages":[]}}\nexit code 0\n{"result":{}}'
        objs = tm.parse_objects(text)
        self.assertEqual(3, len(objs))
        self.assertEqual(["d1"], tm.collect(objs)[0])

    def test_groups_priority_first_and_counts_heartbeats(self):
        msgs = [msg("1", "heartbeat"), msg("2", "status"), msg("3", "worker_done"),
                msg("4", "heartbeat", who="term_b"), msg("5", "question"), msg("6", "heartbeat")]
        r = tm.triage(msgs)
        self.assertEqual(["suspicious_worker_done", "question", "status"], list(r["groups"]))
        self.assertEqual({"term_a": 2, "term_b": 1}, r["heartbeats"])

    def test_dedups_by_id_across_deliveries(self):
        obj = {"result": {"deliveryId": "d", "messages": [msg("1", "worker_done")]}}
        _, messages = tm.collect([obj, obj])
        self.assertEqual(1, len(messages))

    def test_since_filters_old_messages(self):
        msgs = [msg("1", "worker_done", "2026-10-12T14:00:00Z"), msg("2", "worker_done", "2026-10-12T16:00:00Z")]
        r = tm.triage(msgs, tm.parse_since("2026-10-12T15:00:00Z"))
        self.assertEqual(["2"], [m["id"] for m in r["groups"]["suspicious_worker_done"]])

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

    def write_goal(self, details):
        self.board.write_text(json.dumps({"items": [{"id": "goal", "status": "goal", "details": details}]}),
                              encoding="utf-8")

    def test_counts_goal_own_steps_and_skips_reference_lines(self):
        self.write_goal(["✓ 1. 구현", "2. 리뷰", "✓ 3. 머지", "참고: 메모", "✓ 완료한 참고"])
        rc = gp.main(["goal", "--board", str(self.board), "--board-bin", str(self.bin), "--details"])
        self.assertEqual(0, rc)
        # 단계 줄이 곧 하위 줄이라 --details 를 줘도 하위 줄을 다시 쓰지 않는다
        self.assertEqual(["set", "goal", "--progress", "2/3", "--file", str(self.board)],
                         json.loads(self.calls.read_text()))

    def test_no_step_lines_leaves_progress_alone(self):
        self.write_goal(["참고: 메모"])
        self.assertEqual(0, gp.main(["goal", "--board", str(self.board), "--board-bin", str(self.bin)]))
        self.assertFalse(self.calls.exists())

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
            pr["headRefOid"] = pr.get("after_update_head", "new")
            pr["statusCheckRollup"] = []
            pr["appear"] = {"left": 2, "checks": pr.get("after_update", [])}
            state["_behind"] = state.get("_behind_after_update", 0)
            state["_remote_head"] = "new"
            json.dump(state, open(os.environ["FAKE_STATE"], "w"))
            sys.exit(0)
        if state.get("_api_fails"):
            sys.exit(1)
        if "/rules/branches/" in path and state.get("_rules_error"):
            sys.stderr.write(state["_rules_error"]); sys.exit(1)
        if "/rules/branches/" in path:
            data = state.get("_rules", [])
        else:
            data = {"behind_by": state.get("_behind", 0)}
        jq = args[args.index("--jq") + 1] if "--jq" in args else "."
        out = subprocess.run(["jq", "-r", jq], input=json.dumps(data), capture_output=True, text=True)
        sys.stdout.write(out.stdout)
        sys.exit(out.returncode)
    if args[:2] == ["pr", "view"]:
        # 앞의 몇 번은 일시 실패를 흉내 낸다
        if state.get("_view_fails"):
            state["_view_fails"] -= 1
            json.dump(state, open(os.environ["FAKE_STATE"], "w"))
            sys.exit(1)
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
    if args[:1] in (["rev-parse"], ["ls-remote"]):
        state = json.load(open(os.environ["FAKE_STATE"]))
        if args[0] == "ls-remote" and state.get("_ls_remote_fails"):
            sys.exit(2)
        head = state.get("_remote_head", os.environ.get("FAKE_REMOTE_HEAD", ""))
        base_ref = args[0] == "ls-remote" or any(a.endswith("origin/main") for a in args)
        print(state.get("_base_head", head) + "\trefs/heads/main" if args[0] == "ls-remote"
              else state.get("_base_head", head) if base_ref else head)
    sys.exit(0)
    """)


@unittest.skipUnless(shutil.which("jq") and shutil.which("bash"), "jq 와 bash 가 필요하다")
class MergeQueueTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bindir = Path(tempfile.mkdtemp())
        cls.addClassCleanup(shutil.rmtree, cls.bindir)
        for name, body in (("gh", FAKE_GH), ("git", FAKE_GIT), ("sleep", "#!/bin/sh\nexit 0\n")):
            p = cls.bindir / name
            p.write_text(body)
            p.chmod(p.stat().st_mode | stat.S_IEXEC)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.state = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        self.env = dict(os.environ, PATH=f"{self.bindir}:{os.environ['PATH']}", FAKE_STATE=str(self.state),
                        FAKE_LOG=str(self.log), FAKE_REMOTE_HEAD="abc", MERGE_QUEUE_SLEEP_SCALE="0")
        self.sweep_log = self.tmp / "sweep.txt"
        sweep = self.tmp / "sweep.py"
        sweep.write_text(f"import sys\nopen({str(self.sweep_log)!r}, 'w').write(' '.join(sys.argv[1:]))\n")
        self.env["CLEANUP_SWEEP"] = str(sweep)

    def pr(self, **over):
        base = {"state": "OPEN", "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}],
                "mergeable": "MERGEABLE", "url": "https://git.example.com/owner/repo/pull/1",
                "headRefName": "feat", "baseRefName": "main", "headRefOid": "abc",
                "isCrossRepository": False}
        base.update(over)
        return base

    def run_queue(self, state, *args, threads="0"):
        self.state.write_text(json.dumps(state))
        cmd = [sys.executable, str(SCRIPTS / "merge_queue.py"), "--repo", str(self.tmp),
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

    def test_calls_cleanup_sweep_after_merging_with_base_and_args(self):
        r = self.run_queue({"1": self.pr(baseRefName="develop")}, "--sweep-arg", "--run", "--sweep-arg", "run x", "1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("--base develop --apply --run run x", self.sweep_log.read_text())

    def test_no_sweep_and_stop_skip_cleanup(self):
        r = self.run_queue({"1": self.pr()}, "--no-sweep", "1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(self.sweep_log.exists())
        r = self.run_queue({"1": self.pr()}, "1", threads="2")
        self.assertEqual(r.returncode, 1)
        self.assertFalse(self.sweep_log.exists())

    def test_stops_on_unresolved_threads(self):
        r = self.run_queue({"1": self.pr()}, "1", threads="2")
        self.assertEqual(1, r.returncode)
        self.assertIn("threads=2", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_stops_on_failed_check(self):
        r = self.run_queue({"1": self.pr(statusCheckRollup=[{"status": "COMPLETED", "conclusion": "FAILURE"}])}, "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("실패한 체크 1 개", r.stdout)

    def test_failed_pr_lookup_is_retried(self):
        self.env.update(MERGE_QUEUE_GH_RETRIES="3", MERGE_QUEUE_GH_RETRY_SECONDS="0")
        r = self.run_queue({"1": self.pr(), "_view_fails": 2}, "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 MERGED", r.stdout)
        r = self.run_queue({"1": self.pr(), "_view_fails": 3}, "1")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("STOP 1 state=조회 실패", r.stdout)

    def test_skipped_required_check_counts_only_with_the_option(self):
        skipped = [{"name": "verify", "status": "COMPLETED", "conclusion": "SKIPPED"}]
        r = self.run_queue({"1": self.pr(statusCheckRollup=skipped)}, "--required", "verify", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        r = self.run_queue({"1": self.pr(statusCheckRollup=skipped)}, "--required", "verify", "--skipped-is-missing",
                           "--check-timeout", "0", "1")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("나타나지 않은 필수 체크 verify", r.stdout)
        ran = {"left": 3, "checks": [{"name": "verify", "status": "COMPLETED", "conclusion": "SUCCESS"}]}
        r = self.run_queue({"1": self.pr(statusCheckRollup=skipped, appear=ran)}, "--required", "verify",
                           "--skipped-is-missing", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 MERGED", r.stdout)

    def test_after_merged_runs_once_with_merged_prs(self):
        seen = self.tmp / "after.txt"
        after = f'echo "$MERGED_PRS|$CODE_PRS" >> {seen}'
        r = self.run_queue({"1": self.pr(), "2": self.pr(), "3": self.pr(state="MERGED")}, "--after-merged", after,
                           "1", "2", "3")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual("1 2|1 2\n", seen.read_text())

    def test_after_merged_runs_when_a_later_pr_holds(self):
        seen = self.tmp / "after.txt"
        failed = [{"status": "COMPLETED", "conclusion": "FAILURE"}]
        r = self.run_queue({"1": self.pr(), "2": self.pr(statusCheckRollup=failed)},
                           "--after-merged", f'echo "$MERGED_PRS" > {seen}', "1", "2")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertEqual("1\n", seen.read_text())

    def test_after_merged_is_skipped_without_merges_and_its_failure_is_exit_3(self):
        seen = self.tmp / "after.txt"
        r = self.run_queue({"1": self.pr(state="MERGED")}, "--after-merged", f"touch {seen}", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertFalse(seen.exists())
        r = self.run_queue({"1": self.pr()}, "--after-merged", "exit 7", "1")
        self.assertEqual(3, r.returncode, r.stdout + r.stderr)
        self.assertIn("AFTER-MERGED-FAILED 7", r.stdout)
        self.assertIn("1 MERGED", r.stdout)

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

    def test_plan_limited_rules_403_is_treated_as_empty_required_list(self):
        msg = "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)"
        r = self.run_queue({"1": self.pr(), "_rules_error": msg}, "1")
        self.assertEqual(0, r.returncode, r.stdout)
        self.assertIn("저장소 규칙을 읽을 수 없다", r.stdout)
        self.assertIn("필수 체크 목록이 비어 있다", r.stdout)
        self.assertIn("pr merge", self.log.read_text())

    def test_other_rules_failures_still_stop(self):
        for msg in ("gh: Resource not accessible by integration (HTTP 403)", "gh: Not Found (HTTP 404)", "gh: Bad credentials (HTTP 401)"):
            with self.subTest(msg=msg):
                r = self.run_queue({"1": self.pr(), "_rules_error": msg}, "1")
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
        self.assertIn("api --hostname git.example.com -X PUT repos/owner/repo/pulls/1/update-branch", log)
        self.assertIn("pr merge 1 --merge --match-head-commit new", log)
        self.assertLess(log.index("update-branch"), log.index("pr merge"))

    def test_enterprise_host_from_pr_url_goes_to_every_api_call(self):
        # `gh api` 는 origin 을 보지 않아 GitHub Enterprise 저장소에서 github.com 을 물어 실패한다
        host_seen = self.tmp / "threads-host.txt"
        pr = self.pr(url="https://ghe.example.com/owner/repo/pull/1", statusCheckRollup=[self.check("backend")],
                     after_update=[self.check("backend")])
        self.state.write_text(json.dumps({"1": pr, "_rules": self.rules("backend"), "_behind": 1}))
        cmd = [sys.executable, str(SCRIPTS / "merge_queue.py"), "--repo", str(self.tmp), "--require-up-to-date",
               "--threads-cmd", f'echo "$GH_HOST" > {host_seen}; echo 0', "1"]
        env = {k: v for k, v in self.env.items() if k != "GH_HOST"}
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        api = [line for line in self.log.read_text().splitlines() if line.startswith("api ")]
        # 규칙 조회, update-branch 앞뒤의 compare 두 번, update-branch
        self.assertEqual(4, len(api), api)
        for line in api:
            self.assertTrue(line.startswith("api --hostname ghe.example.com "), line)
        self.assertEqual("ghe.example.com\n", host_seen.read_text())

    def test_global_gh_host_does_not_override_pr_url_host(self):
        # 전역 GH_HOST 가 다른 호스트를 가리켜도 `gh pr` 가 origin 으로 정한 호스트를 따른다
        host_seen = self.tmp / "threads-host.txt"
        self.env["GH_HOST"] = "github.com"
        self.state.write_text(json.dumps({"1": self.pr(), "_rules": self.rules()}))
        cmd = [sys.executable, str(SCRIPTS / "merge_queue.py"), "--repo", str(self.tmp),
               "--threads-cmd", f'echo "$GH_HOST" > {host_seen}; echo 0', "1"]
        r = subprocess.run(cmd, capture_output=True, text=True, env=self.env)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("api --hostname git.example.com repos/owner/repo/rules/branches/main", self.log.read_text())
        self.assertEqual("git.example.com\n", host_seen.read_text())

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

    def fake_overlap_units(self, verdict, code, then=(), move_base=False):
        """overlap_units.py 대신 받은 인자를 적고 정해 둔 판정을 내는 가짜. 실제 판정은 test_overlap_units.py 가 본다.

        then 은 두 번째 호출부터 차례로 낼 (판정, 종료 코드) 이고 다 쓰면 마지막 것을 되풀이한다.
        move_base 이면 판정하는 사이 원격 base 가 움직인 것으로 본다.
        """
        script = self.tmp / "overlap_units.py"
        verdicts = [(verdict, code), *then]
        script.write_text(
            "import json, sys\n"
            f"open({str(self.tmp / 'judge-args.txt')!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n"
            f"calls = len(open({str(self.tmp / 'judge-args.txt')!r}).read().splitlines())\n"
            f"verdict, code = {verdicts!r}[min(calls, {len(verdicts)}) - 1]\n"
            f"if {move_base!r}:\n"
            f"    d = json.load(open({str(self.state)!r}))\n"
            "    d['_base_head'] = f'base{calls}'\n"
            f"    json.dump(d, open({str(self.state)!r}, 'w'))\n"
            "print(verdict, file=sys.stderr if code == 2 else sys.stdout)\nsys.exit(code)\n")
        self.env["OVERLAP_UNITS"] = str(script)

    def overlap_queue(self, verdict, code, *extra, behind=2):
        self.fake_overlap_units(verdict, code)
        pr = self.pr(statusCheckRollup=[self.check("backend")], after_update=[self.check("backend")])
        return self.run_queue({"1": pr, "_behind": behind}, "--required", "backend", "--require-up-to-date",
                              "--up-to-date-when", "overlap", *extra, "1")

    def test_up_to_date_when_overlap_merges_without_update_when_units_do_not_overlap(self):
        r = self.overlap_queue("바로 머지", 0, "--shared-paths", "^modules/common/", "--unit-prefix", "apps/",
                               "--docs-glob", "docs/*,*.md", "--unit-group", "web,bff", "--unit-group", "a,b")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 판정: 바로 머지", r.stdout)
        log = self.log.read_text()
        self.assertNotIn("update-branch", log)
        self.assertIn("pr merge 1 --merge --match-head-commit abc", log)
        self.assertEqual("--base origin/main --head abc --shared-paths ^modules/common/ --unit-prefix apps/ "
                         "--docs-glob docs/*,*.md --unit-group web,bff --unit-group a,b\n", (self.tmp / "judge-args.txt").read_text())

    def test_up_to_date_when_overlap_updates_branch_when_units_overlap(self):
        r = self.overlap_queue("갱신 필요(단위 겹침: api)", 1)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 판정: 갱신 필요(단위 겹침: api)", r.stdout)
        log = self.log.read_text()
        self.assertIn("pulls/1/update-branch", log)
        self.assertIn("pr merge 1 --merge --match-head-commit new", log)

    def test_up_to_date_when_overlap_treats_a_failed_judgement_as_needing_update(self):
        r = self.overlap_queue("오류: git diff 실패", 2)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 판정: 갱신 필요(판정 실패: 오류: git diff 실패)", r.stdout)
        self.assertIn("pulls/1/update-branch", self.log.read_text())

    def test_up_to_date_when_overlap_does_not_judge_a_branch_that_is_current(self):
        r = self.overlap_queue("바로 머지", 0, behind=0)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("판정", r.stdout)
        self.assertFalse((self.tmp / "judge-args.txt").exists())

    def test_up_to_date_when_always_keeps_updating_without_judging(self):
        self.fake_overlap_units("바로 머지", 0)
        pr = self.pr(statusCheckRollup=[self.check("backend")], after_update=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 2}, "--required", "backend", "--require-up-to-date",
                           "--up-to-date-when", "always", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("pulls/1/update-branch", self.log.read_text())
        self.assertFalse((self.tmp / "judge-args.txt").exists())

    def test_up_to_date_when_options_are_checked(self):
        for args, message in (
                (["--up-to-date-when", "overlap"], "--require-up-to-date 와 함께"),
                (["--require-up-to-date", "--up-to-date-when", "never"], "always, overlap 중 하나"),
                (["--shared-paths", "^x/"], "--up-to-date-when overlap 과 함께"),
                (["--unit-group", "a,b"], "--up-to-date-when overlap 과 함께")):
            with self.subTest(args=args):
                r = self.run_queue({"1": self.pr()}, *args, "1")
                self.assertEqual(2, r.returncode, r.stdout + r.stderr)
                self.assertIn(message, r.stderr)

    def move_base_cmd(self, **fields):
        sets = "; ".join(f"d[{k!r}]={v!r}" for k, v in fields.items())
        return f"python3 -c \"import json; p='{self.state}'; d=json.load(open(p)); {sets}; json.dump(d, open(p, 'w'))\""

    def judged_count(self):
        return len((self.tmp / "judge-args.txt").read_text().splitlines())

    def test_rejudges_instead_of_stopping_when_base_moves_after_a_direct_merge_judgement(self):
        # 바로 머지로 판정한 뒤 머지 직전에 base 가 움직였다. 새 변경이 겹치지 않으면 멈추지 않고 머지한다
        self.fake_overlap_units("바로 머지", 0)
        pr = self.pr(statusCheckRollup=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 2}, "--required", "backend", "--require-up-to-date",
                           "--up-to-date-when", "overlap", "--before",
                           self.move_base_cmd(_base_head="moved", _behind=3), "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 판정한 뒤 base(main) 가 움직였다. 새로 들어온 변경으로 다시 판정한다", r.stdout)
        self.assertEqual(2, r.stdout.count("1 판정: 바로 머지"), r.stdout)
        log = self.log.read_text()
        self.assertNotIn("update-branch", log)
        self.assertIn("pr merge 1 --merge --match-head-commit abc", log)

    def test_rejudges_when_base_moves_after_the_branch_was_found_current(self):
        # 이미 최신이라 판정 없이 지나갔어도, 그 뒤 머지 전 명령이 base 를 바꾸면 다시 판정한다
        self.fake_overlap_units("바로 머지", 0)
        pr = self.pr(statusCheckRollup=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 0}, "--required", "backend", "--require-up-to-date",
                           "--up-to-date-when", "overlap", "--before",
                           self.move_base_cmd(_base_head="moved", _behind=3), "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 판정한 뒤 base(main) 가 움직였다. 새로 들어온 변경으로 다시 판정한다", r.stdout)
        self.assertEqual(1, self.judged_count())
        self.assertEqual(1, r.stdout.count("1 판정: 바로 머지"), r.stdout)
        log = self.log.read_text()
        self.assertNotIn("update-branch", log)
        self.assertIn("pr merge 1 --merge --match-head-commit abc", log)

    def test_updates_when_base_moves_after_the_branch_was_found_current_and_overlaps(self):
        self.fake_overlap_units("갱신 필요(단위 겹침: api)", 1, then=[("바로 머지", 0)])
        pr = self.pr(statusCheckRollup=[self.check("backend")], after_update=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 0}, "--required", "backend", "--require-up-to-date",
                           "--up-to-date-when", "overlap", "--before",
                           self.move_base_cmd(_base_head="moved", _behind=3), "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        log = self.log.read_text()
        self.assertEqual(1, log.count("update-branch"), log)
        self.assertIn("pr merge 1 --merge --match-head-commit new", log)

    def test_stops_instead_of_rejudging_when_the_base_lookup_fails(self):
        # ls-remote 가 실패하면 빈 값을 「base 가 움직였다」 로 읽어 다시 판정하지 않는다. 조회 실패로 멈춘다
        self.fake_overlap_units("바로 머지", 0)
        pr = self.pr(statusCheckRollup=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 2}, "--required", "backend", "--require-up-to-date",
                           "--up-to-date-when", "overlap", "--before", self.move_base_cmd(_ls_remote_fails=True), "1")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("STOP 1 base 조회 실패", r.stdout)
        self.assertNotIn("다시 판정한다", r.stdout)
        self.assertEqual(1, self.judged_count())
        self.assertNotIn("pr merge", self.log.read_text())

    def test_updates_after_a_pre_merge_base_move_that_overlaps(self):
        # 머지 직전에 움직인 base 가 PR 과 겹치면 그때 갱신하고, 새 HEAD 로 머지한다
        self.fake_overlap_units("바로 머지", 0, then=[("갱신 필요(단위 겹침: api)", 1), ("바로 머지", 0)])
        pr = self.pr(statusCheckRollup=[self.check("backend")], after_update=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 2}, "--required", "backend", "--require-up-to-date",
                           "--up-to-date-when", "overlap", "--before",
                           self.move_base_cmd(_base_head="moved", _behind=3), "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        log = self.log.read_text()
        self.assertEqual(1, log.count("update-branch"))
        self.assertIn("pr merge 1 --merge --match-head-commit new", log)
        # 갱신으로 base 를 모두 품으면 더 판정하지 않는다
        self.assertEqual(2, self.judged_count())

    def test_rejudges_after_update_when_base_moves_again_and_merges_without_second_update(self):
        # 실제 사례: PR 을 갱신한 지 1분 뒤 base 에 문서만 바꾼 PR 이 머지됐다.
        # 예전에는 다시 갱신하고 CI 를 처음부터 기다렸다. 새로 들어온 변경만 보면 겹치지 않아 바로 머지한다
        self.fake_overlap_units("갱신 필요(단위 겹침: api)", 1, then=[("바로 머지", 0)])
        pr = self.pr(statusCheckRollup=[self.check("backend")], after_update=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 2, "_behind_after_update": 1}, "--required", "backend",
                           "--require-up-to-date", "--up-to-date-when", "overlap", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 판정: 갱신 필요(단위 겹침: api)", r.stdout)
        self.assertIn("1 판정: 바로 머지", r.stdout)
        self.assertLess(r.stdout.index("갱신 필요"), r.stdout.index("1 판정: 바로 머지"))
        log = self.log.read_text()
        self.assertEqual(1, log.count("update-branch"), log)
        self.assertIn("pr merge 1 --merge --match-head-commit new", log)
        self.assertEqual(2, self.judged_count())

    def test_rejudge_limit_stops_when_base_keeps_moving(self):
        self.fake_overlap_units("바로 머지", 0, move_base=True)
        pr = self.pr(statusCheckRollup=[self.check("backend")])
        r = self.run_queue({"1": pr, "_behind": 2}, "--required", "backend", "--require-up-to-date",
                           "--up-to-date-when", "overlap", "1")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("STOP 1 다시 판정을 5번 했는데도 base(main) 가 계속 움직인다", r.stdout)
        # 처음 한 번과 다시 판정 5번
        self.assertEqual(6, self.judged_count())
        self.assertNotIn("pr merge", self.log.read_text())

    def test_conflicting_unit_groups_are_a_usage_error_at_start(self):
        r = self.overlap_queue("바로 머지", 0, "--unit-group", "a,b", "--unit-group", "b,c")
        self.assertEqual(2, r.returncode, r.stdout + r.stderr)
        self.assertIn("--unit-group", r.stderr)
        self.assertIn("묶음 둘에 들어 있다", r.stderr)
        self.assertFalse((self.log).exists() and "pr view" in self.log.read_text())

    def test_docs_glob_is_accepted_with_up_to_date_when_overlap_alone(self):
        r = self.overlap_queue("바로 머지", 0, "--docs-glob", "*.md")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)

    def allow_fail_state(self, *failed):
        checks = [self.check("backend")] + [dict(self.check(n), conclusion="FAILURE") for n in failed]
        return {"1": self.pr(statusCheckRollup=checks)}

    def test_failed_optional_check_stops_without_allow_fail(self):
        r = self.run_queue(self.allow_fail_state("claude-review"), "--required", "backend", "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("실패한 체크 1 개", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_allow_fail_merges_and_warns(self):
        r = self.run_queue(self.allow_fail_state("claude-review"), "--required", "backend",
                           "--allow-fail", "claude-review", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("경고: 1 실패를 허용한 체크 claude-review", r.stdout)
        self.assertIn("1 MERGED", r.stdout)
        self.assertLess(r.stdout.index("경고:"), r.stdout.index("MERGED"))

    def test_allow_fail_does_not_cover_other_failed_checks(self):
        r = self.run_queue(self.allow_fail_state("claude-review", "browser"), "--required", "backend",
                           "--allow-fail", "claude-review", "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("실패한 체크 1 개", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_allow_fail_with_required_name_is_usage_error(self):
        r = self.run_queue(self.allow_fail_state(), "--required", "backend,lint", "--allow-fail", "lint", "1")
        self.assertEqual(2, r.returncode)
        self.assertIn("필수 체크의 실패는 허용할 수 없다", r.stderr)

    def test_allow_fail_with_rule_required_name_stops(self):
        state = self.allow_fail_state("backend")
        state["_rules"] = self.rules("backend")
        r = self.run_queue(state, "--allow-fail", "backend", "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("필수 체크의 실패는 허용할 수 없다", r.stdout)
        self.assertNotIn("pr merge", self.log.read_text())

    def test_allow_fail_rejects_quotes(self):
        r = self.run_queue({}, "--allow-fail", 'a"b', "1")
        self.assertEqual(2, r.returncode)

    def test_missing_option_value_is_usage_error(self):
        r = self.run_queue({}, "1", "--check-timeout")
        self.assertEqual(2, r.returncode)
        r = self.run_queue({}, "--check-timeout", "1.5", "1")
        self.assertEqual(2, r.returncode)

    def test_unknown_option_is_usage_error(self):
        r = self.run_queue({}, "--nope", "1")
        self.assertEqual(2, r.returncode)

    def test_verify_when_and_docs_glob_need_verify_merged(self):
        for args in (["--verify-merged-when", "code"], ["--verify-merged-when", "always"], ["--docs-glob", "*.md"]):
            with self.subTest(args=args):
                r = self.run_queue({}, *args, "1")
                self.assertEqual(2, r.returncode)
                self.assertIn("--verify-merged 와 함께 쓴다", r.stderr)
        r = self.run_queue({}, "--verify-merged", "true", "--verify-merged-when", "sometimes", "1")
        self.assertEqual(2, r.returncode)

    def test_hold_stops_the_queue_by_default(self):
        failed = [{"status": "COMPLETED", "conclusion": "FAILURE"}]
        r = self.run_queue({"1": self.pr(statusCheckRollup=failed), "2": self.pr(headRefName="b")}, "1", "2")
        self.assertEqual(1, r.returncode)
        self.assertNotIn("pr merge 2", self.log.read_text())
        self.assertFalse(self.sweep_log.exists())

    def test_continue_on_hold_merges_the_rest_and_reports_held(self):
        failed = [{"status": "COMPLETED", "conclusion": "FAILURE"}]
        state = {"1": self.pr(statusCheckRollup=failed), "2": self.pr(headRefName="b", baseRefName="develop"),
                 "3": self.pr(statusCheckRollup=failed)}
        r = self.run_queue(state, "--continue-on-hold", "1", "2", "3")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("STOP 1 실패한 체크 1 개", r.stdout)
        self.assertIn("1 보류. 다음 PR 로 간다", r.stdout)
        self.assertIn("pr merge 2 --merge", self.log.read_text())
        self.assertIn("QUEUE-HELD 1 3", r.stdout)
        self.assertNotIn("QUEUE-DONE", r.stdout)
        # 머지된 PR 이 있으니 정리는 돈다. base 는 마지막으로 읽은 PR(3) 의 것이다
        self.assertIn("--base main --apply", self.sweep_log.read_text())

    def test_continue_on_hold_with_nothing_held_is_done(self):
        r = self.run_queue({"1": self.pr()}, "--continue-on-hold", "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("QUEUE-DONE", r.stdout)


@unittest.skipUnless(shutil.which("jq") and shutil.which("bash"), "jq 와 bash 가 필요하다")
class MergeQueueOverlapTest(unittest.TestCase):
    """겹침 판정과 합친 사본 검사는 진짜 git 저장소로 본다. gh 와 sleep 만 가짜다."""

    @classmethod
    def setUpClass(cls):
        cls.bindir = Path(tempfile.mkdtemp())
        cls.addClassCleanup(shutil.rmtree, cls.bindir, True)
        for name, body in (("gh", FAKE_GH), ("sleep", "#!/bin/sh\nexit 0\n")):
            f = cls.bindir / name
            f.write_text(body)
            f.chmod(f.stat().st_mode | stat.S_IEXEC)

    def setUp(self):
        # mkdtemp 는 macOS 에서 /var 링크 아래라 실경로 처리를 그대로 겪는다
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        gitconfig = self.tmp / "gitconfig"
        gitconfig.write_text("")
        self.state = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        self.env = dict(os.environ, PATH=f"{self.bindir}:{os.environ['PATH']}", FAKE_STATE=str(self.state),
                        FAKE_LOG=str(self.log), TMPDIR=str(self.tmp), GIT_CONFIG_GLOBAL=str(gitconfig),
                        MERGE_QUEUE_SLEEP_SCALE="0",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@x", GIT_COMMITTER_NAME="t",
                        GIT_COMMITTER_EMAIL="t@x", CLEANUP_SWEEP=str(self.tmp / "sweep.py"))
        (self.tmp / "sweep.py").write_text("")
        self.git("init", "-q", "--bare", "-b", "main", str(self.tmp / "origin.git"), cwd=self.tmp)
        self.repo = self.tmp / "repo"
        self.git("clone", "-q", str(self.tmp / "origin.git"), str(self.repo), cwd=self.tmp)
        self.write({"a.txt": "1\n2\n3\n4\n5\n", "b.txt": "b\n"}, "init")
        self.git("push", "-q", "origin", "HEAD:main")
        self.git("checkout", "-q", "-b", "feat")

    def git(self, *args, cwd=None):
        done = subprocess.run(["git", *args], cwd=cwd or self.repo, capture_output=True, text=True, env=self.env)
        self.assertEqual(0, done.returncode, done.stderr)
        return done.stdout.strip()

    def write(self, files, message):
        for name, text in files.items():
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(text)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def branches(self, feat, main):
        """feat 와 main 에 각각 커밋을 올리고 PR 상태를 쓴다."""
        self.write(feat, "feat")
        self.git("push", "-q", "origin", "feat")
        head = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "main")
        self.write(main, "main")
        self.git("push", "-q", "origin", "main")
        pr = {"state": "OPEN", "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}],
              "mergeable": "MERGEABLE", "url": "https://git.example.com/owner/repo/pull/1",
              "headRefName": "feat", "baseRefName": "main", "headRefOid": head, "isCrossRepository": False}
        self.state.write_text(json.dumps({"1": pr}))

    def run_queue(self, *args):
        cmd = [sys.executable, str(SCRIPTS / "merge_queue.py"), "--repo", str(self.repo), "--threads-cmd", "echo 0",
               "--no-sweep", *args, "1"]
        return subprocess.run(cmd, capture_output=True, text=True, env=self.env)

    def merged(self):
        return "pr merge 1" in (self.log.read_text() if self.log.exists() else "")

    def worktree_count(self):
        return len([x for x in self.git("worktree", "list", "--porcelain").splitlines() if x.startswith("worktree ")])

    def test_overlap_stops_and_lists_files(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n", "c.txt": "c\n"}, {"a.txt": "main\n1\n2\n3\n4\n5\n"})
        r = self.run_queue("--stop-on-overlap")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("STOP 1 겹침: a.txt", r.stdout)
        self.assertNotIn("c.txt", r.stdout)
        self.assertFalse(self.merged())

    def test_no_overlap_merges(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n"}, {"b.txt": "b2\n"})
        r = self.run_queue("--stop-on-overlap")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("겹침", r.stdout)
        self.assertTrue(self.merged())

    def test_no_overlap_skips_verify_command(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n"}, {"b.txt": "b2\n"})
        r = self.run_queue("--verify-merged", "exit 1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertTrue(self.merged())

    def test_verify_merged_runs_in_merged_real_path_copy(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n"}, {"a.txt": "main\n1\n2\n3\n4\n5\n"})
        seen = self.tmp / "seen.txt"
        check = (f'grep -qx main "$1/a.txt" && grep -qx feat "$1/a.txt" && [ "$PWD" = "$1" ] '
                 f'&& printf "%s\\n%s\\n" "$1" "$TMPDIR" > {seen}')
        r = self.run_queue("--verify-merged", check)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 겹침: a.txt", r.stdout)
        self.assertIn("합친 사본의 검사 통과", r.stdout)
        self.assertTrue(self.merged())
        copy, tmpdir = seen.read_text().splitlines()
        real = os.path.realpath(self.tmp)
        self.assertEqual(real, tmpdir)
        self.assertEqual(real, str(Path(copy).parent))
        self.assertFalse(Path(copy).exists())
        self.assertEqual(1, self.worktree_count())

    def test_verify_merged_failure_stops_and_removes_copy(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n"}, {"a.txt": "main\n1\n2\n3\n4\n5\n"})
        seen = self.tmp / "seen.txt"
        r = self.run_queue("--verify-merged", f'echo "$1" > {seen}; exit 3')
        self.assertEqual(1, r.returncode)
        self.assertIn("합친 사본의 검사 실패(종료 코드 3)", r.stdout)
        self.assertFalse(self.merged())
        self.assertFalse(Path(seen.read_text().strip()).exists())
        self.assertEqual(1, self.worktree_count())

    def test_verify_environment_contains_pr_files_overlap_and_commit_ids(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n", "tests/new file.test.ts": "test\n"},
                      {"a.txt": "main\n1\n2\n3\n4\n5\n"})
        seen = self.tmp / "environment.json"
        check = ("python3 -c 'import json,os; "
                 f'json.dump(dict(os.environ),open("{seen}","w"))' + "'")
        r = self.run_queue("--verify-merged", check)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        env = json.loads(seen.read_text())
        self.assertEqual("1", env["PR"])
        self.assertEqual("a.txt\ntests/new file.test.ts", env["CHANGED_FILES"])
        self.assertEqual("a.txt", env["OVERLAP_FILES"])
        self.assertEqual(self.git("rev-parse", "feat"), env["PR_HEAD"])
        self.assertEqual(self.git("rev-parse", "main"), env["BASE_HEAD"])
        self.assertEqual(env["PWD"], env["MERGE_COPY"])
        self.assertFalse(Path(env["MERGE_COPY"]).exists())

    def docs_overlap(self, clean="CLEAN"):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n"}, {"a.txt": "main\n1\n2\n3\n4\n5\n"})
        # update-branch 가 돌려줄 실제 커밋을 준비한다. 처음 조회하는 PR HEAD 는 갱신 전 값이다
        self.git("checkout", "-q", "feat")
        self.git("merge", "-q", "--no-edit", "main")
        self.git("push", "-q", "origin", "feat")
        state = json.loads(self.state.read_text())
        state["1"].update(mergeStateStatus=clean, after_update_head=self.git("rev-parse", "HEAD"),
                          statusCheckRollup=[{"name": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"}],
                          after_update=[{"name": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"}])
        state["_behind"] = 1
        self.state.write_text(json.dumps(state))

    def test_docs_overlap_updates_clean_branch_and_waits_for_new_ci(self):
        self.docs_overlap()
        old = json.loads(self.state.read_text())["1"]["headRefOid"]
        r = self.run_queue("--update-docs-on-overlap", "--docs-glob", "*.txt", "--required", "CI",
                           "--stop-on-overlap")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("update-branch 후 체크를 다시 기다린다", r.stdout)
        self.assertIn(f"expected_head_sha={old}", self.log.read_text())
        self.assertEqual(1, self.log.read_text().count("-X PUT"))
        self.assertTrue(self.merged())

    def test_docs_overlap_requires_clean_status(self):
        self.docs_overlap("BLOCKED")
        r = self.run_queue("--update-docs-on-overlap", "--docs-glob", "*.txt", "--required", "CI")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("GitHub CLEAN 이 필요하다", r.stdout)
        self.assertNotIn("-X PUT", self.log.read_text())
        self.assertFalse(self.merged())

    def test_docs_overlap_update_requires_required_checks(self):
        self.docs_overlap()
        r = self.run_queue("--update-docs-on-overlap", "--docs-glob", "*.txt")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("필수 체크 목록이 필요하다", r.stdout)
        self.assertFalse(self.merged())

    def test_docs_overlap_update_waits_and_stops_if_new_ci_fails(self):
        self.docs_overlap()
        state = json.loads(self.state.read_text())
        state["1"]["after_update"][0]["conclusion"] = "FAILURE"
        self.state.write_text(json.dumps(state))
        r = self.run_queue("--update-docs-on-overlap", "--docs-glob", "*.txt", "--required", "CI")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("실패한 체크", r.stdout)
        self.assertFalse(self.merged())

    def test_conflict_with_base_stops(self):
        self.branches({"a.txt": "1\n2\nfeat\n4\n5\n"}, {"a.txt": "1\n2\nmain\n4\n5\n"})
        r = self.run_queue("--verify-merged", "exit 0")
        self.assertEqual(1, r.returncode)
        self.assertIn("합치면 충돌한다", r.stdout)
        self.assertFalse(self.merged())
        self.assertEqual(1, self.worktree_count())

    def test_verify_when_code_checks_code_pr_without_overlap(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n"}, {"b.txt": "b2\n"})
        r = self.run_queue("--verify-merged", "exit 4", "--verify-merged-when", "code")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("합친 사본의 검사 실패(종료 코드 4)", r.stdout)
        self.assertNotIn("겹침", r.stdout)
        self.assertFalse(self.merged())
        self.assertEqual(1, self.worktree_count())

    def test_docs_only_pr_skips_verify_even_with_overlap(self):
        self.branches({"docs/a.md": "feat\n"}, {"docs/a.md": "main\n"})
        r = self.run_queue("--verify-merged", "exit 1", "--docs-glob", "docs/*,*.txt")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 겹침: docs/a.md", r.stdout)
        self.assertIn("문서만 바꿨다", r.stdout)
        self.assertTrue(self.merged())

    def test_docs_glob_must_cover_every_changed_file(self):
        self.branches({"docs/a.md": "feat\n", "c.py": "c\n"}, {"b.txt": "b2\n"})
        r = self.run_queue("--verify-merged", "exit 5", "--verify-merged-when", "code", "--docs-glob", "docs/*")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("검사 실패(종료 코드 5)", r.stdout)

    def test_docs_only_pr_without_overlap_merges_in_code_mode(self):
        self.branches({"README.md": "x\n"}, {"b.txt": "b2\n"})
        r = self.run_queue("--verify-merged", "exit 1", "--verify-merged-when", "code", "--docs-glob", "*.md")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertTrue(self.merged())

    def test_after_merged_leaves_docs_prs_out_of_code_prs(self):
        seen = self.tmp / "after.txt"
        after = f'echo "$MERGED_PRS|$CODE_PRS" > {seen}'
        self.branches({"docs/a.md": "x\n"}, {"b.txt": "b2\n"})
        r = self.run_queue("--after-merged", after, "--docs-glob", "docs/*")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual("1|\n", seen.read_text())

    def test_after_merged_counts_code_prs(self):
        seen = self.tmp / "after.txt"
        self.branches({"docs/a.md": "x\n", "c.py": "c\n"}, {"b.txt": "b2\n"})
        r = self.run_queue("--after-merged", f'echo "$MERGED_PRS|$CODE_PRS" > {seen}', "--docs-glob", "docs/*")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual("1|1\n", seen.read_text())

    def test_verify_when_always_checks_docs_only_pr_too(self):
        self.branches({"README.md": "x\n"}, {"b.txt": "b2\n"})
        r = self.run_queue("--verify-merged", "exit 6", "--verify-merged-when", "always", "--docs-glob", "*.md")
        self.assertEqual(1, r.returncode, r.stdout + r.stderr)
        self.assertIn("검사 실패(종료 코드 6)", r.stdout)

    def test_copies_left_by_dead_runs_are_removed_at_start(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n"}, {"b.txt": "b2\n"})
        gone = subprocess.Popen(["true"])
        gone.wait()
        real = Path(os.path.realpath(self.tmp))
        dead, alive = real / f"merge-queue-pr9-{gone.pid}", real / f"merge-queue-pr8-{os.getpid()}"
        for copy in (dead, alive):
            self.git("worktree", "add", "-q", "--detach", str(copy), "main")
        r = self.run_queue("--stop-on-overlap")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn(f"남긴 사본을 지웠다: {dead}", r.stdout)
        self.assertFalse(dead.exists())
        self.assertTrue(alive.exists())
        self.assertEqual(2, self.worktree_count())

    def test_copy_dir_is_relative_to_repo(self):
        self.branches({"a.txt": "1\n2\n3\n4\n5\nfeat\n"}, {"a.txt": "main\n1\n2\n3\n4\n5\n"})
        seen = self.tmp / "seen.txt"
        r = self.run_queue("--copy-dir", "worktrees/repo", "--verify-merged", f'echo "$1" > {seen}')
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(os.path.realpath(self.repo / "worktrees" / "repo"), str(Path(seen.read_text().strip()).parent))


class CiLookupTest(unittest.TestCase):
    def test_no_script_filters_run_list_by_commit(self):
        """`gh run list --commit` 은 최근 실행 N 개를 받은 뒤 커밋으로 필터링한다. CI 가 몰리면 그 PR 의 실행이 밀려나
        「실행 없음」 으로 머지를 보류한다(2026-10-23 gersang-lab). 커밋의 실행은 actions/runs?head_sha= 로 읽는다"""
        import re
        found = []
        for f in sorted(SCRIPTS.iterdir()):
            if f.suffix in (".py", ".sh") and re.search(r"run[\"', ]+list[^\n]*--commit", f.read_text(encoding="utf-8")):
                found.append(f.name)
        self.assertEqual([], found)


class WorkerAskTest(unittest.TestCase):
    """가짜 orca 로 ask 의 성공, 시간 제한, 실패 뒤 대신 보내기를 본다."""

    @classmethod
    def setUpClass(cls):
        cls.bindir = Path(tempfile.mkdtemp())
        cls.addClassCleanup(shutil.rmtree, cls.bindir)
        cls.orca = cls.bindir / "orca"
        cls.orca.write_text(textwrap.dedent("""\
            #!/usr/bin/env bash
            for a in "$@"; do printf '[%s]' "$a" >> "$FAKE_LOG"; done; echo >> "$FAKE_LOG"
            case "$2" in
              ask) cat "$FAKE_DIR/ask.out"; echo; exit "$FAKE_ASK_RC" ;;
              check)
                n=$(($(cat "$FAKE_DIR/n" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_DIR/n"
                f="$FAKE_DIR/check$n.json"; [ -f "$f" ] || f="$FAKE_DIR/check.json"; cat "$f"; echo ;;
              send) exit "$FAKE_SEND_RC" ;;
            esac
        """))
        cls.orca.chmod(0o755)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.log = self.tmp / "calls.log"

    def fake(self, ask_out, ask_rc, check_out='{"result":{"runId":"run_x"}}', send_rc=0, checks=()):
        """checks 를 주면 n 번째 check 가 그 n 번째 출력을 낸다. 다 쓰면 check_out 을 낸다."""
        (self.tmp / "check.json").write_text(check_out)
        (self.tmp / "ask.out").write_text(ask_out)
        self.env = dict(os.environ, ORCA=str(self.orca), ORCH_ASK_SEEN=str(self.tmp / "seen"),
                        FAKE_DIR=str(self.tmp), FAKE_LOG=str(self.log),
                        FAKE_ASK_RC=str(ask_rc), FAKE_SEND_RC=str(send_rc))
        for i, out in enumerate(checks, 1):
            (self.tmp / f"check{i}.json").write_text(json.dumps(out))

    @staticmethod
    def inbox(*messages, dispatch="ctx_1"):
        return {"result": {"runId": "run_x", "dispatchId": dispatch, "messages": list(messages)}}

    @staticmethod
    def message(kind="status", body="본문", who="term_c", thread=None, to="dispatch:ctx_1"):
        return {"id": "msg_c", "type": kind, "subject": "s", "body": body, "from_handle": who,
                "to_handle": to, "thread_id": thread, "created_at": "2026-10-19T10:00:00Z"}

    def run_ask(self, *args):
        done = subprocess.run([str(SCRIPTS / "worker-ask.sh"), *args],
                              capture_output=True, text=True, env=self.env)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        return done.returncode, done.stdout, calls

    def test_answer_is_the_first_line(self):
        self.fake('{"result":{"answer":"그렇게 한다","messageId":"m1"}}', 0)
        code, out, calls = self.run_ask("--from", "term_w", "--question", "두 단어 질문", "--options", "a,b")
        self.assertEqual(code, 0)
        self.assertEqual("answer: 그렇게 한다", out.splitlines()[0])
        self.assertIn('"messageId":"m1"', out)
        self.assertIn("[check][--terminal][term_w][--peek]", calls[0])
        self.assertIn("[--question][두 단어 질문]", calls[1])
        self.assertIn("[--options][a,b]", calls[1])

    def test_reply_object_is_read_as_answer(self):
        self.fake('{"result":{"reply":{"body":"B 로 간다"}}}', 0)
        _, out, _ = self.run_ask("--from", "term_w", "--question", "q")
        self.assertEqual("answer: B 로 간다", out.splitlines()[0])

    def test_unread_coordinator_message_stops_before_asking(self):
        self.fake('{"result":{"answer":"x"}}', 0, checks=[self.inbox(self.message(body="이미 정했다: A"))])
        code, out, calls = self.run_ask("--from", "term_w", "--question", "q")
        self.assertEqual(code, 5)
        self.assertIn("이미 정했다: A", out)
        self.assertFalse(any("[ask]" in c for c in calls))

    def test_message_shown_once_does_not_stop_the_next_call(self):
        # worker 가 check 로 읽어도 ack 하지 않으면 --peek 에 남는다. 같은 메시지로 두 번 막지 않는다
        unread = self.inbox(self.message(body="이미 정했다: A"))
        self.fake('{"result":{"answer":"x"}}', 0, checks=[unread, unread])
        first, _, _ = self.run_ask("--from", "term_w", "--question", "q")
        second, out, _ = self.run_ask("--from", "term_w", "--question", "q")
        self.assertEqual((first, second), (5, 0))
        self.assertEqual("answer: x", out.splitlines()[0])

    def test_force_asks_despite_unread_message(self):
        self.fake('{"result":{"answer":"x"}}', 0, checks=[self.inbox(self.message())])
        code, _, calls = self.run_ask("--from", "term_w", "--question", "q", "--force")
        self.assertEqual(code, 0)
        self.assertIn("[ask]", calls[0])

    def test_own_messages_and_heartbeats_do_not_stop_asking(self):
        unread = self.inbox(self.message(who="term_w"), self.message(kind="heartbeat"))
        self.fake('{"result":{"answer":"x"}}', 0, checks=[unread])
        code, _, _ = self.run_ask("--from", "term_w", "--question", "q")
        self.assertEqual(code, 0)

    def test_timeout_keeps_question_for_resume(self):
        self.fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0)
        code, out, calls = self.run_ask("--from", "term_w", "--question", "q", "--timeout-ms", "1000")
        self.assertEqual((code, len(calls)), (4, 3))
        self.assertNotIn("answer:", out)

    def test_timeout_returns_status_reply_in_the_question_thread(self):
        reply = self.message(body="status 로 답한다: B", thread="m1", to="run:run_x")
        self.fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0, checks=[self.inbox(), self.inbox(reply)])
        code, out, _ = self.run_ask("--from", "term_w", "--question", "q")
        self.assertEqual(code, 3)
        self.assertEqual("answer: status 로 답한다: B", out.splitlines()[0])

    def test_timeout_returns_status_sent_to_this_dispatch(self):
        reply = self.message(body="dispatch 로 답한다")
        self.fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0, checks=[self.inbox(), self.inbox(reply)])
        code, out, _ = self.run_ask("--from", "term_w", "--question", "q")
        self.assertEqual((code, out.splitlines()[0]), (3, "answer: dispatch 로 답한다"))

    def test_timeout_ignores_status_of_another_thread_and_dispatch(self):
        other = self.message(body="다른 질문의 답", thread="m9", to="dispatch:ctx_9")
        self.fake('{"result":{"timedOut":true,"messageId":"m1"}}', 0, checks=[self.inbox(), self.inbox(other)])
        code, out, _ = self.run_ask("--from", "term_w", "--question", "q")
        self.assertEqual(code, 4)
        self.assertNotIn("answer:", out)

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
        # check 는 묻기 전의 읽지 않은 메시지 확인 한 번뿐이다
        self.assertEqual(1, sum("[check]" in c for c in calls))
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
        env = dict(self.env, ASK=str(SCRIPTS / "worker-ask.sh"))
        done = subprocess.run(["zsh", "-c", 'Q="두 단어 질문"; "$ASK" --from term_w --question "$Q"'],
                              capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("[--question][두 단어 질문]", self.log.read_text())


if __name__ == "__main__":
    unittest.main()
