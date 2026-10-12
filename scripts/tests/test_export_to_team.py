"""scripts/export-to-team.sh 의 인자 처리와 원본 커밋 지정을 검증한다. 팀 저장소는 빈 임시 디렉터리로 대신한다."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "export-to-team.sh"


def run_script(*args, team_dir):
    env = dict(os.environ, TEAM_SKILLS_DIR=str(team_dir))
    return subprocess.run(
        ["/bin/bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
    )


def head_sha():
    return subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


class ExportToTeamScriptTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.team = Path(self._tmp.name)
        (self.team / "skills").mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_unknown_argument_exits_2(self):
        result = run_script("--nope", team_dir=self.team)
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("알 수 없는 인자: --nope", result.stderr)

    def test_source_ref_without_value_exits_2(self):
        result = run_script("--source-ref", team_dir=self.team)
        self.assertEqual(2, result.returncode, result.stderr)

    def test_unknown_source_ref_exits_2(self):
        result = run_script("--source-ref", "no-such-ref-xyz", team_dir=self.team)
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("커밋을 찾지 못했다: no-such-ref-xyz", result.stderr)

    def test_source_ref_reports_sha_and_reads_commit(self):
        result = run_script("--source-ref", "HEAD", team_dir=self.team)
        # 팀 저장소가 비어 있으므로 모든 파일이 「없음」 으로 어긋난다.
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn(f"원본: HEAD ({head_sha()})", result.stdout)
        self.assertIn("없음   skills/korean-check/SKILL.md", result.stdout)

    def test_working_tree_reports_head_sha(self):
        result = run_script(team_dir=self.team)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn(f"원본: 작업 트리 (HEAD {head_sha()}", result.stdout)

    def test_apply_with_source_ref_writes_committed_content(self):
        result = run_script("--source-ref", "HEAD", "--apply", team_dir=self.team)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        committed = subprocess.run(
            ["git", "-C", str(REPO), "show", "HEAD:review-fix/CHANGELOG.md"],
            capture_output=True, check=True,
        ).stdout
        self.assertEqual(committed, (self.team / "skills/review-fix/CHANGELOG.md").read_bytes())


if __name__ == "__main__":
    unittest.main()
