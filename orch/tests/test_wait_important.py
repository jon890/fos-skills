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
        err = {"ok": False, "error": {"code": "waiter_exists"}}
        r = self.wait([batch("d1", "heartbeat"), err])
        self.assertEqual(1, r.returncode)
        self.assertIn("waiter_exists", r.stdout)
        self.assertEqual("LAST_DELIVERY d1", r.stdout.splitlines()[-1])

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
