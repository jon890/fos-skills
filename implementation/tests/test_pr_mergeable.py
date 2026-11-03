"""pr_mergeable.sh 를 가짜 gh 로 검증한다. GitHub 에는 닿지 않는다."""

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pr_mergeable.sh"


class PrMergeableTest(unittest.TestCase):
    def setUp(self):
        self.bin = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.bin)

    def run_with(self, answers, *args, rc=0):
        """answers 를 호출 순서대로 내는 가짜 gh 로 돌린다. 마지막 값은 반복한다."""
        state = self.bin / "n"
        state.write_text("0")
        lines = "\n".join(f'  {i}) echo "{a}" ;;' for i, a in enumerate(answers))
        gh = self.bin / "gh"
        gh.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            [ {rc} -ne 0 ] && exit {rc}
            n=$(cat "{state}"); echo $((n + 1)) > "{state}"
            [ "$n" -ge {len(answers)} ] && n={len(answers) - 1}
            case "$n" in
            """) + lines + "\nesac\n")
        gh.chmod(0o755)
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}")
        done = subprocess.run([str(SCRIPT), "12", "--interval", "0", *args],
                              capture_output=True, text=True, env=env)
        return done.returncode, done.stdout.strip(), int(state.read_text())

    def test_mergeable(self):
        code, out, calls = self.run_with(["mergeable=MERGEABLE mergeStateStatus=CLEAN"])
        self.assertEqual((code, calls), (0, 1))
        self.assertIn("MERGEABLE", out)

    def test_blocked_by_protection_is_not_conflict(self):
        code, _, _ = self.run_with(["mergeable=MERGEABLE mergeStateStatus=BLOCKED"])
        self.assertEqual(code, 0)

    def test_conflict(self):
        code, _, _ = self.run_with(["mergeable=CONFLICTING mergeStateStatus=DIRTY"])
        self.assertEqual(code, 1)

    def test_unknown_then_conflict_retries(self):
        code, _, calls = self.run_with(["mergeable=UNKNOWN mergeStateStatus=UNKNOWN",
                                        "mergeable=CONFLICTING mergeStateStatus=DIRTY"])
        self.assertEqual((code, calls), (1, 2))

    def test_unknown_until_tries_run_out(self):
        code, _, calls = self.run_with(["mergeable=UNKNOWN mergeStateStatus=UNKNOWN"], "--tries", "3")
        self.assertEqual((code, calls), (2, 3))

    def test_gh_failure(self):
        code, _, _ = self.run_with(["x"], rc=1)
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
