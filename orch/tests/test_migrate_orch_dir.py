"""migrate-orch-dir.py 를 옛 구조를 만든 임시 저장소에서 미리보기와 --apply 로 돌린다.

orca 와 pgrep 은 가짜를 쓴다. FAKE_TASKS, FAKE_WORKERS 로 살아 있는 dispatch 와 worker 를 주고,
FAKE_ORCA_FAILS=1 이면 orca 가 실패한다. FAKE_BUSY 가 있으면 pgrep 이 그 줄을 낸다.
"""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "migrate-orch-dir.py"

FAKE_ORCA = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    if os.environ.get("FAKE_ORCA_FAILS") == "1":
        sys.exit(1)
    if "task-list" in sys.argv:
        print(json.dumps({"result": {"tasks": json.loads(os.environ.get("FAKE_TASKS", "[]"))}}))
    else:
        print(json.dumps({"result": {"workers": json.loads(os.environ.get("FAKE_WORKERS", "[]"))}}))
    """)
FAKE_PGREP = textwrap.dedent("""\
    #!/usr/bin/env python3
    import os, sys
    if os.environ.get("FAKE_PGREP_FAILS") == "1":
        sys.exit(3)
    busy = os.environ.get("FAKE_BUSY")
    if busy:
        print(busy)
    sys.exit(0 if busy else 1)
    """)


def sh(*cmd, env=None):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, env=env).stdout.strip()


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        for name, body in (("orca", FAKE_ORCA), ("pgrep", FAKE_PGREP)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755 | stat.S_IEXEC)
        self.env = {k: v for k, v in os.environ.items() if k != "ORCH_DIR"}
        self.env.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com",
                        ORCA=str(bin_dir / "orca"), PGREP=str(bin_dir / "pgrep"))
        self.repo = self.tmp / "repo"
        sh("git", "init", "-q", "-b", "main", str(self.repo), env=self.env)
        sh("git", "-C", str(self.repo), "commit", "-q", "--allow-empty", "-m", "init", env=self.env)

    def write(self, rel, text):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def migrate(self, *args, code=0, **env):
        done = subprocess.run(["python3", str(SCRIPT), "--repo", str(self.repo), *args],
                              capture_output=True, text=True, env=dict(self.env, **env))
        self.assertEqual(code, done.returncode, done.stdout + done.stderr)
        return done.stdout, done.stderr

    def handoffs_layout(self):
        """오버레이와 설정은 .claude, 지시서와 큐는 .omc/handoffs 에 둔 옛 구조."""
        root = self.repo
        self.write(".claude/orch-overlay.md", "- 지시서: `.omc/handoffs/specs/`\n- 큐: `.omc/handoffs/queue/q.out`\n")
        self.write(".claude/orch-finish.json", json.dumps({
            "finish": {"run": "run_x", "board": ".omc/handoffs/board.json", "specs_dir": ".omc/handoffs/specs"},
            "cleanup": {"omc": ".omc"}}))
        self.write(".omc/handoffs/specs/spec-common.md", "공통\n")
        self.write(".omc/handoffs/specs/spec-a.md", f"먼저 `{root}/.omc/handoffs/specs/spec-common.md` 를 읽는다.\n")
        self.write(".omc/handoffs/queue/q.out", "QUEUE-DONE\n")
        self.write(".omc/handoffs/board.json", "{}")
        self.write(".omc/handoffs/bin/merge.sh", 'echo "$R/.omc/handoffs/queue"\n')
        self.write(".omc/state/wait-important-lost.json", "{}")
        self.write(".omc/state/session.json", "{}")
        self.write(".omc/previews/a.html", "<html>")

    def test_preview_lists_moves_and_references_and_changes_nothing(self):
        self.handoffs_layout()
        before = sorted(p.relative_to(self.repo) for p in self.repo.rglob("*") if ".git" not in p.parts)
        out, _ = self.migrate()
        self.assertIn("옮길 것 .claude/orch-overlay.md -> .orch/overlay.md", out)
        self.assertIn("옮길 것 .claude/orch-finish.json -> .orch/config.json", out)
        self.assertIn("옮길 것 .omc/handoffs/specs -> .orch/specs", out)
        self.assertIn("옮길 것 .omc/handoffs/queue -> .orch/queue", out)
        self.assertIn("옮길 것 .omc/state/wait-important-lost.json -> .orch/state/wait-important-lost.json", out)
        self.assertIn("바꿀 옛 경로 .omc/handoffs/specs/spec-a.md:1:", out)
        self.assertIn("옛 경로 참조(스크립트. 옛 폴더를 다시 만들 수 있어 옮긴 뒤 고친다) .omc/handoffs/bin/merge.sh:1:", out)
        self.assertNotIn("session.json", out)
        self.assertNotIn("q.out:", out)
        after = sorted(p.relative_to(self.repo) for p in self.repo.rglob("*") if ".git" not in p.parts)
        self.assertEqual(before, after)

    def test_apply_moves_rewrites_and_keeps_other_tools_files(self):
        self.handoffs_layout()
        out, _ = self.migrate("--apply")
        orch = self.repo / ".orch"
        self.assertEqual(f"먼저 `{orch}/specs/spec-common.md` 를 읽는다.\n", (orch / "specs/spec-a.md").read_text())
        self.assertEqual("- 지시서: `.orch/specs/`\n- 큐: `.orch/queue/q.out`\n", (orch / "overlay.md").read_text())
        config = json.loads((orch / "config.json").read_text())
        self.assertEqual(".orch/specs", config["finish"]["specs_dir"])
        self.assertEqual(".omc/handoffs/board.json", config["finish"]["board"])
        self.assertEqual({"previews": ".omc/previews"}, config["cleanup"])
        self.assertTrue((orch / "queue/q.out").is_file())
        self.assertTrue((orch / "state/wait-important-lost.json").is_file())
        for rel in (".omc/handoffs/board.json", ".omc/handoffs/bin/merge.sh", ".omc/state/session.json",
                    ".omc/previews/a.html"):
            self.assertTrue((self.repo / rel).exists(), rel)
        self.assertFalse((self.repo / ".claude/orch-overlay.md").exists())
        self.assertIn("/.orch/", (self.repo / ".git/info/exclude").read_text().splitlines())
        self.assertEqual("", sh("git", "-C", str(self.repo), "status", "--porcelain", "--", ".orch", env=self.env))
        self.assertIn("설정 cleanup.omc 를 지운다", out)

        out, _ = self.migrate("--apply")
        self.assertEqual("옮길 것이 없다", out.strip().splitlines()[-1])

    def test_dot_omc_orch_layout_moves_scripts_to_bin_and_the_rest_to_the_root(self):
        self.write(".omc/orch/scripts/slot.sh", "SCRIPT_DIR=.omc/orch/scripts\n")
        self.write(".omc/orch/specs/spec-common.md", "공통\n")
        self.write(".omc/orch/queue-env.sh", "x\n")
        self.write(".omc/orch/wait.json", "{}")
        self.write(".omc/orch/pr-feat-a.md", "본문 `.omc/orch/specs/spec-common.md`\n")
        self.write(".omc/state/notify-conflicts.json", "{}")
        self.write(".omc/board.json", "{}")
        self.migrate("--apply")
        orch = self.repo / ".orch"
        self.assertEqual("SCRIPT_DIR=.omc/orch/scripts\n", (orch / "bin/slot.sh").read_text())
        self.assertEqual("본문 `.orch/specs/spec-common.md`\n", (orch / "pr-feat-a.md").read_text())
        for rel in ("specs/spec-common.md", "queue-env.sh", "wait.json", "state/notify-conflicts.json"):
            self.assertTrue((orch / rel).is_file(), rel)
        self.assertFalse((self.repo / ".omc/orch").exists())
        self.assertTrue((self.repo / ".omc/board.json").is_file())

    def test_extra_pairs_merge_into_existing_folders_and_never_move_the_board(self):
        self.write(".orch/specs/spec-new.md", "새\n")
        self.write(".omc/handoffs/specs/spec-old.md", "옛\n")
        self.write(".omc/handoffs/bin/merge.sh", "x\n")
        self.write(".omc/handoffs/report/a.md", "조사\n")
        self.write(".omc/handoffs/board.json", "{}")
        out, _ = self.migrate("--move", ".omc/handoffs/bin=.orch/bin", "--move", ".omc/handoffs=.orch/notes", "--apply")
        self.assertTrue((self.repo / ".orch/specs/spec-new.md").is_file())
        self.assertTrue((self.repo / ".orch/specs/spec-old.md").is_file())
        self.assertTrue((self.repo / ".orch/bin/merge.sh").is_file())
        self.assertTrue((self.repo / ".orch/notes/report/a.md").is_file())
        self.assertTrue((self.repo / ".omc/handoffs/board.json").is_file())
        self.assertIn("남김 .omc/handoffs/board.json", out)

    def test_conflict_moves_nothing(self):
        self.write(".orch/specs/spec-a.md", "새\n")
        self.write(".omc/handoffs/specs/spec-a.md", "옛\n")
        self.write(".omc/handoffs/queue/q.out", "x\n")
        out, err = self.migrate("--apply", code=1)
        self.assertIn("겹침 .omc/handoffs/specs/spec-a.md -> .orch/specs/spec-a.md", out)
        self.assertIn("아무것도 옮기지 않았다", err)
        self.assertTrue((self.repo / ".omc/handoffs/queue/q.out").exists())
        self.assertEqual("새\n", (self.repo / ".orch/specs/spec-a.md").read_text())

    def test_tracked_files_get_a_git_mv_command_and_the_rest_moves(self):
        self.write(".claude/orch-overlay.md", "# 오버레이\n")
        sh("git", "-C", str(self.repo), "add", ".claude/orch-overlay.md", env=self.env)
        sh("git", "-C", str(self.repo), "commit", "-q", "-m", "overlay", env=self.env)
        self.write(".omc/handoffs/specs/spec-a.md", "x\n")
        out, _ = self.migrate("--apply", code=1)
        command = f"mkdir -p {self.repo / '.orch'} && git -C {self.repo} mv .claude/orch-overlay.md .orch/overlay.md"
        self.assertIn(f"추적 파일 {command}", out)
        self.assertTrue((self.repo / ".claude/orch-overlay.md").exists())
        self.assertTrue((self.repo / ".orch/specs/spec-a.md").exists())
        self.assertEqual("", sh("git", "-C", str(self.repo), "status", "--porcelain", env=self.env))
        sh("bash", "-c", command, env=self.env)
        self.assertIn("R  .claude/orch-overlay.md -> .orch/overlay.md",
                      sh("git", "-C", str(self.repo), "status", "--porcelain", env=self.env))

    def test_tracked_only_creates_the_target_folder_so_the_command_runs(self):
        self.write(".claude/orch-overlay.md", "# 오버레이\n")
        sh("git", "-C", str(self.repo), "add", ".claude/orch-overlay.md", env=self.env)
        sh("git", "-C", str(self.repo), "commit", "-q", "-m", "overlay", env=self.env)
        out, _ = self.migrate("--apply", code=1)
        self.assertTrue((self.repo / ".orch").is_dir())
        sh("git", "-C", str(self.repo), "mv", ".claude/orch-overlay.md", ".orch/overlay.md", env=self.env)

    def test_live_work_blocks_apply(self):
        self.write(".omc/handoffs/specs/spec-a.md", "x\n")
        spec = self.repo / ".omc/handoffs/specs/spec-a.md"
        tasks = json.dumps([{"id": "t1", "status": "running", "spec": f"지시서 {spec} 를 끝까지 읽고 수행한다."}])
        held = json.dumps([{"dispatchId": "ctx_1", "dispatchStatus": "completed", "terminalState": "active",
                            "resource": {"ownershipState": "owned", "worktreeId": f"wt::{self.repo}"}}])
        other = json.dumps([{"dispatchId": "ctx_2", "dispatchStatus": "completed", "terminalState": "active",
                             "resource": {"ownershipState": "owned", "worktreeId": f"wt::{self.tmp / 'other'}"}}])
        cases = ((dict(FAKE_TASKS=tasks), "살아 있는 dispatch"),
                 (dict(FAKE_WORKERS=held), "터미널을 쥔 worker 가 있다: ctx_1"),
                 (dict(FAKE_ORCA_FAILS="1"), "orca 로 살아 있는 dispatch 와 worker 를 읽지 못했다"),
                 (dict(FAKE_BUSY="123 python3 merge-with-finish.py 1"), "머지 큐나 마무리가 돌고 있다"))
        for env, reason in cases:
            _, err = self.migrate("--apply", code=3, **env)
            self.assertIn(reason, err)
            self.assertTrue(spec.exists(), reason)
        self.migrate("--apply", FAKE_WORKERS=other)
        self.assertTrue((self.repo / ".orch/specs/spec-a.md").exists())

    def test_tracked_references_are_reported_not_changed(self):
        doc = self.write("docs/plan.md", "bash .omc/orch/scripts/gate.sh\n")
        sh("git", "-C", str(self.repo), "add", "docs/plan.md", env=self.env)
        sh("git", "-C", str(self.repo), "commit", "-q", "-m", "doc", env=self.env)
        self.write(".omc/orch/scripts/gate.sh", "x\n")
        out, _ = self.migrate("--apply")
        self.assertIn("옛 경로 참조 docs/plan.md:1: bash .omc/orch/scripts/gate.sh", out)
        self.assertEqual("bash .omc/orch/scripts/gate.sh\n", doc.read_text())

    def test_empty_old_folders_are_removed_and_create_no_new_folders(self):
        (self.repo / ".omc/orch/specs").mkdir(parents=True)
        (self.repo / ".omc/handoffs/queue").mkdir(parents=True)
        out, _ = self.migrate()
        self.assertIn("지울 빈 폴더 .omc/orch/specs", out)
        self.migrate("--apply")
        self.assertFalse((self.repo / ".omc/orch").exists())
        self.assertFalse((self.repo / ".omc/handoffs/queue").exists())
        self.assertFalse((self.repo / ".orch").exists())
        out, _ = self.migrate("--apply")
        self.assertEqual("옮길 것이 없다\n", out)

    def test_empty_old_folder_next_to_an_existing_orch_does_not_block(self):
        self.write(".orch/specs/spec-a.md", "x\n")
        (self.repo / ".omc/orch").mkdir(parents=True)
        self.migrate("--apply")
        self.assertFalse((self.repo / ".omc/orch").exists())
        done = subprocess.run(["python3", str(SCRIPT.parent / "orch_paths.py"), "--repo", str(self.repo), "check"],
                              capture_output=True, text=True, env=self.env)
        self.assertEqual(0, done.returncode, done.stderr)

    def test_previews_alone_create_a_config_that_keeps_cleaning_them(self):
        self.write(".omc/previews/a.html", "<html>")
        out, _ = self.migrate("--apply")
        self.assertEqual({"cleanup": {"previews": ".omc/previews"}},
                         json.loads((self.repo / ".orch/config.json").read_text()))
        self.assertIn("설정 파일을 새로 만든다", out)

    def test_a_failed_move_stops_and_a_rerun_finishes_the_rest(self):
        self.write(".omc/handoffs/specs/spec-a.md", "`.omc/handoffs/queue/q.out` 를 본다\n")
        self.write(".omc/handoffs/queue/q.out", "x\n")
        self.write(".omc/state/wait-important-lost.json", "{}")
        state = self.repo / ".omc/state"
        state.chmod(0o500)
        try:
            _, err = self.migrate("--apply", code=1)
        finally:
            state.chmod(0o700)
        self.assertIn("옮기다 실패했다 .omc/state/wait-important-lost.json", err)
        self.assertTrue((self.repo / ".orch/specs/spec-a.md").exists())
        self.assertIn(".omc/handoffs/queue", (self.repo / ".orch/specs/spec-a.md").read_text())
        self.migrate("--apply")
        self.assertEqual("`.orch/queue/q.out` 를 본다\n", (self.repo / ".orch/specs/spec-a.md").read_text())
        self.assertTrue((self.repo / ".orch/state/wait-important-lost.json").exists())

    def test_a_worktree_repo_argument_moves_the_main_checkout(self):
        self.write(".omc/handoffs/specs/spec-a.md", "x\n")
        wt = self.tmp / "wt"
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "-b", "feat/x", str(wt), env=self.env)
        done = subprocess.run(["python3", str(SCRIPT), "--repo", str(wt), "--apply"],
                              capture_output=True, text=True, env=self.env)
        self.assertEqual(0, done.returncode, done.stdout + done.stderr)
        self.assertTrue((self.repo / ".orch/specs/spec-a.md").exists())
        self.assertFalse((wt / ".orch").exists())

    def test_relative_symlinks_keep_their_target(self):
        self.write("docs/shared.md", "공유\n")
        self.write(".omc/orch/specs/spec-a.md", "x\n")
        (self.repo / ".omc/orch/specs/shared.md").symlink_to("../../../docs/shared.md")
        (self.repo / ".omc/orch/specs/alias.md").symlink_to("spec-a.md")
        self.migrate("--apply")
        self.assertEqual("공유\n", (self.repo / ".orch/specs/shared.md").read_text())
        self.assertEqual("x\n", (self.repo / ".orch/specs/alias.md").read_text())
        self.assertEqual("spec-a.md", os.readlink(self.repo / ".orch/specs/alias.md"))

    def test_untracked_claude_files_are_reported_except_worktrees(self):
        self.write(".claude/settings.local.json", '{"allow": ["Bash(.omc/orch/scripts/gate.sh)"]}')
        self.write(".claude/worktrees/x/notes.md", ".omc/orch/scripts/gate.sh\n")
        self.write(".omc/orch/scripts/gate.sh", "x\n")
        out, _ = self.migrate()
        self.assertIn("옛 경로 참조 .claude/settings.local.json:1:", out)
        self.assertNotIn("worktrees", out)

    def test_pgrep_failure_blocks_apply(self):
        self.write(".omc/handoffs/specs/spec-a.md", "x\n")
        _, err = self.migrate("--apply", code=3, FAKE_PGREP_FAILS="1")
        self.assertIn("pgrep 으로 머지 큐와 마무리 프로세스를 확인하지 못했다", err)

    def test_orch_dir_inside_an_old_location_is_refused(self):
        self.write(".omc/orch/specs/spec-a.md", "x\n")
        _, err = self.migrate("--apply", code=2, ORCH_DIR=".omc/orch/new")
        self.assertIn("옛 위치 .omc/orch 안이다", err)

    def test_nothing_to_move(self):
        out, _ = self.migrate()
        self.assertEqual("옮길 것이 없다\n", out)

    def test_bad_move_pair_is_a_usage_error(self):
        self.migrate("--move", "no-equals", code=2)
        self.migrate("--move", "/abs=.orch/x", code=2)
        self.migrate("--move", ".git/x=.orch/x", code=2)
        self.migrate("--move", ".=.orch/x", code=2)
        self.migrate("--move", ".omc/a=.omc/a/b", code=2)
        self.migrate("--move", " =.orch/x", code=2)


if __name__ == "__main__":
    unittest.main()
