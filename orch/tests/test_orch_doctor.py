"""orch-doctor.py 를 임시 설치 캐시와 로컬 git 원본으로 본다."""

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
        self.clone = self.tmp / "plugins" / "marketplaces" / "mkt"
        git("clone", "-q", str(self.origin), str(self.clone))
        git("-C", str(self.clone), "checkout", "-q", "-b", "main")
        write(self.clone / "orch" / "SKILL.md", "# orch\n")
        write(self.clone / "other" / "SKILL.md", "# other\n")
        self.installed = self.commit("처음")
        write(self.tmp / "plugins" / "known_marketplaces.json",
              json.dumps({"mkt": {"installLocation": str(self.clone)}}))
        self.skill = self.tmp / "plugins" / "cache" / "mkt" / "plug" / self.installed[:12] / "orch"
        write(self.skill / "SKILL.md", '```bash\npython3 "$SKILL_DIR/scripts/a.py"\n```\n')
        write(self.skill / "scripts" / "a.py", "")

    def commit(self, message):
        git("-C", str(self.clone), "add", "-A")
        git("-C", str(self.clone), "commit", "-q", "-m", message)
        git("-C", str(self.clone), "push", "-q", "origin", "main")
        return git("-C", str(self.clone), "rev-parse", "HEAD")

    def run_doctor(self, *args, skill=None):
        done = subprocess.run(["python3", str(SCRIPT), "--skill-dir", str(skill or self.skill), *args],
                              capture_output=True, text=True, env=ENV)
        return done.returncode, done.stdout

    def test_same_commit_is_ok(self):
        code, out = self.run_doctor()
        self.assertEqual(0, code, out)
        self.assertIn(f"OK-VERSION {self.installed[:12]}", out)
        self.assertIn("OK-SCRIPTS 1", out)

    def test_changed_skill_is_stale_with_update_commands(self):
        write(self.clone / "orch" / "scripts" / "spec-line.py", "")
        latest = self.commit("orch 변경")
        code, out = self.run_doctor()
        self.assertEqual(1, code, out)
        self.assertIn(f"STALE {self.installed[:12]} {latest[:12]}", out)
        self.assertIn("claude plugin marketplace update mkt", out)
        self.assertIn("claude plugin update plug@mkt", out)

    def test_commit_that_only_touches_other_skills_is_ok(self):
        write(self.clone / "other" / "x.md", "x\n")
        self.commit("다른 스킬만 변경")
        code, out = self.run_doctor()
        self.assertEqual(0, code, out)
        self.assertIn("OK-VERSION", out)

    def test_unknown_commit_in_clone_counts_as_stale(self):
        # clone 이 새 커밋을 아직 받지 않았으면 diff 로 좁히지 못한다
        other = self.tmp / "other-clone"
        git("clone", "-q", str(self.origin), str(other))
        write(other / "other" / "y.md", "y\n")
        git("-C", str(other), "add", "-A")
        git("-C", str(other), "commit", "-q", "-m", "밖에서 변경")
        git("-C", str(other), "push", "-q", "origin", "HEAD:main")
        code, out = self.run_doctor()
        self.assertEqual(1, code, out)
        self.assertIn("STALE", out)

    def test_checkout_is_not_compared(self):
        skill = self.tmp / "checkout" / "orch"
        write(skill / "SKILL.md", "# orch\n")
        code, out = self.run_doctor(skill=skill)
        self.assertEqual(0, code, out)
        self.assertIn("SKIP-VERSION", out)

    def test_missing_scripts_are_reported_with_line(self):
        write(self.skill / "references" / "x.md",
              "본문\n[링크](../scripts/gone.sh)\n`$SKILL_DIR/scripts/a.py`\n`scripts/verify.sh` 는 저장소 예시다\n")
        code, out = self.run_doctor("--skip-version")
        self.assertEqual(1, code, out)
        self.assertIn("MISSING references/x.md:2 scripts/gone.sh", out)
        self.assertNotIn("verify.sh", out)
        self.assertNotIn("VERSION", out)

    def test_unreadable_origin_exits_2(self):
        code, _ = self.run_doctor("--remote", str(self.tmp / "nowhere.git"))
        self.assertEqual(2, code)


if __name__ == "__main__":
    unittest.main()
