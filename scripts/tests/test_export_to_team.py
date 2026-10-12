"""scripts/export-to-team.sh 의 인자 처리와 원본 커밋 지정을 검증한다.

스크립트는 자기 위치의 상위 디렉터리를 원본 저장소로 쓴다.
그래서 임시 git 저장소에 스크립트를 복사하고, 내보내는 스킬과 도구마다 파일 하나를 커밋해 원본을 만든다.
팀 저장소는 빈 임시 디렉터리로 대신한다.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "export-to-team.sh"


def shared_names(var):
    """스크립트의 SHARED_SKILLS, SHARED_TOOLS 배열을 읽는다. 목록을 테스트에 다시 적지 않는다."""
    m = re.search(rf"^{var}=\(([^)]*)\)$", SCRIPT.read_text(encoding="utf-8"), re.M)
    return m.group(1).split()


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True,
    ).stdout.strip()


class ExportToTeamScriptTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.repo = root / "source"
        self.team = root / "team"
        (self.team / "skills").mkdir(parents=True)

        (self.repo / "scripts").mkdir(parents=True)
        shutil.copy2(SCRIPT, self.repo / "scripts" / "export-to-team.sh")
        self.skill = shared_names("SHARED_SKILLS")[0]
        dirs = shared_names("SHARED_SKILLS") + [f"tools/{t}" for t in shared_names("SHARED_TOOLS")]
        for d in dirs:
            (self.repo / d).mkdir(parents=True)
            (self.repo / d / "NOTE.md").write_text("committed\n", encoding="utf-8")
        git(self.repo, "init", "-q")
        git(self.repo, "add", ".")
        git(self.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
        self.sha = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        self._tmp.cleanup()

    def run_script(self, *args):
        env = dict(os.environ, TEAM_SKILLS_DIR=str(self.team))
        return subprocess.run(
            ["/bin/bash", str(self.repo / "scripts" / "export-to-team.sh"), *args],
            capture_output=True, text=True, env=env,
        )

    def edit_working_tree(self):
        (self.repo / self.skill / "NOTE.md").write_text("uncommitted\n", encoding="utf-8")

    def test_unknown_argument_exits_2(self):
        result = self.run_script("--nope")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("알 수 없는 인자: --nope", result.stderr)

    def test_source_ref_without_value_exits_2(self):
        for args in (["--source-ref"], ["--source-ref", "--apply"]):
            result = self.run_script(*args)
            self.assertEqual(2, result.returncode, args)
            self.assertIn("--source-ref 뒤에 커밋이나 브랜치를 준다", result.stderr)

    def test_unknown_source_ref_exits_2(self):
        result = self.run_script("--source-ref", "no-such-ref-xyz")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("커밋을 찾지 못했다: no-such-ref-xyz", result.stderr)

    def test_source_ref_reports_sha(self):
        result = self.run_script("--source-ref", "HEAD")
        # 팀 저장소가 비어 있으므로 모든 파일이 「없음」 으로 어긋난다.
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn(f"원본: HEAD ({self.sha})", result.stdout)
        self.assertIn(f"없음   skills/{self.skill}/NOTE.md", result.stdout)

    def test_working_tree_reports_uncommitted_change(self):
        self.edit_working_tree()
        result = self.run_script()
        self.assertIn(f"원본: 작업 트리 (HEAD {self.sha}), 커밋하지 않은 변경 있음", result.stdout)

    def test_source_ref_ignores_working_tree(self):
        self.edit_working_tree()
        result = self.run_script("--source-ref", "HEAD", "--apply")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual("committed\n", (self.team / "skills" / self.skill / "NOTE.md").read_text())

        # 같은 상태에서 작업 트리를 원본으로 보면 어긋난다.
        result = self.run_script()
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn(f"다름   skills/{self.skill}/NOTE.md", result.stdout)


if __name__ == "__main__":
    unittest.main()
