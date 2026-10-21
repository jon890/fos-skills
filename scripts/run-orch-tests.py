#!/usr/bin/env python3
"""Run orch unittest files in isolated processes and report elapsed times."""

import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TimedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.timings = []

    def startTest(self, test):
        self.started = time.monotonic()
        super().startTest(test)

    def stopTest(self, test):
        self.timings.append({"test": test.id(), "seconds": time.monotonic() - self.started})
        super().stopTest(test)


def worker(directory, filename, report):
    suite = unittest.defaultTestLoader.discover(str(directory), pattern=filename)
    result = unittest.TextTestRunner(verbosity=1, resultclass=TimedResult).run(suite)
    Path(report).write_text(json.dumps({
        "tests_run": result.testsRun, "skipped": len(result.skipped),
        "successful": result.wasSuccessful(), "tests": result.timings,
    }))
    return 0 if result.wasSuccessful() else 1


def run_file(directory, filename, report):
    started = time.monotonic()
    done = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                           "--start-directory", str(directory), "--worker", filename,
                           "--report", str(report)], capture_output=True, text=True)
    result = json.loads(report.read_text()) if report.exists() else {
        "tests_run": 0, "skipped": 0, "successful": False, "tests": [],
    }
    result.update(file=filename, seconds=time.monotonic() - started,
                  successful=result["successful"] and done.returncode == 0)
    return result, done.stdout + done.stderr


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--report", type=Path, help="Write full timings as JSON")
    parser.add_argument("--start-directory", type=Path, default=ROOT / "orch" / "tests")
    parser.add_argument("--worker", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    directory = args.start_directory.resolve()
    if args.worker:
        return worker(directory, args.worker, args.report)
    files = sorted(directory.glob("test*.py"))
    if not files:
        parser.error(f"No test files in {directory}")
    started = time.monotonic()
    results = []
    with tempfile.TemporaryDirectory(prefix="orch-tests-") as tmp:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futures = {pool.submit(run_file, directory, file.name,
                                   Path(tmp) / f"{file.stem}.json"): file for file in files}
            for future in concurrent.futures.as_completed(futures):
                result, output = future.result()
                results.append(result)
                print(f"{result['file']}: {result['seconds']:.3f}s "
                      f"({result['tests_run']} tests)", flush=True)
                if not result["successful"]:
                    print(output, file=sys.stderr, flush=True)
    report = {"seconds": time.monotonic() - started, "jobs": args.jobs,
              "tests_run": sum(row["tests_run"] for row in results),
              "skipped": sum(row["skipped"] for row in results),
              "successful": all(row["successful"] for row in results),
              "files": sorted(results, key=lambda row: row["file"])}
    print(f"Total: {report['seconds']:.3f}s, {report['tests_run']} tests, "
          f"{report['skipped']} skipped, successful={report['successful']}")
    print("Slowest 10 tests:")
    for row in sorted((test for file in results for test in file["tests"]),
                      key=lambda row: row["seconds"], reverse=True)[:10]:
        print(f"  {row['seconds']:.3f}s {row['test']}")
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["successful"] else 1


if __name__ == "__main__":
    sys.exit(main())
