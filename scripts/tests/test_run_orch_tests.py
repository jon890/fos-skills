"""Verify parallel runner discovery, isolation, reports and failure exit status."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "run-orch-tests.py"


class OrchRunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.report = self.directory / "report.json"

    def run_tests(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), "--start-directory", str(self.directory),
                               "--report", str(self.report), *args], capture_output=True, text=True)

    def test_each_file_runs_in_its_own_process_and_all_timings_are_reported(self):
        for name in ("test_a.py", "test_b.py"):
            (self.directory / name).write_text(
                "import os, unittest\n"
                "class Example(unittest.TestCase):\n"
                "    def test_isolated(self):\n"
                "        self.assertNotIn('ORCH_RUNNER_ISOLATION', os.environ)\n"
                "        os.environ['ORCH_RUNNER_ISOLATION'] = 'yes'\n")
        for jobs in (1, 2):
            with self.subTest(jobs=jobs):
                done = self.run_tests("--jobs", str(jobs))
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                report = json.loads(self.report.read_text())
                self.assertTrue(report["successful"])
                self.assertEqual(2, report["tests_run"])
                self.assertEqual(0, report["skipped"])
                self.assertEqual(2, len(report["files"]))
                self.assertEqual(2, sum(len(row["tests"]) for row in report["files"]))

    def test_failure_keeps_traceback_and_does_not_skip_other_files(self):
        (self.directory / "test_bad.py").write_text(
            "import unittest\nclass Example(unittest.TestCase):\n"
            "    def test_bad(self): self.fail('failure evidence')\n")
        (self.directory / "test_good.py").write_text(
            "import unittest\nclass Example(unittest.TestCase):\n"
            "    def test_good(self): self.assertTrue(True)\n")
        done = self.run_tests("--jobs", "2")
        self.assertEqual(1, done.returncode)
        self.assertIn("failure evidence", done.stderr)
        report = json.loads(self.report.read_text())
        self.assertFalse(report["successful"])
        self.assertEqual(2, report["tests_run"])
        self.assertEqual(2, len(report["files"]))

    def test_import_error_is_reported_as_failure(self):
        (self.directory / "test_broken.py").write_text("raise RuntimeError('import evidence')\n")
        done = self.run_tests()
        self.assertEqual(1, done.returncode)
        self.assertIn("import evidence", done.stderr)
        self.assertFalse(json.loads(self.report.read_text())["successful"])

    def test_empty_directory_and_invalid_jobs_fail(self):
        for args in ((), ("--jobs", "0")):
            with self.subTest(args=args):
                self.assertEqual(2, self.run_tests(*args).returncode)


if __name__ == "__main__":
    unittest.main()
