"""orch-doctor.py 를 임시 설치 캐시와 로컬 git 원본으로 본다.

마켓플레이스 clone 은 실제처럼 커밋 하나뿐인 shallow clone 으로 만든다.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "orch-doctor.py"
ENV = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
           GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True, env=ENV).stdout.strip()


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class OrchDoctorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.origin = self.tmp / "origin.git"
        git("init", "-q", "--bare", "-b", "main", str(self.origin))
        self.dev = self.tmp / "dev"
        git("init", "-q", "-b", "main", str(self.dev))
        git("-C", str(self.dev), "remote", "add", "origin", str(self.origin))
        write(self.dev / ".gitignore", "__pycache__/\n")
        write(self.dev / "orch" / "SKILL.md", '```bash\npython3 "$SKILL_DIR/scripts/a.py"\n```\n')
        write(self.dev / "orch" / "scripts" / "a.py", "")
        write(self.dev / "other" / "SKILL.md", "# other\n")
        self.installed = self.commit("처음")
        self.clone = self.tmp / "plugins" / "marketplaces" / "mkt"
        git("clone", "-q", "--depth", "1", f"file://{self.origin}", str(self.clone))
        write(self.tmp / "plugins" / "known_marketplaces.json",
              json.dumps({"mkt": {"installLocation": str(self.clone)}}))
        # 설치 캐시는 설치한 커밋의 복사본이다. 실행하면서 생긴 __pycache__ 가 섞여도 같은 내용으로 본다
        self.skill = self.tmp / "plugins" / "cache" / "mkt" / "plug" / self.installed[:12] / "orch"
        shutil.copytree(self.dev / "orch", self.skill)
        write(self.skill / "scripts" / "__pycache__" / "a.cpython-313.pyc", "x")

    def commit(self, message):
        git("-C", str(self.dev), "add", "-A")
        git("-C", str(self.dev), "commit", "-q", "-m", message)
        git("-C", str(self.dev), "push", "-q", "origin", "main")
        return git("-C", str(self.dev), "rev-parse", "HEAD")

    def update_marketplace(self):
        git("-C", str(self.clone), "fetch", "-q", "--depth", "1", "origin", "main")
        git("-C", str(self.clone), "reset", "-q", "--hard", "FETCH_HEAD")

    def run_doctor(self, *args, skill=None):
        done = subprocess.run(["python3", str(SCRIPT), "--skill-dir", str(skill or self.skill), *args],
                              capture_output=True, text=True, env=ENV)
        return done.returncode, done.stdout

    def test_marketplace_clone_is_shallow_like_the_real_one(self):
        self.assertEqual("true", git("-C", str(self.clone), "rev-parse", "--is-shallow-repository"))

    def test_same_commit_is_ok(self):
        code, out = self.run_doctor()
        self.assertEqual(0, code, out)
        self.assertIn(f"OK-VERSION {self.installed[:12]}", out)
        self.assertIn("OK-SCRIPTS 1", out)

    def test_changed_skill_is_stale_with_update_commands(self):
        write(self.dev / "orch" / "scripts" / "spec-line.py", "")
        latest = self.commit("orch 변경")
        self.update_marketplace()
        code, out = self.run_doctor()
        self.assertEqual(1, code, out)
        self.assertIn(f"STALE {self.installed[:12]} {latest[:12]}", out)
        self.assertIn("claude plugin marketplace update mkt", out)
        self.assertIn("claude plugin update plug@mkt", out)

    def test_commit_that_only_touches_other_skills_is_ok(self):
        write(self.dev / "other" / "x.md", "x\n")
        self.commit("다른 스킬만 변경")
        self.update_marketplace()
        code, out = self.run_doctor()
        self.assertEqual(0, code, out)
        self.assertIn("OK-VERSION", out)

    def test_marketplace_not_updated_yet_counts_as_stale(self):
        # clone 에 원본 커밋이 없으면 tree 를 비교하지 못한다
        write(self.dev / "other" / "y.md", "y\n")
        self.commit("밖에서 변경")
        code, out = self.run_doctor()
        self.assertEqual(1, code, out)
        self.assertIn("STALE", out)

    def test_checkout_is_not_compared(self):
        code, out = self.run_doctor(skill=self.dev / "orch")
        self.assertEqual(0, code, out)
        self.assertIn("SKIP-VERSION", out)

    def test_missing_scripts_are_reported_with_line(self):
        write(self.skill / "references" / "x.md",
              "본문\n[링크](../scripts/gone.sh)\n`$SKILL_DIR/scripts/a.py`\n`scripts/verify.sh` 는 저장소 예시다\n"
              '`python3 "$PLANNING_SKILL_DIR/scripts/verify_task.py"`\n')
        code, out = self.run_doctor("--skip-version")
        self.assertEqual(1, code, out)
        self.assertIn("MISSING references/x.md:2 scripts/gone.sh", out)
        self.assertIn("MISSING references/x.md:5 planning/scripts/verify_task.py", out)
        self.assertNotIn("verify.sh", out)
        self.assertNotIn("VERSION", out)
        write(self.skill.parent / "planning" / "scripts" / "verify_task.py", "")
        self.assertNotIn("planning", self.run_doctor("--skip-version")[1])

    def test_unreadable_origin_skips_version_without_failing(self):
        code, out = self.run_doctor("--remote", str(self.tmp / "nowhere.git"))
        self.assertEqual(0, code, out)
        self.assertIn("SKIP-VERSION", out)


if __name__ == "__main__":
    unittest.main()
