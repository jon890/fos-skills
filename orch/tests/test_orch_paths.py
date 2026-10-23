"""orch_paths.py 의 경로 규칙과 옛 구조 검사, 그리고 .omc 가 없는 저장소에서 띄우기 준비 단계가 도는지 본다.

임시 git 저장소만 쓴다. 띄우기 준비는 실제 터미널 없이 되는 부분(지시서 검사, 첫 지시 줄, 워크트리 만들기)이다.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
SPEC = importlib.util.spec_from_file_location("orch_paths", SCRIPTS / "orch_paths.py")
op = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(op)

ENV = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
           GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
           GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")


def sh(*cmd, cwd=None, env=None):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True, env=env or ENV).stdout.strip()


class RepoCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = self.tmp / "repo"
        sh("git", "init", "-q", "-b", "main", str(self.repo))
        sh("git", "-C", str(self.repo), "commit", "-q", "--allow-empty", "-m", "init")
        self.old_env = os.environ.pop("ORCH_DIR", None)
        self.addCleanup(self.restore_env)

    def restore_env(self):
        os.environ.pop("ORCH_DIR", None)
        if self.old_env is not None:
            os.environ["ORCH_DIR"] = self.old_env

    def exclude(self):
        return (self.repo / ".git/info/exclude").read_text().splitlines()


class PathTest(RepoCase):
    def test_names_resolve_under_dot_orch_of_the_main_checkout(self):
        sub = self.repo / "sub"
        sub.mkdir()
        self.assertEqual(self.repo / ".orch", op.orch_dir(sub))
        self.assertEqual(self.repo / ".orch/specs", op.path("specs", self.repo))
        self.assertEqual(self.repo / ".orch/config.json", op.path("config", self.repo))
        self.assertEqual(self.repo / ".orch/state/heavy-slot", op.path("heavy-slot", self.repo))

    def test_a_linked_worktree_shares_the_main_checkouts_folder(self):
        wt = self.tmp / "wt"
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "-b", "feat/x", str(wt))
        self.assertEqual(self.repo / ".orch", op.orch_dir(wt))

    def test_orch_dir_env_is_relative_to_the_main_checkout(self):
        os.environ["ORCH_DIR"] = "work/orch"
        self.assertEqual(self.repo / "work/orch/queue", op.path("queue", self.repo))
        os.environ["ORCH_DIR"] = str(self.tmp / "elsewhere")
        self.assertEqual(self.tmp / "elsewhere/queue", op.path("queue", self.repo))

    def test_outside_git_the_given_folder_is_the_root(self):
        plain = self.tmp / "plain"
        plain.mkdir()
        self.assertEqual(plain / ".orch", op.orch_dir(plain))

    def test_unknown_name_is_an_error(self):
        with self.assertRaises(KeyError):
            op.path("board", self.repo)

    def test_ensure_creates_the_folder_and_ignores_it_once(self):
        target = op.ensure("queue", self.repo)
        op.ensure("state", self.repo)
        self.assertTrue(target.is_dir())
        self.assertEqual(1, self.exclude().count("/.orch/"))
        self.assertEqual("", sh("git", "-C", str(self.repo), "status", "--porcelain"))

    def test_ensure_on_a_file_name_creates_only_its_parent(self):
        target = op.ensure("config", self.repo)
        self.assertTrue(target.parent.is_dir())
        self.assertFalse(target.exists())

    def test_already_ignored_folder_adds_no_exclude_line(self):
        (self.repo / ".gitignore").write_text(".orch/\n")
        op.ensure("queue", self.repo)
        self.assertNotIn("/.orch/", self.exclude())

    def test_root_outside_the_repo_adds_no_exclude_line(self):
        os.environ["ORCH_DIR"] = str(self.tmp / "elsewhere")
        op.ensure("queue", self.repo)
        self.assertNotIn("/.orch/", self.exclude())

    def test_make_parent_ignores_only_paths_inside_the_root(self):
        op.make_parent(self.tmp / "other/state.json", self.repo)
        self.assertNotIn("/.orch/", self.exclude())
        op.make_parent(self.repo / ".orch/state/x.json", self.repo)
        self.assertIn("/.orch/", self.exclude())

    def test_board_comes_from_work_board_or_the_explicit_value(self):
        self.assertEqual(self.repo / ".omc/board.json", op.board_path(self.repo))
        self.assertEqual(self.repo / "b/board.json", op.board_path(self.repo, "b/board.json"))
        self.assertEqual(Path("/abs/board.json"), op.board_path(self.repo, "/abs/board.json"))

    def test_cli_prints_the_path(self):
        out = sh("python3", str(SCRIPTS / "orch_paths.py"), "--repo", str(self.repo), "specs")
        self.assertEqual(str(self.repo / ".orch/specs"), out)
        out = sh("python3", str(SCRIPTS / "orch_paths.py"), "--repo", str(self.repo), "--ensure", "bin")
        self.assertTrue(Path(out).is_dir())


class LegacyTest(RepoCase):
    def test_no_legacy_layout_passes(self):
        self.assertEqual([], op.legacy_paths(self.repo))
        self.assertTrue(op.require_migrated(self.repo))

    def test_each_marker_is_reported(self):
        (self.repo / ".claude").mkdir()
        (self.repo / ".claude/orch-finish.json").write_text("{}")
        (self.repo / ".omc/orch").mkdir(parents=True)
        self.assertEqual([".claude/orch-finish.json", ".omc/orch"], op.legacy_paths(self.repo))

    def test_scripts_that_read_settings_stop_with_the_migrate_command(self):
        (self.repo / ".claude").mkdir()
        (self.repo / ".claude/orch-overlay.md").write_text("# 오버레이\n")
        spec = self.repo / ".orch/specs/spec-a.md"
        spec.parent.mkdir(parents=True)
        spec.write_text("브랜치: `feat/a`\n")
        for script, args in (("spec-lint.py", ["--repo", str(self.repo), str(spec)]),
                             ("handoff-cleanup.py", ["--repo", str(self.repo)]),
                             ("finish-pr.py", ["1", "--repo", str(self.repo)])):
            done = subprocess.run(["python3", str(SCRIPTS / script), *args], capture_output=True, text=True, env=ENV)
            self.assertEqual(2, done.returncode, (script, done.stdout, done.stderr))
            self.assertIn("migrate-orch-dir.py", done.stderr, script)

    def test_explicit_config_or_overlay_skips_the_check(self):
        (self.repo / ".claude").mkdir()
        (self.repo / ".claude/orch-finish.json").write_text(json.dumps({"cleanup": {}}))
        done = subprocess.run(["python3", str(SCRIPTS / "handoff-cleanup.py"), "--repo", str(self.repo),
                               "--config", str(self.repo / ".claude/orch-finish.json"), "--board", "board.json"],
                              capture_output=True, text=True, env=ENV)
        self.assertEqual(0, done.returncode, done.stderr)


class LaunchPrepWithoutOmcTest(RepoCase):
    """oh-my-claudecode 가 없는 저장소에서 지시서를 쓰고 검사하고 워크트리를 만든다. .omc 가 생기지 않는다."""

    def setUp(self):
        super().setUp()
        origin = self.tmp / "origin.git"
        sh("git", "init", "-q", "--bare", "-b", "main", str(origin))
        (self.repo / "src").mkdir()
        (self.repo / "src/app.py").write_text("def run():\n    pass\n")
        sh("git", "-C", str(self.repo), "add", "-A")
        sh("git", "-C", str(self.repo), "commit", "-q", "-m", "app")
        sh("git", "-C", str(self.repo), "remote", "add", "origin", str(origin))
        sh("git", "-C", str(self.repo), "push", "-q", "-u", "origin", "main")
        self.overlay = op.ensure("overlay", self.repo)
        self.overlay.write_text("# 오버레이\n\n- 검증: `src/app.py` 를 고친 뒤 테스트를 돌린다\n")
        self.spec = op.ensure("specs", self.repo) / "spec-feat-a.md"
        self.spec.write_text("# 일\n\n브랜치: `feat/a`\n허락: push 를 허락했다.\n\n## 담당\n\n- `src/app.py` 의 `run()`\n")

    def test_lint_spec_line_and_worktree(self):
        done = subprocess.run(["python3", str(SCRIPTS / "spec-lint.py"), "--repo", str(self.repo),
                               "--check-overlay", str(self.spec)], capture_output=True, text=True, env=ENV)
        self.assertEqual(0, done.returncode, done.stdout + done.stderr)

        line = sh("python3", str(SCRIPTS / "spec-line.py"), str(self.spec), "--require-permission")
        self.assertIn(str(self.spec), line)
        self.assertIn("push 를 허락했다", line)

        wt = sh("bash", str(SCRIPTS / "make-worktree.sh"), "--repo", str(self.repo), "--spec", str(self.spec),
                "--name", "feat-a")
        self.assertEqual("feat/a", sh("git", "-C", wt, "branch", "--show-current"))
        self.assertEqual(self.repo / ".orch", op.orch_dir(wt))
        self.assertFalse((self.repo / ".omc").exists())
        self.assertEqual("", sh("git", "-C", str(self.repo), "status", "--porcelain"))


if __name__ == "__main__":
    unittest.main()
