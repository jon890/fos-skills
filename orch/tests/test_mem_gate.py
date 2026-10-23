"""mem-gate.py 를 가짜 memory_pressure, sysctl, sleep 으로 본다."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "mem-gate.py"


class MemGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.state = self.tmp / "free"
        # free 값을 한 줄씩 꺼내 쓴다. 마지막 줄은 계속 쓴다
        self.tool("memory_pressure",
                  f'v=$(head -1 "{self.state}"); [ "$(wc -l < "{self.state}")" -gt 1 ] && sed -i.bak 1d "{self.state}"\n'
                  'echo "System-wide memory free percentage: ${v}%"')
        self.tool("sleep", f'echo slept >> "{self.tmp}/sleeps"')

    def tool(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)

    def run_gate(self, frees, swap_mb, *args, **env):
        self.state.write_text("\n".join(str(f) for f in frees) + "\n")
        self.tool("sysctl", f'echo "total = 20480.00M  used = {swap_mb}.25M  free = 100.00M  (encrypted)"')
        full = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", POLL="1", **env)
        done = subprocess.run(["python3", str(SCRIPT), *args], capture_output=True, text=True, env=full)
        sleeps = (self.tmp / "sleeps").read_text().count("slept") if (self.tmp / "sleeps").exists() else 0
        return done.returncode, done.stdout, done.stderr, sleeps

    def test_easy_free_passes_even_with_large_swap(self):
        code, _, err, sleeps = self.run_gate([40], 30000)
        self.assertEqual((0, 0), (code, sleeps))
        self.assertIn("mem-gate: ok free=40% swap=30000MB", err)

    def test_waits_until_free_and_swap_are_within_limits(self):
        code, _, err, sleeps = self.run_gate([20, 30, 36], 5000)
        self.assertEqual((0, 2), (code, sleeps))
        self.assertEqual(2, err.count("mem-gate: waiting"))

    def test_large_swap_below_easy_free_times_out_without_running_command(self):
        marker = self.tmp / "ran"
        code, _, err, _ = self.run_gate([36], 20000, "--", "touch", str(marker), MAX_WAIT="2")
        self.assertEqual(1, code)
        self.assertIn("mem-gate: timeout", err)
        self.assertFalse(marker.exists())

    def test_command_runs_after_gate_and_keeps_its_exit_code(self):
        code, out, _, _ = self.run_gate([50], 0, "--", "sh", "-c", "echo hi; exit 7")
        self.assertEqual((7, "hi\n"), (code, out))

    def test_missing_probe_output_refuses_command(self):
        self.tool("memory_pressure", "exit 1")
        self.tool("sysctl", "echo invalid")
        marker = self.tmp / "ran"
        result = subprocess.run(["python3", str(SCRIPT), "--", "touch", str(marker)],
                                env=dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}"),
                                text=True, capture_output=True)
        self.assertEqual(1, result.returncode)
        self.assertIn("memory probe failed", result.stderr)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
