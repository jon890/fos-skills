#!/usr/bin/env python3
"""scripts/run-node-tests.ts 의 세션 분리, 결과 파일, 끝 줄 대기를 검사한다.

한 줄 `node --test` 는 자기 프로세스 그룹에 신호를 보내는 테스트가 실행기까지 끝내 끝 줄 없이 멈췄다.
그런 테스트가 섞여도 나머지가 돌고 끝 줄이 남는지 임시 폴더의 테스트 파일로 본다.
"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

RUNNER = Path(__file__).resolve().parents[2] / "scripts" / "run-node-tests.ts"
NODE = shutil.which("node")

PASS = "import test from 'node:test';\ntest('ok', () => {});\n"
FAIL = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('no', () => { assert.equal(1, 2); });\n"
# 자기 프로세스 그룹 전체에 신호를 보낸다. 한 줄 `node --test` 였다면 실행기도 함께 끝난다.
KILLER = "import test from 'node:test';\ntest('kill group', () => { process.kill(0, 'SIGTERM'); });\n"
SLOW = "import test from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 4000)); });\n"


@unittest.skipUnless(NODE, "node 가 없다")
class RunNodeTestsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.out = self.root / "out"
        (self.root / "t").mkdir()

    def spec(self, name, body):
        (self.root / "t" / name).write_text(body, encoding="utf-8")

    def run_runner(self, *args, timeout=120):
        return subprocess.run([NODE, str(RUNNER), *args], cwd=self.root, capture_output=True, text=True, timeout=timeout)

    def summary(self):
        return (self.out / "summary.txt").read_text(encoding="utf-8").splitlines()

    def test_group_signal_from_one_file_does_not_stop_the_rest(self):
        self.spec("a.spec.mjs", PASS)
        self.spec("b.spec.mjs", KILLER)
        self.spec("c.spec.mjs", FAIL)
        self.spec("d.spec.mjs", PASS)
        done = self.run_runner("--out", str(self.out), "--concurrency", "2", "t/*.spec.mjs")
        self.assertEqual(1, done.returncode, done.stdout + done.stderr)
        lines = self.summary()
        self.assertEqual("결과: 통과 2, 실패 2, 전체 4", lines[-1])
        self.assertTrue(any(line.startswith("실패 t/b.spec.mjs") for line in lines), lines)
        self.assertTrue(any(line.startswith("실패 t/c.spec.mjs") and "로그: " in line for line in lines), lines)
        self.assertTrue(any(line.startswith("통과 t/d.spec.mjs") for line in lines), lines)

    def test_all_passing_exits_zero(self):
        self.spec("a.spec.mjs", PASS)
        done = self.run_runner("--out", str(self.out), "t/a.spec.mjs")
        self.assertEqual(0, done.returncode, done.stdout + done.stderr)
        self.assertEqual("결과: 통과 1, 실패 0, 전체 1", self.summary()[-1])

    def test_per_file_timeout_kills_the_session_and_fails(self):
        self.spec("slow.spec.mjs", SLOW)
        done = self.run_runner("--out", str(self.out), "--timeout", "1", "t/slow.spec.mjs")
        self.assertEqual(1, done.returncode)
        self.assertIn("시간 초과 1초", self.summary()[0])

    def test_background_then_wait_reads_the_end_line(self):
        self.spec("a.spec.mjs", PASS)
        self.spec("slow.spec.mjs", SLOW)
        started = self.run_runner("--background", "--out", str(self.out), "t/*.spec.mjs")
        self.assertEqual(0, started.returncode, started.stderr)
        self.assertIn(f'--wait "{self.out}"', started.stdout)
        early = self.run_runner("--wait", str(self.out), "--max-wait", "1")
        self.assertEqual(3, early.returncode, early.stdout + early.stderr)
        self.assertIn("같은 명령으로 다시 기다린다", early.stdout)
        done = self.run_runner("--wait", str(self.out), "--max-wait", "60")
        self.assertEqual(0, done.returncode, done.stdout + done.stderr)
        self.assertIn("결과: 통과 2, 실패 0, 전체 2", done.stdout)

    def test_wait_reports_a_runner_that_died_without_the_end_line(self):
        self.out.mkdir()
        (self.out / "summary.txt").write_text("통과 t/a.spec.mjs 0.1s\n", encoding="utf-8")
        dead = subprocess.Popen(["true"])
        dead.wait()
        (self.out / "runner.pid").write_text(str(dead.pid), encoding="utf-8")
        done = self.run_runner("--wait", str(self.out), "--max-wait", "5")
        self.assertEqual(2, done.returncode, done.stdout + done.stderr)
        self.assertIn("끝 줄 없이 멈췄다", done.stderr)

    def test_usage_errors(self):
        self.assertEqual(2, self.run_runner("--out", str(self.out), "t/none.spec.mjs").returncode)
        self.assertEqual(2, self.run_runner("--concurrency", "0").returncode)
        self.assertEqual(2, self.run_runner("--wait", str(self.root / "missing")).returncode)


if __name__ == "__main__":
    unittest.main()
