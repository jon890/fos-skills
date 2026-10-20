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
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        orca = self.tmp / "orca"
        orca.write_text(FAKE_ORCA)
        orca.chmod(orca.stat().st_mode | stat.S_IEXEC)
        self.state = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        self.env = dict(os.environ, ORCA=str(orca), FAKE_STATE=str(self.state), FAKE_LOG=str(self.log))
        # ps 는 FAKE_PS 파일의 내용을 낸다. 파일이 없으면 아무것도 내지 않는다
        ps = self.tmp / "ps"
        ps.write_text('#!/bin/sh\ncat "$FAKE_PS" 2>/dev/null\n')
        ps.chmod(ps.stat().st_mode | stat.S_IEXEC)
        self.ps_rows = self.tmp / "ps.txt"
        self.env.update(PS=str(ps), FAKE_PS=str(self.ps_rows))

    def wait(self, replies, *args):
        self.state.write_text(json.dumps({"replies": replies}))
        return subprocess.run(["python3", str(SCRIPT), "--run", "run_x", *args],
                              capture_output=True, text=True, env=self.env)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def ack_of(self, call):
        return call[call.index("--ack") + 1] if "--ack" in call else None

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
            self.ps_line(401, 1, "node orca orchestration check --run run_x --json"),
        ]) + "\n")
        r = self.wait([self.WAITER_EXISTS, batch("d1", "worker_done")], "--ack", "d0")
        self.assertEqual(4, r.returncode, r.stderr)
        self.assertEqual(1, len(self.calls()), "waiter_exists 를 받고 다시 걸었다")
        self.assertEqual("LAST_DELIVERY d0", r.stdout.splitlines()[-1])
        for pid in ("101", "102", "103", "201"):
            self.assertIn(f"PID {pid}", r.stderr)
        self.assertNotIn("PID 301", r.stderr)
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


if __name__ == "__main__":
    unittest.main()
