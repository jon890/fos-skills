"""ci-ready.py 를 가짜 gh 로 검증한다. GitHub 에는 닿지 않는다."""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ci-ready.py"

FAKE_GH = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    path = os.environ["FAKE_STATE"]
    state = json.load(open(path))
    args = sys.argv[1:]
    open(os.environ["FAKE_LOG"], "a").write(" ".join(args) + "\\n")
    prs = state["prs"]
    if args[:2] == ["pr", "view"]:
        pr = prs[args[2]]
        seq = pr.get("mergeable_seq")
        if seq:
            pr["mergeable"] = seq.pop(0)
            json.dump(state, open(path, "w"))
        print(json.dumps(pr)); sys.exit(0)
    if args[:2] == ["pr", "list"]:
        if state.get("list_fails"):
            sys.exit(1)
        base = args[args.index("--base") + 1]
        print(json.dumps([p for p in prs.values() if p["state"] == "OPEN" and p["baseRefName"] == base]))
        sys.exit(0)
    if args[:2] == ["pr", "ready"]:
        prs[args[2]]["isDraft"] = False
        json.dump(state, open(path, "w"))
        sys.exit(0)
    sys.exit(3)
    """)


class CiReadyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        gh = self.tmp / "gh"
        gh.write_text(FAKE_GH)
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        self.state = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        self.env = dict(os.environ, GH=str(gh), FAKE_STATE=str(self.state), FAKE_LOG=str(self.log),
                        ORCH_READY_RETRY_SECONDS="0")

    def pr(self, number, files, draft=True, **over):
        base = {"number": number, "state": "OPEN", "isDraft": draft, "mergeable": "MERGEABLE",
                "baseRefName": "main", "files": [{"path": f} for f in files]}
        base.update(over)
        return base

    def run_ready(self, prs, *args, **state):
        self.state.write_text(json.dumps({"prs": {str(p["number"]): p for p in prs}, **state}))
        return subprocess.run(["python3", str(SCRIPT), "--repo", str(self.tmp), *args],
                              capture_output=True, text=True, env=self.env)

    def readied(self):
        log = self.log.read_text() if self.log.exists() else ""
        return [line.split()[2] for line in log.splitlines() if line.startswith("pr ready ")]

    def test_draft_without_overlap_is_readied(self):
        r = self.run_ready([self.pr(1, ["a.py"]), self.pr(2, ["b.py"], draft=False)], "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("1 ready 로 바꿈", r.stdout)
        self.assertEqual(["1"], self.readied())

    def test_overlap_with_ready_pr_is_held(self):
        r = self.run_ready([self.pr(1, ["a.py", "c.py"]), self.pr(2, ["a.py"], draft=False)], "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("1 보류: ready PR 과 겹친다 #2(a.py)", r.stdout)
        self.assertEqual([], self.readied())

    def test_overlap_with_draft_or_other_base_does_not_block(self):
        prs = [self.pr(1, ["a.py"]), self.pr(2, ["a.py"]), self.pr(3, ["a.py"], draft=False, baseRefName="develop")]
        r = self.run_ready(prs, "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["1"], self.readied())

    def test_pr_readied_earlier_in_the_same_run_blocks_the_next(self):
        r = self.run_ready([self.pr(1, ["a.py"]), self.pr(2, ["a.py"])], "1", "2")
        self.assertEqual(1, r.returncode)
        self.assertIn("2 보류: ready PR 과 겹친다 #1(a.py)", r.stdout)
        self.assertEqual(["1"], self.readied())

    def test_dry_run_counts_planned_ready_but_calls_nothing(self):
        r = self.run_ready([self.pr(1, ["a.py"]), self.pr(2, ["a.py"])], "--dry-run", "1", "2")
        self.assertEqual(1, r.returncode)
        self.assertIn("1 ready 로 바꿀 것", r.stdout)
        self.assertIn("2 보류", r.stdout)
        self.assertEqual([], self.readied())

    def test_conflict_with_base_is_held(self):
        r = self.run_ready([self.pr(1, ["a.py"], mergeable="CONFLICTING")], "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("base 와 충돌한다", r.stdout)
        self.assertEqual([], self.readied())

    def test_unknown_mergeable_is_retried_then_readied(self):
        r = self.run_ready([self.pr(1, ["a.py"], mergeable="UNKNOWN", mergeable_seq=["UNKNOWN", "MERGEABLE"])], "1")
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertEqual(["1"], self.readied())

    def test_still_unknown_is_held(self):
        r = self.run_ready([self.pr(1, ["a.py"], mergeable="UNKNOWN")], "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("충돌 여부를 아직 모른다", r.stdout)

    def test_already_ready_and_closed(self):
        r = self.run_ready([self.pr(1, ["a.py"], draft=False), self.pr(2, ["b.py"], state="MERGED")], "1", "2")
        self.assertEqual(1, r.returncode)
        self.assertIn("1 이미 ready", r.stdout)
        self.assertIn("2 보류: state=MERGED", r.stdout)
        self.assertEqual([], self.readied())

    def test_file_list_at_limit_is_held(self):
        r = self.run_ready([self.pr(1, [f"f{i}.py" for i in range(100)])], "1")
        self.assertEqual(1, r.returncode)
        self.assertIn("목록이 잘렸을 수 있다", r.stdout)

    def test_lookup_failure_is_exit_2(self):
        r = self.run_ready([self.pr(1, ["a.py"])], "1", list_fails=True)
        self.assertEqual(2, r.returncode)
        self.assertEqual([], self.readied())

    def test_usage_error(self):
        r = self.run_ready([], "abc")
        self.assertEqual(2, r.returncode)


if __name__ == "__main__":
    unittest.main()
