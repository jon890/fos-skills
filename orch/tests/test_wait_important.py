"""wait-important.py 를 가짜 orca 로 검증한다. Orca 에는 닿지 않는다."""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "wait-important.py"

# 차례로 응답을 하나씩 낸다. 부를 때마다 인자를 기록한다
FAKE_ORCA = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    path = os.environ["FAKE_STATE"]
    st = json.load(open(path))
    open(os.environ["FAKE_LOG"], "a").write(json.dumps(sys.argv[1:]) + "\\n")
    print('{"_keepalive":true}', file=sys.stderr)
    if "worker-list" in sys.argv:
        lists = st.get("workers", [])
        rows = lists.pop(0) if len(lists) > 1 else (lists[0] if lists else [])
        json.dump(st, open(path, "w"))
        print(json.dumps({"ok": True, "result": {"workers": rows}}))
        sys.exit(0)
    if "task-list" in sys.argv or "dispatch-show" in sys.argv:
        if "task-list" in sys.argv:
            result = {"tasks": st.get("tasks", [])}
        else:
            latest = st.get("latest", {}).get(sys.argv[sys.argv.index("--task") + 1])
            # 값은 dispatch id 이거나 dispatch-show 의 dispatch 그대로다
            result = {"dispatch": latest if isinstance(latest, dict) else {"id": latest}} if latest else {}
        print(json.dumps({"ok": True, "result": result}))
        sys.exit(0)
    if "--all" in sys.argv:
        print(json.dumps({"ok": not st.get("history_fail"), "result": {"messages": st.get("history", [])}}))
        sys.exit(0)
    reply = st["replies"].pop(0) if st["replies"] else {"ok": True, "result": {"deliveryId": None, "messages": [], "timedOut": True}}
    json.dump(st, open(path, "w"))
    if reply.get("sleep"):
        import time; time.sleep(reply.pop("sleep"))
    print(json.dumps(reply))
    sys.exit(0 if reply.get("ok") else 1)
    """)


def batch(delivery, *types):
    return {"ok": True, "result": {"deliveryId": delivery, "timedOut": False,
                                   "messages": [{"id": f"{delivery}-{i}", "type": t} for i, t in enumerate(types)]}}


class WaitImportantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # macOS 는 새로 만든 실행 파일을 처음 실행할 때 검사하느라 몇 초를 쓴다(부하가 높으면 더 길다).
        # 테스트마다 가짜를 새로 만들면 첫 check 호출이 시간 한도 테스트의 한도를 넘긴다.
        # 가짜는 클래스에서 한 번 만들고 한 번 실행해 둔다
        cls.bin = Path(tempfile.mkdtemp())
        cls.addClassCleanup(shutil.rmtree, cls.bin)
        cls.orca = cls.bin / "orca"
        cls.orca.write_text(FAKE_ORCA)
        # ps 는 FAKE_PS 파일의 내용을 낸다. 파일이 없으면 아무것도 내지 않는다
        cls.ps = cls.bin / "ps"
        cls.ps.write_text('#!/bin/sh\ncat "$FAKE_PS" 2>/dev/null\n')
        for fake in (cls.orca, cls.ps):
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            subprocess.run([str(fake)], capture_output=True, env={"PATH": os.environ.get("PATH", "")})

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.state = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        self.ps_rows = self.tmp / "ps.txt"
        self.lost_state = self.tmp / "lost.json"
        self.env = dict(os.environ, ORCA=str(self.orca), FAKE_STATE=str(self.state), FAKE_LOG=str(self.log),
                        PS=str(self.ps), FAKE_PS=str(self.ps_rows))

    def wait(self, replies, *args, workers=None, tasks=None, latest=None, history=None, contract="none", history_fail=False):
        self.state.write_text(json.dumps({"replies": replies, "workers": workers or [], "tasks": tasks or [],
                                          "latest": latest or {}, "history": history or [], "history_fail": history_fail}))
        return subprocess.run(["python3", str(SCRIPT), "--run", "run_x", "--lost-state", str(self.lost_state),
                               "--completion-contract", contract, *args],
                              capture_output=True, text=True, env=self.env)

    def calls(self):
        # worker-list 호출은 대기 호출이 아니다
        skip = ("worker-list", "task-list", "dispatch-show")
        return [c for c in (json.loads(line) for line in self.log.read_text().splitlines()) if not set(skip) & set(c)]

    def ack_of(self, call):
        return call[call.index("--ack") + 1] if "--ack" in call else None

    @staticmethod
    def worker(dispatch, state, status, detail, task="t1"):
        return {"dispatchId": dispatch, "taskId": task, "workerState": state, "dispatchStatus": status,
                "projection": {"stage": {"detail": detail}}}

    def lost_at_start(self, *args, task_status="dispatched", result=None, latest="ctx_bad"):
        """시작할 때 이미 failed/abandoned 인 ctx_bad 하나가 있는 Run 에 대기를 건다"""
        rows = [self.worker("ctx_bad", "abandoned", "failed", "terminal_missing")]
        tasks = [{"id": "t1", "status": task_status, "result": result}]
        return self.wait([batch("d1", "worker_done")], "--lost-interval-sec", "0.3", *args, workers=[rows],
                         tasks=tasks, latest={"t1": latest})

    def test_worker_that_was_live_and_becomes_abandoned_ends_the_wait(self):
        live = [self.worker("ctx_a", "ready", "dispatched", "input_accepted"), self.worker("ctx_done", "succeeded", "completed", "settled")]
        gone = [self.worker("ctx_a", "abandoned", "failed", "terminal_missing"), self.worker("ctx_done", "succeeded", "completed", "settled")]
        r = self.wait([dict(batch("d9", "worker_done"), sleep=5)], "--lost-interval-sec", "0.3", "--ack", "d0",
                      workers=[live, live, gone])
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)
        lines = r.stdout.splitlines()
        self.assertEqual(["WORKER_LOST ctx_a stage=terminal_missing", "LAST_DELIVERY d0"], lines)

    def test_only_finished_dispatches_do_not_end_the_wait(self):
        done = [self.worker("ctx_old", "succeeded", "completed", "settled")]
        r = self.wait([dict(batch("d1", "worker_done"), sleep=1)], "--lost-interval-sec", "0.3", workers=[done])
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual("LAST_DELIVERY d1", r.stdout.splitlines()[-1])
        self.assertNotIn("WORKER_LOST", r.stdout)

    def test_settled_dispatch_with_missing_terminal_is_not_lost(self):
        for status in ("completed", "abandoned"):
            with self.subTest(status=status):
                rows = [self.worker("ctx_old", "abandoned", status, "terminal_missing")]
                r = self.wait([batch("d1", "status")], workers=[rows],
                              tasks=[{"id": "t1", "status": "dispatched"}], latest={"t1": "ctx_old"})
                self.assertEqual(0, r.returncode, r.stdout + r.stderr)
                self.assertNotIn("WORKER_LOST", r.stdout)

    def test_failed_worker_report_camel_case_is_not_lost(self):
        r = self.lost_at_start(latest={"id": "ctx_bad", "lastFailure": {"provenance": "worker_report"}})
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("WORKER_LOST", r.stdout)

    def test_explicit_abandon_is_not_lost_but_recovery_loss_still_is(self):
        r = self.lost_at_start(latest={"id": "ctx_bad", "lastFailure": "abandoned"})
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("WORKER_LOST", r.stdout)
        self.lost_state.unlink()
        r = self.lost_at_start(latest={"id": "ctx_bad", "lastFailure": "The assigned worker terminal is no longer live after orchestration recovery."})
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)

    def test_completion_while_waiting_does_not_become_lost(self):
        live = [self.worker("ctx_a", "ready", "dispatched", "input_accepted")]
        done = [self.worker("ctx_a", "abandoned", "completed", "terminal_missing")]
        r = self.wait([dict(batch("d1", "worker_done"), sleep=1)], "--lost-interval-sec", "0.3",
                      workers=[live, live, done])
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("WORKER_LOST", r.stdout)

    def test_unhandled_lost_dispatch_at_start_ends_the_wait_without_checking(self):
        r = self.lost_at_start("--ack", "d0")
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["WORKER_LOST ctx_bad stage=terminal_missing", "LAST_DELIVERY d0"], r.stdout.splitlines())
        self.assertEqual([], self.calls())

    def test_lost_dispatch_with_a_later_dispatch_is_ignored(self):
        r = self.lost_at_start(latest="ctx_new")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("WORKER_LOST", r.stdout)

    def test_ignore_lost_skips_the_dispatch(self):
        r = self.lost_at_start("--ignore-lost", "ctx_other", "--ignore-lost", "ctx_bad")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("WORKER_LOST", r.stdout)

    def test_lost_dispatch_of_completed_or_cancelled_task_is_ignored(self):
        for status, result in (("completed", "{}"), ("failed", "cancelled")):
            r = self.lost_at_start(task_status=status, result=result)
            self.assertEqual(0, r.returncode, status + r.stdout + r.stderr)
        r = self.lost_at_start(task_status="failed", result="circuit broken")
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)

    def test_lost_dispatch_is_reported_only_once(self):
        r = self.lost_at_start()
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["ctx_bad"], list(json.loads(self.lost_state.read_text())["run_x"]))
        self.assertTrue(json.loads(self.lost_state.read_text())["run_x"]["ctx_bad"].startswith("lost "))
        r = self.lost_at_start()
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("WORKER_LOST", r.stdout)
        # 깨우지는 않지만 아직 끊긴 채라는 것은 남긴다
        self.assertIn("아직 처리되지 않았다: ctx_bad", r.stderr)

    def test_reported_dispatches_are_kept_per_run(self):
        self.lost_state.write_text(json.dumps({"run_other": {"ctx_bad": "2026-10-22T00:00:00Z"}}))
        r = self.lost_at_start()
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)
        self.assertEqual({"run_other", "run_x"}, set(json.loads(self.lost_state.read_text())))

    def test_ack_lost_persists_without_waiting_or_warning(self):
        self.assertEqual(5, self.lost_at_start().returncode)
        self.log.unlink()
        r = self.wait([], "--ack-lost", "ctx_bad", "--ack-lost", "ctx_other")
        self.assertEqual(0, r.returncode, r.stderr)
        self.assertFalse(self.log.exists(), "확인 기록만 할 때 Orca 를 호출했다")
        entry = json.loads(self.lost_state.read_text())["run_x"]
        self.assertTrue(all(entry[d].startswith("handled ") for d in ("ctx_bad", "ctx_other")))
        r = self.lost_at_start()
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("아직 처리되지 않았다", r.stderr)
        self.assertNotIn("WORKER_LOST", r.stdout)

    def test_ack_lost_does_not_change_other_runs_or_unhandled_dispatches(self):
        self.lost_state.write_text(json.dumps({"run_other": {"ctx_bad": "lost old"},
                                               "run_x": {"ctx_unhandled": "lost old"}}))
        r = self.wait([], "--ack-lost", "ctx_bad")
        self.assertEqual(0, r.returncode, r.stderr)
        data = json.loads(self.lost_state.read_text())
        self.assertEqual("lost old", data["run_other"]["ctx_bad"])
        self.assertEqual("lost old", data["run_x"]["ctx_unhandled"])

    def test_ack_lost_write_failure_is_not_success(self):
        self.lost_state.mkdir()
        r = self.wait([], "--ack-lost", "ctx_bad")
        self.assertEqual(1, r.returncode, r.stderr)
        self.assertNotIn("ACK_LOST", r.stdout)

    def test_unreadable_lost_state_reports_again(self):
        self.lost_state.write_text("not json")
        r = self.lost_at_start()
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)
        self.assertIn("ctx_bad", json.loads(self.lost_state.read_text())["run_x"])

    def test_deliberately_ended_dispatch_at_start_is_ignored(self):
        """코디네이터가 터미널을 닫았거나 worker 가 실패를 알린 dispatch 는 끊긴 것이 아니다(2026-10-22 옛 dispatch 31개)"""
        closed = {"id": "ctx_bad", "termination_reason": "operator_close"}
        reported = {"id": "ctx_bad", "termination_reason": None,
                    "last_failure": json.dumps({"provenance": "worker_report", "outcome": "failed"})}
        for latest, reason in ((closed, "operator_close"), (reported, "worker_report")):
            self.lost_state.unlink(missing_ok=True)
            r = self.lost_at_start(task_status="ready", latest=latest)
            self.assertEqual(0, r.returncode, r.stdout + r.stderr)
            self.assertNotIn("WORKER_LOST", r.stdout)
            self.assertTrue(json.loads(self.lost_state.read_text())["run_x"]["ctx_bad"].startswith(reason + " "))
        # 판정을 적어 두었으므로 다음 대기는 다시 조회하지도, 알리지도 않는다
        self.log.unlink()
        r = self.lost_at_start(task_status="ready", latest=reported)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual([], [l for l in self.log.read_text().splitlines() if "dispatch-show" in l])
        self.assertNotIn("아직 처리되지 않았다", r.stderr)
        self.lost_state.unlink()
        missing = {"id": "ctx_bad", "termination_reason": None,
                   "last_failure": "The assigned worker terminal is no longer live"}
        r = self.lost_at_start(task_status="ready", latest=missing)
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)

    def test_worker_closed_by_operator_during_the_wait_does_not_end_it(self):
        live = [self.worker("ctx_a", "ready", "dispatched", "input_accepted")]
        closed = [self.worker("ctx_a", "failed", "failed", "process_exited")]
        r = self.wait([dict(batch("d9", "worker_done"), sleep=2)], "--lost-interval-sec", "0.3",
                      workers=[live, live, closed], tasks=[{"id": "t1", "status": "ready"}],
                      latest={"t1": {"id": "ctx_a", "termination_reason": "operator_close"}})
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertNotIn("WORKER_LOST", r.stdout)
        self.assertEqual("LAST_DELIVERY d9", r.stdout.splitlines()[-1])
        # 한 번 뺀 dispatch 는 다시 묻지 않는다
        shows = [l for l in self.log.read_text().splitlines() if "dispatch-show" in l]
        self.assertEqual(1, len(shows), shows)

    def test_lost_during_wait_is_recorded(self):
        live = [self.worker("ctx_a", "ready", "dispatched", "input_accepted")]
        gone = [self.worker("ctx_a", "abandoned", "failed", "terminal_missing")]
        r = self.wait([dict(batch("d9", "worker_done"), sleep=5)], "--lost-interval-sec", "0.3",
                      workers=[live, live, gone])
        self.assertEqual(5, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["ctx_a"], list(json.loads(self.lost_state.read_text())["run_x"]))

    def test_unreadable_latest_dispatch_keeps_the_old_behavior(self):
        r = self.lost_at_start(latest=None)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)

    def test_zero_interval_never_looks_at_workers(self):
        live = [self.worker("ctx_a", "ready", "dispatched", "input_accepted")]
        r = self.wait([batch("d1", "worker_done")], "--lost-interval-sec", "0", workers=[live])
        self.assertEqual(0, r.returncode)
        self.assertEqual([], [l for l in self.log.read_text().splitlines() if "worker-list" in l])

    def test_heartbeats_are_acked_until_a_worker_done_arrives(self):
        r = self.wait([batch("d1", "heartbeat", "heartbeat"), batch("d2", "heartbeat"), batch("d3", "heartbeat", "worker_done")])
        self.assertEqual(0, r.returncode, r.stderr)
        self.assertEqual([None, "d1", "d2"], [self.ack_of(c) for c in self.calls()])
        lines = r.stdout.splitlines()
        self.assertEqual("LAST_DELIVERY d3", lines[-1])
        self.assertEqual("d3", json.loads(lines[0])["result"]["deliveryId"])

    def test_each_wake_type_stops_the_wait(self):
        for kind in ("question", "escalation", "status", "worker_done"):
            r = self.wait([batch("d1", kind)], "--ack", "d0")
            self.assertEqual(0, r.returncode, kind)
            self.assertIn("LAST_DELIVERY d1", r.stdout)
            self.assertEqual("d0", self.ack_of(self.calls()[-1]))

    def test_types_option_changes_what_wakes(self):
        r = self.wait([batch("d1", "status"), batch("d2", "worker_done")], "--types", "worker_done")
        self.assertEqual(0, r.returncode)
        self.assertEqual([None, "d1"], [self.ack_of(c) for c in self.calls()])
        self.assertIn("LAST_DELIVERY d2", r.stdout)
        self.assertIn("worker_done", self.calls()[0][self.calls()[0].index("--types") + 1])

    def test_timeout_after_acking_heartbeats_has_nothing_pending(self):
        r = self.wait([batch("d1", "heartbeat")], "--timeout-ms", "1500")
        self.assertEqual(3, r.returncode)
        self.assertEqual("d1", self.ack_of(self.calls()[1]))
        self.assertEqual("TIMEOUT LAST_DELIVERY -", r.stdout.splitlines()[-1])

    def test_heartbeat_batch_at_the_deadline_is_left_for_the_next_wait(self):
        r = self.wait([dict(batch("d1", "heartbeat"), sleep=0.6)], "--timeout-ms", "300")
        self.assertEqual(3, r.returncode)
        self.assertEqual(1, len(self.calls()))
        self.assertEqual("TIMEOUT LAST_DELIVERY d1", r.stdout.splitlines()[-1])

    def test_timeout_without_any_delivery(self):
        r = self.wait([], "--timeout-ms", "300")
        self.assertEqual(3, r.returncode)
        self.assertIn("TIMEOUT LAST_DELIVERY -", r.stdout)

    def test_orca_error_is_printed_and_keeps_the_pending_ack(self):
        err = {"ok": False, "error": {"code": "runtime_unavailable"}}
        r = self.wait([batch("d1", "heartbeat"), err])
        self.assertEqual(1, r.returncode)
        self.assertIn("runtime_unavailable", r.stdout)
        self.assertEqual("LAST_DELIVERY d1", r.stdout.splitlines()[-1])

    WAITER_EXISTS = {"ok": False, "error": {"code": "waiter_exists",
                                            "message": "Run run_x already has an active actionable waiter."}}

    def ps_line(self, pid, ppid, command):
        return f"{pid:>5} {ppid:>5} Tue Oct 20 10:00:00 2026     {command}"

    def test_waiter_exists_stops_at_once_and_lists_leftover_waiters(self):
        self.ps_rows.write_text("\n".join([
            self.ps_line(101, 1, "/bin/zsh -c python3 wait-important.py --run run_x"),
            self.ps_line(102, 101, "python3 wait-important.py --run run_x"),
            self.ps_line(103, 102, "node orca orchestration check --run run_x --wait --json"),
            self.ps_line(201, 900, "node orca orchestration check --run run_x --wait --json"),
            self.ps_line(301, 1, "node orca orchestration check --run run_other --wait --json"),
            self.ps_line(302, 1, "node orca orchestration check --run run_x_extra --wait --json"),
            self.ps_line(401, 1, "node orca orchestration check --run run_x --json"),
        ]) + "\n")
        r = self.wait([self.WAITER_EXISTS, batch("d1", "worker_done")], "--ack", "d0")
        self.assertEqual(4, r.returncode, r.stderr)
        self.assertEqual(1, len(self.calls()), "waiter_exists 를 받고 다시 걸었다")
        self.assertEqual("LAST_DELIVERY d0", r.stdout.splitlines()[-1])
        for pid in ("101", "102", "103", "201"):
            self.assertIn(f"PID {pid}", r.stderr)
        self.assertNotIn("PID 301", r.stderr)
        self.assertNotIn("PID 302", r.stderr)
        self.assertNotIn("PID 401", r.stderr)
        self.assertIn("kill 101 102 103", r.stderr)
        self.assertIn("부모 900 살아 있음", r.stderr)

    def test_waiter_exists_is_recognized_by_message_alone(self):
        err = {"ok": False, "error": {"code": "conflict", "message": "Run run_x already has an active actionable waiter."}}
        r = self.wait([err])
        self.assertEqual(4, r.returncode)
        self.assertIn("찾지 못했다", r.stderr)

    def test_kill_stale_kills_only_orphaned_waiters(self):
        orphan = subprocess.Popen(["sleep", "30"])
        live = subprocess.Popen(["sleep", "30"])
        for proc in (orphan, live):
            self.addCleanup(proc.wait)
            self.addCleanup(proc.kill)
        self.ps_rows.write_text("\n".join([
            self.ps_line(orphan.pid, 1, "node orca orchestration check --run run_x --wait --json"),
            self.ps_line(live.pid, 900, "node orca orchestration check --run run_x --wait --json"),
        ]) + "\n")
        r = self.wait([self.WAITER_EXISTS], "--kill-stale")
        self.assertEqual(4, r.returncode, r.stderr)
        self.assertIsNotNone(orphan.wait(timeout=5))
        self.assertIsNone(live.poll())
        self.assertIn(f"PID {orphan.pid} 를 종료했다", r.stderr)

    def test_kill_stale_follows_non_waiting_orphan_shell_ancestors(self):
        orphan = subprocess.Popen(["sleep", "30"])
        self.addCleanup(orphan.wait)
        self.addCleanup(orphan.kill)
        self.ps_rows.write_text("\n".join([
            self.ps_line(501, 1, "/bin/zsh"),
            self.ps_line(502, 501, "/bin/bash -c runner"),
            self.ps_line(orphan.pid, 502, "node orca orchestration check --run run_x --wait --json"),
        ]) + "\n")
        r = self.wait([self.WAITER_EXISTS], "--kill-stale")
        self.assertEqual(4, r.returncode, r.stderr)
        self.assertIsNotNone(orphan.wait(timeout=5))
        self.assertIn(f"PID {orphan.pid} 를 종료했다", r.stderr)
        self.assertNotIn("PID 501 를 종료했다", r.stderr)

    def test_kill_stale_preserves_waiters_under_live_app(self):
        live = subprocess.Popen(["sleep", "30"])
        self.addCleanup(live.wait)
        self.addCleanup(live.kill)
        self.ps_rows.write_text("\n".join([
            self.ps_line(501, 1, "/Applications/Orca.app/Contents/MacOS/Orca"),
            self.ps_line(502, 501, "/bin/zsh"),
            self.ps_line(live.pid, 502, "node orca orchestration check --run run_x --wait --json"),
        ]) + "\n")
        r = self.wait([self.WAITER_EXISTS], "--kill-stale")
        self.assertEqual(4, r.returncode, r.stderr)
        self.assertIsNone(live.poll())
        self.assertNotIn("를 종료했다", r.stderr)

    def test_output_is_readable_by_triage(self):
        r = self.wait([batch("d1", "heartbeat", "worker_done")])
        out = self.tmp / "out.txt"
        out.write_text(r.stdout + "\n[exited with code 0]\n")
        triage = SCRIPT.with_name("triage-messages.py")
        done = subprocess.run(["python3", str(triage), str(out)], capture_output=True, text=True)
        self.assertEqual(0, done.returncode, done.stderr)
        self.assertIn("worker_done", done.stdout)

    def test_usage_errors(self):
        self.assertEqual(2, subprocess.run(["python3", str(SCRIPT)], capture_output=True, env=self.env).returncode)
        self.assertEqual(2, self.wait([], "--types", "").returncode)

    def test_suspicious_completion_is_not_acked_and_returns_six(self):
        reply = batch("d_child", "worker_done")
        done = self.wait([reply], "--lost-interval-sec", "0", contract="ready", history_fail=True)
        self.assertEqual(done.returncode, 6, done.stdout + done.stderr)
        self.assertIn("의심스러운 worker_done", done.stdout)
        self.assertIn("suspicious_worker_done", done.stdout)
        self.assertEqual(done.stdout.splitlines()[-1], "LAST_DELIVERY d_child")
        self.assertTrue(all("--ack" not in call for call in self.calls()))

    def test_previous_acked_ready_status_is_read_from_history(self):
        ids = {"task_id": "task_a", "dispatch_id": "ctx_a", "from_handle": "term_a"}
        ready = {"type": "status", "subject": "준비됨 #123, head " + "a" * 40,
                 "created_at": "2026-10-23T00:00:00Z", **ids}
        reply = batch("d_done", "worker_done")
        reply["result"]["messages"][0].update(ids, created_at="2026-10-23T00:00:01Z")
        done = self.wait([reply], "--lost-interval-sec", "0", contract="ready", history=[ready])
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('"status": "ready"', done.stdout)
        self.assertTrue(any("--all" in call and "--wait" not in call for call in self.calls()))


if __name__ == "__main__":
    unittest.main()
