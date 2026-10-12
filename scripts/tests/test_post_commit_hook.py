#!/usr/bin/env python3
"""hooks/post-commit 의 출력 범위 검사.

커밋 훅이 팀 저장소와의 어긋남을 전부 내면 이번 변경이 가려진다.
이번 커밋이 건드린 스킬의 어긋남만 자세히 내고 나머지는 개수로만 낸다.
내보내기 스크립트는 어긋남 줄을 고정 출력하는 가짜로 바꿔 훅의 분류만 본다.
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[2] / "hooks" / "post-commit"

FAKE_SYNC = """#!/usr/bin/env bash
echo "원본: HEAD (abc)"
echo "팀 저장소의 사본이 원본과 어긋난다:"
echo "  다름   skills/alpha/SKILL.md"
echo "  없음   skills/beta/scripts/x.py"
echo "  다름   skills/beta/SKILL.md"
echo "  다름   tools/browser-driver/README.md"
echo
echo "팀 저장소: /nowhere"
exit 1
"""

SYNC_HEADER = "SHARED_SKILLS=(alpha beta)\n"


class PostCommitHookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / "scripts").mkdir()
        sync = self.repo / "scripts" / "export-to-team.sh"
        sync.write_text(SYNC_HEADER + FAKE_SYNC, encoding="utf-8")
        sync.chmod(0o755)
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init", "--no-verify")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, capture_output=True, text=True, check=True)

    def commit_touching(self, *dirs):
        for d in dirs:
            (self.repo / d).mkdir(exist_ok=True)
            (self.repo / d / "f.txt").write_text(d, encoding="utf-8")
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c", "--no-verify")

    def run_hook(self):
        return subprocess.run(
            ["bash", str(HOOK)], cwd=self.repo, capture_output=True, text=True,
            env={**os.environ, "PATH": os.environ["PATH"]},
        )

    def test_only_touched_skill_is_listed_in_detail(self):
        self.commit_touching("alpha")
        out = self.run_hook().stdout
        self.assertIn("skills/alpha/SKILL.md", out)
        self.assertNotIn("skills/beta/", out)
        self.assertNotIn("browser-driver", out)

    def test_other_skills_are_counted_in_one_line(self):
        self.commit_touching("alpha")
        out = self.run_hook().stdout
        self.assertIn("다른 스킬의 어긋난 파일 3개", out)

    def test_two_touched_skills_are_both_listed(self):
        self.commit_touching("alpha", "beta")
        out = self.run_hook().stdout
        self.assertIn("skills/alpha/SKILL.md", out)
        self.assertIn("skills/beta/scripts/x.py", out)
        self.assertIn("다른 스킬의 어긋난 파일 1개", out)

    def test_untouched_shared_skills_stay_silent_when_commit_misses_them(self):
        self.commit_touching("unrelated")
        self.assertEqual(self.run_hook().stdout, "")

    def test_touched_skill_without_drift_only_reports_count(self):
        (self.repo / "scripts" / "export-to-team.sh").write_text(
            SYNC_HEADER + FAKE_SYNC.replace("skills/alpha/", "skills/gamma/"), encoding="utf-8"
        )
        self.commit_touching("alpha")
        out = self.run_hook().stdout
        self.assertIn("팀 저장소와 같다", out)
        self.assertNotIn("skills/alpha/", out)
        self.assertIn("다른 스킬의 어긋난 파일 4개", out)


if __name__ == "__main__":
    unittest.main()
