"""survey_gradle.sh 의 삭제 후보 절을 임시 HOME 으로 검증한다. 실제 ~/.gradle 과 프로세스를 읽지 않는다."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "survey_gradle.sh"


def make_dirs(home, *rels):
    for rel in rels:
        (Path(home) / ".gradle" / rel).mkdir(parents=True)
        (Path(home) / ".gradle" / rel / "f").write_text("x" * 100)


class SurveyGradleTest(unittest.TestCase):
    def run_script(self, home, root, daemon_versions=()):
        # pgrep 을 가짜로 바꿔 실제 데몬이 결과에 섞이지 않게 한다.
        stub = Path(home) / "stub"
        stub.mkdir()
        lines = "".join(f"1 java -cp /x/gradle-{v}/lib/gradle-launcher.jar GradleDaemon\n" for v in daemon_versions)
        pgrep = stub / "pgrep"
        pgrep.write_text(f"#!/bin/sh\nprintf '%s' '{lines}'\n")
        pgrep.chmod(0o755)
        env = {**os.environ, "HOME": home, "PATH": f"{stub}:{os.environ['PATH']}"}
        done = subprocess.run(["bash", str(SCRIPT), root], env=env, capture_output=True, text=True, check=True)
        return done.stdout

    def candidates(self, out):
        part = out.split("## 삭제 후보")[1]
        return part

    def test_candidate_paths_and_rm_line(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as root:
            make_dirs(home, "wrapper/dists/gradle-9.8.0-bin/h1", "caches/9.8.0", "daemon/9.8.0")
            part = self.candidates(self.run_script(home, root))
            for rel in ("wrapper/dists/gradle-9.8.0-bin", "caches/9.8.0", "daemon/9.8.0"):
                self.assertRegex(part, rf"(?m)^9\.8\.0\s+\S+\s+~/\.gradle/{rel}$")
            self.assertIn(
                "rm -rf ~/.gradle/wrapper/dists/gradle-9.8.0-bin ~/.gradle/caches/9.8.0 ~/.gradle/daemon/9.8.0", part)

    def test_missing_paths_are_not_listed(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as root:
            make_dirs(home, "caches/9.8.0")
            part = self.candidates(self.run_script(home, root))
            self.assertIn("rm -rf ~/.gradle/caches/9.8.0\n", part)
            self.assertNotIn("dists", part.split("rm -rf")[1])

    def test_used_and_running_versions_are_excluded(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as root:
            make_dirs(home, "caches/8.1.0", "caches/8.2.0", "caches/8.3.0")
            props = Path(root) / "proj" / "gradle" / "wrapper"
            props.mkdir(parents=True)
            (props / "gradle-wrapper.properties").write_text("distributionUrl=https://x/gradle-8.1.0-bin.zip\n")
            part = self.candidates(self.run_script(home, root, daemon_versions=["8.2.0"]))
            self.assertNotIn("8.1.0", part)
            self.assertNotIn("8.2.0", part)
            self.assertIn("rm -rf ~/.gradle/caches/8.3.0\n", part)

    def test_no_candidates(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as root:
            part = self.candidates(self.run_script(home, root))
            self.assertIn("없음", part)
            self.assertNotIn("rm -rf", part)


if __name__ == "__main__":
    unittest.main()
