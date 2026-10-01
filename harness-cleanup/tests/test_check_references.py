"""check_references.py 가 플러그인 스킬 이름을 배치와 무관하게 찾는지 검증한다.

스크립트는 import 할 때 sys.argv 를 읽으므로 하위 프로세스로 부른다.
HOME 을 임시 디렉터리로 바꾸므로 인터프리터는 sys.executable 로 준다.
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_references.py"


class CheckReferencesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.home, self.repo = root / "home", root / "repo"
        self.home.mkdir()
        self.repo.mkdir()

    def write_claude_md(self, skill):
        (self.repo / "CLAUDE.md").write_text(f"# 지침\n\n`{skill}` 스킬을 쓴다.\n")

    def make_skill(self, relative):
        skill_file = self.home / ".claude/plugins" / relative / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text("---\nname: x\n---\n")

    def run_check(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.repo)],
            env={**os.environ, "HOME": str(self.home)},
            capture_output=True,
            text=True,
        )

    def test_finds_skill_of_plugin_laid_out_at_root(self):
        self.make_skill("cache/fos-skills/fos-skills/0123456789ab/planning")
        self.write_claude_md("planning")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("깨진 참조 0건", result.stdout)

    def test_finds_skill_of_plugin_laid_out_under_skills_dir(self):
        self.make_skill("cache/m/p/1.0.0/skills/brain-add")
        self.write_claude_md("brain-add")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_reports_missing_skill(self):
        (self.home / ".claude/plugins").mkdir(parents=True)
        self.write_claude_md("no-such-skill")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("[스킬] no-such-skill", result.stdout)


if __name__ == "__main__":
    unittest.main()
