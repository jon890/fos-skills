"""make-worktree.sh 를 실제 git 저장소로 검증한다. 원격은 로컬 bare 저장소다."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "make-worktree.sh"


def sh(*cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class MakeWorktreeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
        self.origin = self.tmp / "repo-origin.git"
        self.repo = self.tmp / "repo"
        self.git("init", "-q", "--bare", "-b", "main", str(self.origin))
        self.git("clone", "-q", str(self.origin), str(self.repo))
        self.git("-C", str(self.repo), "commit", "-q", "--allow-empty", "-m", "init")
        self.git("-C", str(self.repo), "push", "-q", "-u", "origin", "main")
        self.spec = self.tmp / "spec-x.md"
        self.spec.write_text("# 지시서\n\n대상 저장소: `owner/repo`. 브랜치: `feature/x`(최신 origin/main 에서).\n")

    def git(self, *args):
        return subprocess.run(["git", *args], check=True, capture_output=True, text=True, env=self.env).stdout.strip()

    def run_script(self, *args, code=0):
        done = subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env=self.env)
        self.assertEqual(done.returncode, code, done.stdout + done.stderr)
        return done.stdout + done.stderr

    def make(self, *extra, code=0):
        return self.run_script("--repo", str(self.repo), "--spec", str(self.spec), "--name", "x", *extra, code=code)

    def test_worktree_gets_the_spec_branch_on_latest_origin_base(self):
        other = self.tmp / "other"
        self.git("clone", "-q", str(self.origin), str(other))
        self.git("-C", str(other), "commit", "-q", "--allow-empty", "-m", "newer")
        self.git("-C", str(other), "push", "-q", "origin", "main")
        out = self.make("--base", "origin/main")
        wt = self.repo / "worktrees" / "repo" / "x"
        self.assertEqual(out.strip(), str(wt))
        self.assertEqual(self.git("-C", str(wt), "branch", "--show-current"), "feature/x")
        self.assertEqual(self.git("-C", str(wt), "rev-parse", "HEAD"), self.git("-C", str(other), "rev-parse", "HEAD"))
        # push 전에는 upstream 이 없다. 있으면 gone 으로 보여 정리 스크립트가 머지된 것으로 읽는다
        done = subprocess.run(["git", "-C", str(wt), "rev-parse", "@{u}"], capture_output=True, env=self.env)
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(self.git("-C", str(self.repo), "status", "--porcelain"), "")

    def test_local_settings_are_copied(self):
        (self.repo / ".claude").mkdir()
        (self.repo / ".claude" / "settings.local.json").write_text("{}")
        exclude = self.repo / ".git" / "info" / "exclude"
        exclude.write_text(exclude.read_text() + "/.claude/\n")
        self.make()
        self.assertTrue((self.repo / "worktrees" / "repo" / "x" / ".claude" / "settings.local.json").is_file())

    def test_spec_without_branch_line_is_a_usage_error(self):
        self.spec.write_text("# 지시서\n\n브랜치 이름은 아직 없다.\n")
        out = self.make(code=2)
        self.assertIn("브랜치", out)
        self.assertFalse((self.repo / "worktrees").exists())

    def test_existing_remote_branch_is_refused(self):
        self.git("-C", str(self.repo), "push", "-q", "origin", "main:feature/x")
        out = self.make(code=1)
        self.assertIn("origin/feature/x", out)
        self.assertFalse((self.repo / "worktrees" / "repo" / "x").exists())

    def test_existing_local_branch_is_refused(self):
        self.git("-C", str(self.repo), "branch", "feature/x")
        self.make(code=1)

    def test_check_passes_after_push_with_same_name(self):
        self.make()
        wt = self.repo / "worktrees" / "repo" / "x"
        self.git("-C", str(wt), "commit", "-q", "--allow-empty", "-m", "work")
        self.git("-C", str(wt), "push", "-q", "-u", "origin", "HEAD")
        out = self.run_script("--check", str(wt), "--spec", str(self.spec))
        self.assertIn("일치: feature/x", out)

    def test_check_fails_when_pushed_to_another_remote_branch(self):
        self.make()
        wt = self.repo / "worktrees" / "repo" / "x"
        self.git("-C", str(wt), "commit", "-q", "--allow-empty", "-m", "work")
        self.git("-C", str(wt), "push", "-q", "-u", "origin", "HEAD:dev/x")
        out = self.run_script("--check", str(wt), "--spec", str(self.spec), code=1)
        self.assertIn("upstream origin/dev/x", out)

    def test_check_fails_before_push(self):
        self.make()
        wt = self.repo / "worktrees" / "repo" / "x"
        out = self.run_script("--check", str(wt), "--spec", str(self.spec), code=1)
        self.assertIn("(없음)", out)


if __name__ == "__main__":
    unittest.main()
