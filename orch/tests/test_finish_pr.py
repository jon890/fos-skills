"""finish-pr.py 의 판정은 순수 함수로, 흐름은 임시 git 저장소와 가짜 gh, sweep, 업무 명령, 보드 명령으로 검증한다.

실제 GitHub, Orca, 업무 시스템에는 닿지 않는다. 워크트리와 브랜치는 모두 임시 저장소의 것이다.
"""

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "finish-pr.py"
SPEC = importlib.util.spec_from_file_location("finish_pr", SCRIPT)
fp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fp)


def run_for(*pairs):
    """(sha, status, conclusion) 쌍을 gh run list 의 항목으로 바꾼다."""
    return [{"headSha": s, "status": st, "conclusion": c} for s, st, c in pairs]


class VerdictTest(unittest.TestCase):
    def verdict(self, runs, descends=("m", "a", "b")):
        return fp.deploy_verdict(runs, "m", lambda ancestor, sha: sha in descends)

    def test_success_of_the_merge_commit_itself(self):
        self.assertEqual(("success", "m"), self.verdict(run_for(("m", "completed", "success"))))

    def test_merge_run_skipped_then_later_commit_succeeds(self):
        runs = run_for(("a", "completed", "success"), ("m", "completed", "skipped"))
        self.assertEqual(("success", "a"), self.verdict(runs))

    def test_merge_run_cancelled_by_newer_run_that_succeeds(self):
        runs = run_for(("a", "completed", "success"), ("m", "completed", "cancelled"))
        self.assertEqual(("success", "a"), self.verdict(runs))

    def test_cancelled_while_newer_run_still_going_waits(self):
        runs = run_for(("a", "in_progress", None), ("m", "completed", "cancelled"))
        self.assertEqual(("wait", None), self.verdict(runs))

    def test_only_skipped_waits(self):
        self.assertEqual(("wait", None), self.verdict(run_for(("m", "completed", "skipped"))))

    def test_failure_without_success_or_running(self):
        runs = run_for(("m", "completed", "failure"), ("x", "completed", "success"))
        self.assertEqual(("failure", "m"), self.verdict(runs))

    def test_run_of_a_commit_before_the_merge_commit_is_ignored(self):
        self.assertEqual(("wait", None), self.verdict(run_for(("old", "completed", "success"))))

    def test_no_runs_waits(self):
        self.assertEqual(("wait", None), self.verdict([]))


class PureTest(unittest.TestCase):
    def test_task_number_from_title(self):
        pattern = r"^\[?(PROJ-[0-9]+)"
        self.assertEqual("PROJ-123", fp.extract_task_number("[PROJ-123] 로그인 고침", pattern))
        self.assertEqual("PROJ-7", fp.extract_task_number("PROJ-7 fix", pattern))
        self.assertIsNone(fp.extract_task_number("번호 없는 제목", pattern))
        self.assertIsNone(fp.extract_task_number("PROJ-1", None))

    def test_numeric_group_and_unsafe_group(self):
        self.assertEqual("449", fp.extract_task_number("#TEAM/449 title", r"^#TEAM/([0-9]+)"))
        self.assertIsNone(fp.extract_task_number("x; rm -rf y", r"^(.*)$"))

    def test_complete_argv_replaces_placeholder_without_a_shell(self):
        self.assertEqual(["task-cli", "complete", "PROJ-123", "--state", "Done"],
                         fp.complete_argv("task-cli complete {number} --state 'Done'", "PROJ-123"))

    def test_spec_branches(self):
        text = "# 지시서\n- **브랜치:** `feat/a`\n본문에서 브랜치: `feat/zzz` 라고 말한다\n브랜치: `feat/b`\n"
        self.assertEqual({"feat/a", "feat/b"}, fp.spec_branches(text))

    def test_worktree_for_branch(self):
        porcelain = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/wt\nHEAD bbb\nbranch refs/heads/feat/x\n"
        self.assertEqual("/r/wt", fp.worktree_for_branch(porcelain, "feat/x"))
        self.assertIsNone(fp.worktree_for_branch(porcelain, "feat/y"))
        self.assertIsNone(fp.worktree_for_branch(porcelain, "feat"))


# 새로 만든 실행 파일은 처음 실행할 때 macOS 검사로 수십 초가 걸린다. 파일 하나에 gh 와 업무 명령을 함께 담고
# 이름만 다른 심볼릭 링크로 둬서 클래스마다 한 번만 치르게 한다.
FAKE_EXEC = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    name = os.path.basename(sys.argv[0])
    args = sys.argv[1:]
    open(os.environ["FAKE_LOG"], "a").write(name + " " + " ".join(args) + "\\n")
    if name != "gh":
        sys.exit(int(os.environ.get("FAKE_EXIT_" + name.upper().replace("-", "_"), "0")))
    state = json.load(open(os.environ["FAKE_STATE"]))
    if args[:2] == ["pr", "view"]:
        pr = state["pr"]
        print(json.dumps({"state": pr["state"], "mergeCommit": {"oid": pr["merge"]} if pr["merge"] else None,
                          "headRefName": pr["branch"], "title": pr["title"]}))
    elif args[:2] == ["run", "list"]:
        print(json.dumps(state["runs"]))
    else:
        sys.exit(3)
    """)

FAKE_SWEEP = textwrap.dedent("""\
    #!/usr/bin/env python3
    import os, subprocess, sys
    open(os.environ["FAKE_LOG"], "a").write("sweep " + " ".join(sys.argv[1:]) + "\\n")
    if os.environ.get("FAKE_SWEEP_REMOVES") == "1":
        wt = os.environ["FAKE_WORKTREE"]
        repo = sys.argv[sys.argv.index("--repo") + 1]
        subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", wt], check=True)
        subprocess.run(["git", "-C", repo, "branch", "-D", os.environ["FAKE_BRANCH"]], check=True)
    """)

FAKE_BOARD = textwrap.dedent("""\
    import os, sys
    open(os.environ["FAKE_LOG"], "a").write("board " + " ".join(sys.argv[1:]) + "\\n")
    """)


def sh(*cmd, env=None):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, env=env).stdout.strip()


class FinishFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bin = Path(tempfile.mkdtemp()).resolve()
        cls.addClassCleanup(shutil.rmtree, cls.bin, True)
        (cls.bin / "gh").write_text(FAKE_EXEC)
        (cls.bin / "gh").chmod(0o755 | stat.S_IEXEC)
        (cls.bin / "task-cli").symlink_to(cls.bin / "gh")
        (cls.bin / "sweep").write_text(FAKE_SWEEP)
        (cls.bin / "board").write_text(FAKE_BOARD)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com",
                        GH=str(self.bin / "gh"), CLEANUP_SWEEP=str(self.bin / "sweep"),
                        FAKE_STATE=str(self.tmp / "state.json"), FAKE_LOG=str(self.tmp / "log.txt"),
                        PATH=f"{self.bin}:{os.environ['PATH']}", FAKE_SWEEP_REMOVES="1")
        origin, self.repo = self.tmp / "origin.git", self.tmp / "repo"
        sh("git", "init", "-q", "--bare", "-b", "main", str(origin))
        sh("git", "clone", "-q", str(origin), str(self.repo))
        self.git("commit", "-q", "--allow-empty", "-m", "init")
        self.git("push", "-q", "-u", "origin", "main")
        self.branch = "feat/x"
        self.wt = self.tmp / "wt"
        self.git("worktree", "add", "-q", "-b", self.branch, str(self.wt), "origin/main")
        self.git("-C", str(self.wt), "commit", "-q", "--allow-empty", "-m", "work")
        self.git("push", "-q", "-u", "origin", self.branch)
        self.git("checkout", "-q", "--detach", "origin/main")
        self.git("merge", "-q", "--no-ff", "-m", "merge feat/x", self.branch)
        self.merge = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "-B", "main")
        self.git("commit", "-q", "--allow-empty", "-m", "later")
        self.later = self.git("rev-parse", "HEAD")
        self.git("push", "-q", "origin", "main")
        self.env.update(FAKE_WORKTREE=str(self.wt), FAKE_BRANCH=self.branch)
        self.specs = self.tmp / "specs"
        self.specs.mkdir()
        (self.specs / "spec-x.md").write_text(f"# x\n브랜치: `{self.branch}`\n")
        (self.specs / "spec-y.md").write_text("# y\n브랜치: `feat/other`\n")
        self.state = {"pr": {"state": "MERGED", "merge": self.merge, "branch": self.branch,
                             "title": "[PROJ-123] 로그인 고침"},
                      "runs": run_for((self.later, "completed", "success"), (self.merge, "completed", "skipped"))}

    def git(self, *args):
        return sh("git", "-C", str(self.repo), *args, env=self.env)

    def finish(self, *extra, **env):
        (self.tmp / "state.json").write_text(json.dumps(self.state))
        done = subprocess.run(
            ["python3", str(SCRIPT), "77", "--repo", str(self.repo), "--poll-interval", "0.01",
             "--merge-timeout", "0.005", "--deploy-timeout", "0.005", *extra],
            capture_output=True, text=True, env=dict(self.env, **env))
        return done.returncode, done.stdout + done.stderr

    def calls(self):
        log = self.tmp / "log.txt"
        return log.read_text().splitlines() if log.exists() else []

    COMPLETE = ["--complete", "--task-pattern", r"^\[?(PROJ-[0-9]+)", "--complete-cmd", "task-cli complete {number}"]

    def test_full_flow_cleans_worker_waits_for_deploy_completes_task_and_updates_board(self):
        code, out = self.finish("--run", "run_1", "--specs-dir", str(self.specs),
                                "--deploy-workflow", "deploy.yml", "--deploy-branch", "main",
                                *self.COMPLETE, "--board", str(self.tmp / "board.json"), "--board-id", "item-1",
                                "--board-bin", str(self.bin / "board"))
        self.assertEqual(0, code, out)
        self.assertTrue(out.rstrip().endswith("FINISH-DONE"), out)
        self.assertFalse(self.wt.exists())
        self.assertEqual("", self.git("branch", "--list", self.branch))
        self.assertFalse((self.specs / "spec-x.md").exists())
        self.assertTrue((self.specs / "spec-y.md").exists())
        calls = self.calls()
        sweep = [c for c in calls if c.startswith("sweep ")][0]
        self.assertIn("--apply", sweep)
        self.assertIn("--run run_1", sweep)
        self.assertIn("--kill-holders", sweep)
        self.assertIn("task-cli complete PROJ-123", calls)
        self.assertTrue(any(c.startswith("board ") and "set item-1 done" in c for c in calls), calls)
        self.assertLess(calls.index("task-cli complete PROJ-123"), max(i for i, c in enumerate(calls) if c.startswith("board ")))

    def test_intermediate_pr_keeps_the_spec(self):
        code, out = self.finish("--specs-dir", str(self.specs))
        self.assertEqual(0, code, out)
        self.assertTrue((self.specs / "spec-x.md").exists())
        self.assertTrue((self.specs / "spec-y.md").exists())
        self.assertIn("지시서 유지", out)

    def test_last_pr_deletes_only_its_branch_spec(self):
        code, out = self.finish("--specs-dir", str(self.specs), *self.COMPLETE)
        self.assertEqual(0, code, out)
        self.assertFalse((self.specs / "spec-x.md").exists())
        self.assertTrue((self.specs / "spec-y.md").exists())

    def test_sweep_runs_once_even_when_the_pr_head_name_has_no_local_worktree(self):
        """로컬 브랜치 이름이 PR head 이름과 다르면 head 이름으로 워크트리를 찾지 못해도 sweep 가 찾아 정리한다."""
        self.state["pr"]["branch"] = "other/name"
        code, out = self.finish("--run", "run_1", FAKE_SWEEP_REMOVES="0")
        self.assertEqual(0, code, out)
        self.assertEqual(1, len([c for c in self.calls() if c.startswith("sweep")]))

    def test_complete_without_a_task_command_deletes_the_spec_and_skips_completion(self):
        code, out = self.finish("--specs-dir", str(self.specs), "--complete")
        self.assertEqual(0, code, out)
        self.assertTrue(out.rstrip().endswith("FINISH-DONE"), out)
        self.assertIn("업무 완료 단계 건너뜀", out)
        self.assertNotIn("지시서 유지", out)
        self.assertFalse((self.specs / "spec-x.md").exists())
        self.assertTrue((self.specs / "spec-y.md").exists())
        self.assertFalse(any(c.startswith("task-cli") for c in self.calls()))

    def test_without_complete_the_task_command_is_not_run(self):
        code, out = self.finish("--task-pattern", r"^\[?(PROJ-[0-9]+)", "--complete-cmd", "task-cli complete {number}")
        self.assertEqual(0, code, out)
        self.assertFalse(any(c.startswith("task-cli") for c in self.calls()))

    def test_pr_closed_without_merge_fails_and_cleans_nothing(self):
        self.state["pr"].update(state="CLOSED", merge=None)
        code, out = self.finish("--run", "run_1")
        self.assertEqual(1, code)
        self.assertTrue(out.rstrip().endswith("FINISH-FAIL"), out)
        self.assertTrue(self.wt.exists())
        self.assertFalse(any(c.startswith("sweep") for c in self.calls()))

    def test_pr_still_open_times_out_without_cleaning(self):
        self.state["pr"].update(state="OPEN", merge=None)
        code, out = self.finish()
        self.assertEqual(1, code)
        self.assertIn("FINISH-FAIL", out)
        self.assertTrue(self.wt.exists())

    def test_failed_deploy_does_not_complete_the_task_or_touch_the_board(self):
        self.state["runs"] = run_for((self.merge, "completed", "failure"))
        code, out = self.finish("--deploy-workflow", "deploy.yml", "--deploy-branch", "main", *self.COMPLETE,
                                "--board-id", "item-1", "--board-bin", str(self.bin / "board"))
        self.assertEqual(1, code)
        self.assertTrue(out.rstrip().endswith("FINISH-FAIL"), out)
        self.assertFalse(any(c.startswith(("task-cli", "board")) for c in self.calls()))

    def test_deploy_never_finishing_times_out(self):
        self.state["runs"] = run_for((self.merge, "completed", "skipped"))
        code, out = self.finish("--deploy-workflow", "deploy.yml", "--deploy-branch", "main")
        self.assertEqual(1, code)
        self.assertIn("배포를 기다리다 시간이 지났다", out)

    def test_title_without_task_number_fails_after_the_board_is_updated(self):
        self.state["pr"]["title"] = "번호 없는 제목"
        code, out = self.finish(*self.COMPLETE, "--board-id", "item-1", "--board-bin", str(self.bin / "board"))
        self.assertEqual(1, code)
        self.assertIn("업무 번호를 찾지 못했다", out)
        self.assertTrue(out.rstrip().endswith("FINISH-FAIL"), out)
        self.assertTrue(any(c.startswith("board ") for c in self.calls()))
        self.assertFalse(any(c.startswith("task-cli") for c in self.calls()))

    def test_failed_complete_command_fails(self):
        code, out = self.finish(*self.COMPLETE, FAKE_EXIT_TASK_CLI="3")
        self.assertEqual(1, code)
        self.assertIn("완료 명령이 실패했다(종료 코드 3)", out)

    def test_worktree_that_sweep_cannot_remove_is_reported_but_the_flow_continues(self):
        code, out = self.finish("--deploy-workflow", "deploy.yml", "--deploy-branch", "main", FAKE_SWEEP_REMOVES="0")
        self.assertEqual(0, code, out)
        self.assertIn("정리 남음", out)
        self.assertEqual(fp.CLEANUP_TRIES, len([c for c in self.calls() if c.startswith("sweep")]))
        self.assertTrue(self.wt.exists())

    def test_config_file_supplies_options_and_command_line_wins(self):
        cfg = self.tmp / "config.json"
        cfg.write_text(json.dumps({"finish": {"run": "run_cfg", "deploy_workflow": "deploy.yml", "deploy_branch": "main"},
                                   "cleanup": {"trash": "/nowhere"}}))
        code, out = self.finish("--config", str(cfg), "--run", "run_cli")
        self.assertEqual(0, code, out)
        sweep = [c for c in self.calls() if c.startswith("sweep ")][0]
        self.assertIn("--run run_cli", sweep)
        self.assertTrue(any(c.startswith("gh run list --branch main --workflow deploy.yml") for c in self.calls()))

    def test_default_config_is_read_from_the_repo(self):
        (self.repo / ".orch").mkdir()
        (self.repo / ".orch/config.json").write_text(json.dumps({"finish": {"run": "run_default"}}))
        code, out = self.finish()
        self.assertEqual(0, code, out)
        self.assertIn("--run run_default", [c for c in self.calls() if c.startswith("sweep ")][0])

    def test_usage_errors_exit_2_before_waiting(self):
        for extra in (["--deploy-workflow", "deploy.yml"],
                      ["--complete", "--complete-cmd", "task-cli complete {number}"],
                      ["--complete", "--complete-cmd", "task-cli complete", "--task-pattern", "(a)"],
                      ["--complete", "--complete-cmd", "task-cli complete {number}", "--task-pattern", "a"],
                      ["--task-pattern", "("]):
            with self.subTest(extra=extra):
                self.assertEqual(2, self.finish(*extra)[0])
        cfg = self.tmp / "bad.json"
        cfg.write_text(json.dumps({"finish": {"typo_key": 1}}))
        code, out = self.finish("--config", str(cfg))
        self.assertEqual(2, code)
        self.assertIn("typo_key", out)

    def test_pid_file_is_written_while_running_and_removed_after(self):
        pid_file = self.tmp / "queue" / "finish-77.pid"
        code, out = self.finish("--pid-file", str(pid_file))
        self.assertEqual(0, code, out)
        self.assertFalse(pid_file.exists())


if __name__ == "__main__":
    unittest.main()
