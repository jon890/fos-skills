"""스킬 문서가 `$SKILL_DIR/scripts/<이름>` 과 상대 링크로 부르는 스크립트가 모두 있는지 검증한다.

문서만 고치고 스크립트를 빠뜨리거나 이름을 바꾸면, 설치한 쪽은 그 단계에서 「파일이 없다」 로 멈춘다.
판정은 `orch/scripts/orch-doctor.py --skip-version` 이 소유한다. 이 테스트는 스킬마다 그것을 부른다.
"""

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCTOR = ROOT / "orch" / "scripts" / "orch-doctor.py"


class DocScriptRefsTest(unittest.TestCase):
    def test_every_skill_has_the_scripts_its_docs_call(self):
        skills = sorted(p.parent for p in ROOT.glob("*/SKILL.md"))
        self.assertTrue(skills)
        for skill in skills:
            with self.subTest(skill=skill.name):
                done = subprocess.run(
                    [sys.executable, str(DOCTOR), "--skip-version", "--skill-dir", str(skill)],
                    capture_output=True, text=True,
                )
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main()
