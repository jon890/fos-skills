"""cleanup-sweep.py 를 실제 git 저장소와 가짜 gh, orca, lsof 로 검증한다. GitHub 와 Orca 에는 닿지 않는다."""

import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "cleanup-sweep.py"


def sh(*cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class CleanupSweepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
        os.environ.update({k: self.env[k] for k in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
                                                      "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
                                                      "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL")})
        self.origin = self.tmp / "origin.git"
        self.repo = self.tmp / "repo"
        sh("git", "init", "-q", "--bare", "-b", "main", str(self.origin))
        sh("git", "clone", "-q", str(self.origin), str(self.repo))
        sh("git", "-C", str(self.repo), "commit", "-q", "--allow-empty", "-m", "init")
        sh("git", "-C", str(self.repo), "push", "-q", "-u", "origin", "main")
        self.wts = self.tmp / "wts"
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.prs, self.workers, self.terminals, self.held = {}, [], [], []
        self.orca_fail = False
        self.log = self.tmp / "calls.log"
        self.write_fakes()

    def write_fakes(self):
        state = self.tmp / "state.json"
        fake = textwrap.dedent(f"""\
            #!/usr/bin/env python3
            import json, sys
            st = json.load(open("{state}"))
            a = sys.argv[1:]
            open("{self.log}", "a").write(" ".join(["%s"] + a) + "\\n")
            """)
        gh = fake % "gh" + textwrap.dedent("""\
            if a[:2] == ["pr", "list"] and "--head" in a:
                b = a[a.index("--head") + 1]
                p = st["prs"].get(b)
                print(json.dumps([{"number": 1, "state": p[0], "headRefOid": p[1]}] if p else []))
            elif a[:2] == ["pr", "list"] and "--base" in a:
                print(0)
            """)
        orca = fake % "orca" + textwrap.dedent("""\
            if st.get("orca_fail"):
                sys.exit(1)
            if a[:2] == ["terminal", "list"]:
                print(json.dumps({"result": {"terminals": st["terminals"]}}))
            elif a[:2] == ["orchestration", "worker-list"]:
                print(json.dumps({"result": {"workers": st["workers"]}}))
            else:
                print(json.dumps({"ok": True, "result": {}}))
            """)
        lsof = fake % "lsof" + textwrap.dedent("""\
            for p in st["held"]:
                print("p1"); print("n" + p)
            """)
        for name, body in (("gh", gh), ("orca", orca), ("lsof", lsof)):
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)

    def save_state(self):
        (self.tmp / "state.json").write_text(json.dumps(
            {"prs": self.prs, "workers": self.workers, "terminals": self.terminals, "held": self.held,
             "orca_fail": self.orca_fail}))

    def worktree(self, name, push=True, commits=1):
        path = self.wts / name
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "-b", name, str(path), "origin/main")
        for i in range(commits):
            (path / f"{name.replace('/', '-')}{i}.txt").write_text(name)
            sh("git", "-C", str(path), "add", "-A")
            sh("git", "-C", str(path), "commit", "-q", "-m", f"{name} {i}")
        if push:
            sh("git", "-C", str(path), "push", "-q", "-u", "origin", name)
        return path

    def squash_merge(self, name, path):
        """원격에서 squash 머지하고 브랜치를 지운 것처럼 만든다. 로컬 커밋은 원격 어디에도 없게 된다."""
        head = sh("git", "-C", str(path), "rev-parse", "HEAD")
        sh("git", "-C", str(self.repo), "push", "-q", "origin", "--delete", name)
        self.prs[name] = ["MERGED", head]
        return head

    def run_sweep(self, *args, code=0):
        self.save_state()
        env = dict(self.env, PATH=f"{self.bin}:{os.environ['PATH']}", ORCA=str(self.bin / "orca"), GH=str(self.bin / "gh"))
        done = subprocess.run(["python3", str(SCRIPT), "--repo", str(self.repo), "--wait", "1", *args],
                              capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, code, done.stderr)
        return done.stdout

    def branches(self):
        return set(sh("git", "-C", str(self.repo), "for-each-ref", "--format=%(refname:short)", "refs/heads/").split())

    def remote_branches(self):
        refs = sh("git", "-C", str(self.repo), "ls-remote", "--heads", "origin").split()[1::2]
        return {r.removeprefix("refs/heads/") for r in refs}

    def test_squash_merged_worktree_is_cleaned_with_terminal_dispatch_and_spec(self):
        path = self.worktree("feat-a")
        self.squash_merge("feat-a", path)
        self.terminals = [{"handle": "term_a", "worktreePath": str(path)}]
        self.workers = [{"dispatchId": "ctx_a", "workerState": "succeeded",
                         "resource": {"worktreeId": f"x::{path}", "releaseState": "retained"}}]
        specs = self.repo / ".omc/specs"
        specs.mkdir(parents=True)
        (specs / "spec-feat-a.md").write_text("x")
        (specs / "spec-other.md").write_text("x")
        out = self.run_sweep("--run", "run_x", "--specs-dir", ".omc/specs", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertNotIn("feat-a", self.branches())
        self.assertFalse((specs / "spec-feat-a.md").exists())
        self.assertTrue((specs / "spec-other.md").exists())
        calls = self.log.read_text()
        self.assertIn("orca terminal close --terminal term_a", calls)
        self.assertIn("orca orchestration worker-release --dispatch ctx_a", calls)

    def test_dry_run_changes_nothing(self):
        path = self.worktree("feat-a")
        self.squash_merge("feat-a", path)
        out = self.run_sweep()
        self.assertIn("정리", out)
        self.assertTrue(path.exists())
        self.assertIn("feat-a", self.branches())

    def test_open_pr_is_kept(self):
        path = self.worktree("feat-b")
        self.prs["feat-b"] = ["OPEN", sh("git", "-C", str(path), "rev-parse", "HEAD")]
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists())
        self.assertIn("남김", out)
        self.assertIn("feat-b", self.remote_branches())

    def test_dirty_worktree_is_skipped(self):
        path = self.worktree("feat-c")
        self.squash_merge("feat-c", path)
        (path / "new.txt").write_text("x")
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists())
        self.assertIn("커밋 안 된 변경", out)

    def test_commit_after_merged_head_is_skipped(self):
        path = self.worktree("feat-d")
        self.squash_merge("feat-d", path)
        (path / "later.txt").write_text("x")
        sh("git", "-C", str(path), "add", "-A")
        sh("git", "-C", str(path), "commit", "-q", "-m", "later")
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists())
        self.assertIn("원격에 없는 커밋 1", out)

    def test_live_worker_is_skipped(self):
        path = self.worktree("feat-e")
        self.squash_merge("feat-e", path)
        self.workers = [{"dispatchId": "ctx_e", "workerState": "working", "resource": {"worktreeId": f"x::{path}"}}]
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists())
        self.assertIn("살아 있는 worker ctx_e", out)

    def test_held_path_is_retried_later(self):
        path = self.worktree("feat-f")
        self.squash_merge("feat-f", path)
        self.held = [str(path)]
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists())
        self.assertIn("다음 실행에서 다시 시도", out)
        self.held = []
        self.run_sweep("--apply")
        self.assertFalse(path.exists())

    def test_gone_upstream_with_patches_in_base_is_cleaned_without_pr(self):
        path = self.worktree("feat-g")
        sh("git", "-C", str(self.repo), "merge", "-q", "--no-ff", "-m", "merge g", "feat-g")
        sh("git", "-C", str(self.repo), "push", "-q", "origin", "main")
        sh("git", "-C", str(self.repo), "push", "-q", "origin", "--delete", "feat-g")
        self.run_sweep("--apply")
        self.assertFalse(path.exists())
        self.assertNotIn("feat-g", self.branches())

    def test_gone_upstream_with_unmerged_patch_is_kept(self):
        path = self.worktree("feat-h")
        sh("git", "-C", str(self.repo), "push", "-q", "origin", "--delete", "feat-h")
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists())
        self.assertIn("base 에 없는 커밋 1 개", out)

    def test_local_branch_without_worktree_is_deleted_with_remote(self):
        path = self.worktree("feat-i")
        head = sh("git", "-C", str(path), "rev-parse", "HEAD")
        sh("git", "-C", str(self.repo), "worktree", "remove", str(path))
        self.prs["feat-i"] = ["MERGED", head]
        out = self.run_sweep("--apply")
        self.assertNotIn("feat-i", self.branches(), out)
        self.assertNotIn("feat-i", self.remote_branches())

    def test_release_branch_is_never_touched(self):
        path = self.worktree("release/1.0")
        self.squash_merge("release/1.0", path)
        self.run_sweep("--apply")
        self.assertTrue(path.exists())

    def fresh_gone_branch(self, name):
        """막 만든 브랜치. base 와 같고 커밋 0 이며 upstream 이 gone 이라 cherry 판정을 통과한다."""
        path = self.worktree(name, commits=0)
        sh("git", "-C", str(self.repo), "push", "-q", "origin", "--delete", name)
        return path

    def calls(self):
        return self.log.read_text() if self.log.exists() else ""

    def test_succeeded_dispatch_with_live_terminal_is_a_live_worker(self):
        path = self.fresh_gone_branch("prompt-fix")
        self.workers = [{"dispatchId": "ctx_p", "workerState": "succeeded", "agentTerminalHandle": "term_p",
                         "resource": {"worktreeId": f"x::{path}"}}]
        self.terminals = [{"handle": "term_p", "worktreePath": str(path)}]
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("살아 있는 worker ctx_p", out)
        self.assertNotIn("terminal close", self.calls())
        self.assertNotIn("worker-release", self.calls())

    def test_succeeded_worker_with_live_terminal_is_kept_even_when_pr_merged(self):
        path = self.worktree("sensor-fail")
        self.squash_merge("sensor-fail", path)
        self.workers = [{"dispatchId": "ctx_s", "workerState": "succeeded", "agentTerminalHandle": "term_s",
                         "resource": {"worktreeId": f"x::{path}"}}]
        self.terminals = [{"handle": "term_s", "worktreePath": str(path)}]
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertNotIn("terminal close", self.calls())

    def test_terminal_is_not_closed_without_merged_pr(self):
        path = self.fresh_gone_branch("fresh")
        self.terminals = [{"handle": "term_f", "worktreePath": str(path)}]
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("살아 있는 터미널", out)
        self.assertNotIn("terminal close", self.calls())

    def test_terminal_list_failure_stops_before_touching_anything(self):
        path = self.worktree("feat-x")
        self.squash_merge("feat-x", path)
        self.orca_fail = True
        self.run_sweep("--apply", code=2)
        self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
