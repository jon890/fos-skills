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
HOOK = "node /x/oh-my-claudecode/dist/hooks/session-end/worker.js --omc-session-end-worker {}"


def sh(*cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class CleanupSweepTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Reuse executables to avoid macOS first-execution checks per test.
        # Mutable state and logs still live in each test's own directory.
        cls.bin = Path(tempfile.mkdtemp()).resolve()
        cls.addClassCleanup(shutil.rmtree, cls.bin, True)
        cls.write_fakes()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com",
                        FAKE_STATE=str(self.tmp / "state.json"), FAKE_LOG=str(self.tmp / "calls.log"))
        os.environ.update({k: self.env[k] for k in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
                                                      "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
                                                      "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL")})
        self.repo = self.make_repo("repo")
        self.wts = self.tmp / "wts"
        self.prs, self.workers, self.terminals, self.held = {}, [], [], []
        self.all_workers, self.scope = [], "all"
        self.processes, self.spawn_on_release, self.gh_raw, self.open_bases = [], None, {}, []
        self.orca_fail = self.gh_fail = self.orca_close_noop = self.tasks_fail = False
        self.tasks = []
        self.log = self.tmp / "calls.log"

    def make_repo(self, name):
        origin = self.tmp / f"{name}-origin.git"
        repo = self.tmp / name
        sh("git", "init", "-q", "--bare", "-b", "main", str(origin))
        sh("git", "clone", "-q", str(origin), str(repo))
        sh("git", "-C", str(repo), "commit", "-q", "--allow-empty", "-m", "init")
        sh("git", "-C", str(repo), "push", "-q", "-u", "origin", "main")
        return repo

    @classmethod
    def write_fakes(cls):
        state = 'os.environ["FAKE_STATE"]'
        fake = textwrap.dedent(f"""\
            #!/usr/bin/env python3
            import json, os, sys
            st = json.load(open({state}))
            a = sys.argv[1:]
            open(os.environ["FAKE_LOG"], "a").write(" ".join(["%s"] + a) + "\\n")
            """)
        gh = fake % "gh" + textwrap.dedent("""\
            if st.get("gh_fail"):
                sys.exit(1)
            if a[:2] == ["pr", "list"] and "--head" in a:
                b = a[a.index("--head") + 1]
                p = st["prs"].get(b)
                if b in st["gh_raw"]:
                    print(st["gh_raw"][b])
                else:
                    print(json.dumps([{"number": 1, "state": p[0], "headRefOid": p[1], "headRefName": b,
                                       "isCrossRepository": len(p) > 2 and p[2]}] if p else []))
            elif a[:2] == ["pr", "list"] and "--base" in a:
                print(1 if a[a.index("--base") + 1] in st["open_bases"] else 0)
            """)
        orca = fake % "orca" + textwrap.dedent(f"""\
            if st.get("orca_fail"):
                sys.exit(1)
            def save():
                json.dump(st, open({state}, "w"))
            if a[:2] == ["terminal", "list"]:
                print(json.dumps({{"result": {{"terminals": st["terminals"]}}}}))
            elif a[:2] == ["orchestration", "worker-list"] and "--run" not in a:
                # 모든 Run 범위 조회. 묶인 터미널 handle 이 넘어오면 범위가 그 Run 으로 좁혀진다
                import os
                bound = os.environ.get("ORCA_TERMINAL_HANDLE")
                scope = "bound" if bound else st.get("scope", "all")
                print(json.dumps({{"result": {{"workers": st["all_workers"], "scope": {{"source": scope}},
                                               "page": {{"nextCursor": None}}}}}}))
            elif a[:2] == ["orchestration", "task-list"] and st.get("tasks_fail"):
                sys.exit(1)
            elif a[:2] == ["orchestration", "task-list"]:
                print(json.dumps({{"result": {{"tasks": st.get("tasks", [])}}}}))
            elif a[:2] == ["orchestration", "worker-list"]:
                print(json.dumps({{"result": {{"workers": st["workers"]}}}}))
            elif a[:2] == ["terminal", "close"] and st.get("close_noop"):
                print(json.dumps({{"ok": True, "result": {{}}}}))
            elif a[:2] == ["terminal", "close"]:
                h = a[a.index("--terminal") + 1]
                st["terminals"] = [t for t in st["terminals"] if t["handle"] != h]
                st["processes"] = [q for q in st["processes"] if q.get("terminal") != h]
                save()
                print(json.dumps({{"ok": True, "result": {{}}}}))
            elif a[:2] == ["orchestration", "worker-release"] and st.get("spawn_on_release"):
                # worker 를 반납하면 Orca 가 그 워크트리에 빈 셸 터미널을 띄운다
                sp = st.pop("spawn_on_release")
                st["terminals"].append({{"handle": sp["handle"], "worktreePath": sp["path"]}})
                st["processes"].extend(sp["processes"])
                save()
                print(json.dumps({{"ok": True, "result": {{}}}}))
            else:
                print(json.dumps({{"ok": True, "result": {{}}}}))
            """)
        # pid 가 SWEEP 이면 cleanup-sweep.py 자신이다. 두 가짜는 그 스크립트가 바로 띄우므로 부모 pid 가 곧 그 pid 다
        lsof = fake % "lsof" + textwrap.dedent("""\
            import os
            for q in st["processes"]:
                print("p" + str(os.getppid() if q["pid"] == "SWEEP" else q["pid"])); print("n" + q["cwd"])
            """)
        ps = fake % "ps" + textwrap.dedent("""\
            import os
            for q in st["processes"]:
                print(os.getppid() if q["pid"] == "SWEEP" else q["pid"], q.get("ppid", 1), q["command"])
            """)
        # 신호를 받은 프로세스를 지운다. ignores 에 든 신호는 무시한다(로그인 셸은 TERM 을 무시한다)
        kill = fake % "kill" + textwrap.dedent(f"""\
            sig = a[0].lstrip("-")
            st["processes"] = [q for q in st["processes"] if str(q["pid"]) not in a[1:] or sig in q.get("ignores", [])]
            json.dump(st, open({state}, "w"))
            """)
        for name, body in (("gh", gh), ("orca", orca), ("lsof", lsof), ("ps", ps), ("kill", kill)):
            path = cls.bin / name
            path.write_text(body)
            path.chmod(0o755)

    def save_state(self):
        (self.tmp / "state.json").write_text(json.dumps(
            {"prs": self.prs, "workers": self.workers, "terminals": self.terminals,
             "processes": self.processes + [{"pid": 900 + i, "cwd": p, "command": "node server.js"}
                                            for i, p in enumerate(self.held)],
             "spawn_on_release": self.spawn_on_release, "gh_raw": self.gh_raw, "open_bases": self.open_bases,
             "all_workers": self.all_workers, "scope": self.scope,
             "orca_fail": self.orca_fail, "gh_fail": self.gh_fail, "close_noop": self.orca_close_noop,
             "tasks": self.tasks, "tasks_fail": self.tasks_fail}))

    def worktree(self, name, push=True, commits=1, repo=None):
        repo = repo or self.repo
        path = self.wts / name
        sh("git", "-C", str(repo), "worktree", "add", "-q", "-b", name, str(path), "origin/main")
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

    def run_sweep(self, *args, code=0, repos=None):
        self.save_state()
        env = dict(self.env, PATH=f"{self.bin}:{os.environ['PATH']}", ORCA=str(self.bin / "orca"), GH=str(self.bin / "gh"),
                   ORCH_KILL=str(self.bin / "kill"))
        flags = [f for r in (repos or [self.repo]) for f in ("--repo", str(r))]
        done = subprocess.run(["python3", str(SCRIPT), *flags, "--wait", "0.01", "--poll-interval", "0.01", *args],
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
        # 끝 커밋이 PR HEAD 의 조상이 아니므로 그 PR 의 브랜치로 보지 않고, base 에 없는 커밋이 있어 남긴다
        self.assertIn("남김", out)
        self.assertIn("feat-d", self.branches())

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

    def merged_worker_with_terminal(self, name, state, status):
        path = self.worktree(name)
        self.squash_merge(name, path)
        self.workers = [{"dispatchId": "ctx_s", "workerState": state, "dispatchStatus": status,
                         "agentTerminalHandle": "term_s", "resource": {"worktreeId": f"x::{path}"}}]
        self.terminals = [{"handle": "term_s", "worktreePath": str(path)}]
        return path

    def test_merged_pr_with_finished_worker_closes_leftover_terminal_and_sweeps(self):
        path = self.merged_worker_with_terminal("sensor-fail", "succeeded", "completed")
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertIn("terminal close --terminal term_s", self.calls())

    def test_merged_pr_with_working_worker_is_kept(self):
        path = self.merged_worker_with_terminal("sensor-busy", "working", "dispatched")
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("살아 있는 worker ctx_s", out)
        self.assertNotIn("terminal close", self.calls())

    def test_cherry_judged_branch_with_completed_dispatch_and_terminal_is_kept(self):
        path = self.fresh_gone_branch("fresh-done")
        self.workers = [{"dispatchId": "ctx_s", "workerState": "succeeded", "dispatchStatus": "completed",
                         "agentTerminalHandle": "term_s", "resource": {"worktreeId": f"x::{path}"}}]
        self.terminals = [{"handle": "term_s", "worktreePath": str(path)}]
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("살아 있는 worker ctx_s", out)
        self.assertNotIn("terminal close", self.calls())

    def foreign_terminal_at(self, name):
        """머지된 워크트리에 다른 Run 의 worker 터미널이 붙어 있다. 이 Run 은 그 worker 를 모른다."""
        path = self.worktree(name)
        self.squash_merge(name, path)
        self.terminals = [{"handle": "term_codex", "worktreePath": str(path)}]
        self.all_workers = [{"runId": "run_other", "dispatchId": "ctx_o", "agentTerminalHandle": "term_codex"}]
        return path

    def test_terminal_of_another_run_is_not_closed(self):
        path = self.foreign_terminal_at("feat-o1")
        self.env["ORCA_TERMINAL_HANDLE"] = "term_coordinator"
        out = self.run_sweep("--run", "run_x", "--kill-holders", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("다른 Run 의 worker 터미널 term_codex", out)
        self.assertNotIn("terminal close", self.calls())
        self.assertIn("feat-o1", self.branches())

    def test_worker_of_another_run_elsewhere_does_not_block_this_path(self):
        path = self.foreign_terminal_at("feat-o2")
        self.all_workers.append({"runId": "run_x", "dispatchId": "ctx_a", "agentTerminalHandle": "term_mine"})
        self.terminals = [{"handle": "term_mine", "worktreePath": str(path)},
                          {"handle": "term_codex", "worktreePath": str(self.tmp / "elsewhere")}]
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertIn("orca terminal close --terminal term_mine", self.calls())
        self.assertNotIn("--terminal term_codex", self.calls())

    def test_unknown_terminal_is_kept_when_runs_cannot_be_listed(self):
        path = self.foreign_terminal_at("feat-o3")
        self.scope = "bound"
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("확인하지 못한 터미널 term_codex", out)
        self.assertNotIn("terminal close", self.calls())

    def test_without_run_terminals_are_found_by_path_as_before(self):
        path = self.foreign_terminal_at("feat-o5")
        out = self.run_sweep("--apply")
        self.assertFalse(path.exists(), out)
        self.assertIn("orca terminal close --terminal term_codex", self.calls())
        self.assertNotIn("worker-list", self.calls())

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

    def renamed_worktree(self, local, remote, track=True, repo=None):
        """로컬 브랜치 이름과 원격 브랜치 이름이 다른 worktree. 원격 브랜치는 그대로 둔다."""
        path = self.worktree(local, push=False, repo=repo)
        sh("git", "-C", str(path), "push", "-q", *(["-u"] if track else []), "origin", f"{local}:{remote}")
        return path

    def sweep_calls(self, needle):
        return [line for line in self.calls().splitlines() if needle in line]

    # 1. squash 머지, PR HEAD 가 워크트리 HEAD 보다 앞선 경우
    def test_pr_head_ahead_of_worktree_is_fetched_and_passed_as_merged_head(self):
        path = self.worktree("feat-j")
        other = self.tmp / "other"
        sh("git", "clone", "-q", "-b", "feat-j", str(self.tmp / "repo-origin.git"), str(other))
        (other / "update.txt").write_text("x")
        sh("git", "-C", str(other), "add", "-A")
        sh("git", "-C", str(other), "commit", "-q", "-m", "Merge branch main into feat-j")
        ahead = sh("git", "-C", str(other), "rev-parse", "HEAD")
        sh("git", "-C", str(other), "push", "-q", "origin", f"{ahead}:refs/pull/1/head")
        sh("git", "-C", str(other), "push", "-q", "origin", ":feat-j")
        self.prs["feat-j"] = ["MERGED", ahead]
        self.assertNotEqual(sh("git", "-C", str(path), "rev-parse", "HEAD"), ahead)
        out = self.run_sweep("--apply")
        self.assertFalse(path.exists(), out)
        self.assertNotIn("feat-j", self.branches())

    # 2. 브랜치 이름 대응
    def test_pr_is_found_by_upstream_name_and_remote_branch_is_deleted(self):
        path = self.renamed_worktree("dev/proj-topic", "proj/topic")
        head = sh("git", "-C", str(path), "rev-parse", "HEAD")
        self.prs["proj/topic"] = ["MERGED", head]
        out = self.run_sweep("--apply")
        self.assertFalse(path.exists(), out)
        self.assertNotIn("dev/proj-topic", self.branches())
        self.assertNotIn("proj/topic", self.remote_branches())
        self.assertIn("--head proj/topic", self.calls())
        self.assertNotIn("--head dev/proj-topic", self.calls())

    def test_pr_is_found_by_name_variant_without_upstream(self):
        path = self.renamed_worktree("dev/proj-topic", "proj/topic", track=False)
        sh("git", "-C", str(self.repo), "push", "-q", "origin", "--delete", "proj/topic")
        self.prs["proj/topic"] = ["MERGED", sh("git", "-C", str(path), "rev-parse", "HEAD")]
        out = self.run_sweep("--apply")
        self.assertFalse(path.exists(), out)

    def test_name_variant_pr_that_does_not_contain_the_branch_is_ignored(self):
        path = self.worktree("dev/topic")
        self.prs["topic"] = ["MERGED", sh("git", "-C", str(self.repo), "rev-parse", "origin/main")]
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("남김", out)

    def test_remote_branch_with_new_commits_is_kept(self):
        path = self.renamed_worktree("dev/proj-b", "proj/b")
        head = sh("git", "-C", str(path), "rev-parse", "HEAD")
        sh("git", "-C", str(self.repo), "worktree", "remove", str(path))
        other = self.tmp / "other"
        sh("git", "clone", "-q", "-b", "proj/b", str(self.tmp / "repo-origin.git"), str(other))
        (other / "more.txt").write_text("x")
        sh("git", "-C", str(other), "add", "-A")
        sh("git", "-C", str(other), "commit", "-q", "-m", "more")
        sh("git", "-C", str(other), "push", "-q", "origin", "proj/b")
        self.prs["proj/b"] = ["MERGED", head]
        out = self.run_sweep("--apply")
        self.assertNotIn("dev/proj-b", self.branches(), out)
        self.assertIn("proj/b", self.remote_branches())
        self.assertIn("끝점이 머지된 커밋과 다르다", out)

    def test_fork_pr_is_not_a_match(self):
        path = self.worktree("feat-k")
        self.prs["feat-k"] = ["MERGED", sh("git", "-C", str(path), "rev-parse", "HEAD"), True]
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)

    # PR 조회가 비거나 깨지면 머지로 읽지 않는다
    def test_empty_pr_lookup_is_no_pr_and_keeps_worktree(self):
        path = self.worktree("feat-l")
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("PR 없음", out)
        self.assertIn("feat-l", self.remote_branches())

    def test_null_text_lookup_is_not_merged(self):
        path = self.worktree("feat-m")
        for name in ("feat-m", "feat/m"):
            self.gh_raw[name] = "null"
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("조회 실패", out)
        self.assertIn("feat-m", self.branches())

    def test_gh_failure_keeps_worktree_and_branches(self):
        path = self.worktree("feat-n")
        self.gh_fail = True
        self.run_sweep("--apply")
        self.assertTrue(path.exists())
        self.assertIn("feat-n", self.branches())

    # 3. Orca 가 worker 반납 뒤 띄운 빈 셸
    def idle_shell(self, path, handle="term_shell", child=False):
        shell = {"pid": 501, "ppid": 1, "cwd": str(path), "command": "-/bin/zsh -l", "terminal": handle}
        rows = [shell] + ([{"pid": 502, "ppid": 501, "cwd": str(path), "command": "sleep 100"}] if child else [])
        return {"handle": handle, "path": str(path), "processes": rows}

    def released_worker_with_shell(self, name, **kw):
        path = self.worktree(name)
        self.squash_merge(name, path)
        self.workers = [{"dispatchId": "ctx_w", "workerState": "succeeded",
                         "resource": {"worktreeId": f"x::{path}", "releaseState": "retained"}}]
        self.spawn_on_release = self.idle_shell(path, **kw)
        return path

    def test_idle_shell_terminal_left_after_release_is_closed_and_worktree_removed(self):
        path = self.released_worker_with_shell("feat-o")
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertNotIn("feat-o", self.branches())
        self.assertIn("orca terminal close --terminal term_shell", self.calls())

    def test_shell_with_a_running_child_is_not_closed(self):
        path = self.released_worker_with_shell("feat-p", child=True)
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertNotIn("terminal close", self.calls())
        self.assertIn("다음 실행에서 다시 시도", out)

    def test_other_process_is_not_treated_as_idle_shell(self):
        path = self.worktree("feat-q")
        self.squash_merge("feat-q", path)
        self.terminals = [{"handle": "term_q", "worktreePath": str(path)}]
        self.processes = [{"pid": 601, "ppid": 1, "cwd": str(path), "command": "node server.js"}]
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertEqual(len(self.sweep_calls("terminal close")), 1)
        self.assertIn("다음 실행에서 다시 시도", out)

    def test_idle_shell_without_orca_terminal_is_left_alone(self):
        path = self.worktree("feat-r")
        self.squash_merge("feat-r", path)
        self.processes = self.idle_shell(path)["processes"]
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertNotIn("terminal close", self.calls())

    def reopened_shell(self, name, child=False, agent=None, scope="bound"):
        """코디네이터가 끝난 worker 터미널을 닫자 Orca 가 그 탭에 빈 셸을 다시 열었다. 모든 Run 범위는 읽지 못한다."""
        path = self.worktree(name)
        self.squash_merge(name, path)
        self.workers = [{"dispatchId": "ctx_w", "workerState": "succeeded", "dispatchStatus": "completed",
                         "agentTerminalHandle": "term_gone", "resource": {"worktreeId": f"x::{path}"}}]
        shell = self.idle_shell(path)
        self.terminals = [{"handle": "term_shell", "worktreePath": str(path), **({"agentIdentity": agent} if agent else {})}]
        self.processes = shell["processes"] + ([{"pid": 502, "ppid": 501, "cwd": str(path), "command": "sleep 100"}] if child else [])
        self.scope = scope
        return path

    def test_reopened_empty_shell_is_closed_and_merged_worktree_is_swept(self):
        path = self.reopened_shell("feat-s1")
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertIn("빈 셸을 닫았다: term_shell", out)
        self.assertEqual(self.calls().count("terminal close --terminal term_shell"), 1)

    def test_reopened_shell_with_a_child_process_is_skipped(self):
        path = self.reopened_shell("feat-s2", child=True)
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("확인하지 못한 터미널 term_shell", out)
        self.assertNotIn("terminal close", self.calls())

    def test_terminal_with_an_agent_or_of_another_run_is_skipped(self):
        path = self.reopened_shell("feat-s3", agent="claude")
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertNotIn("terminal close", self.calls())
        other = self.reopened_shell("feat-s4", scope="all")
        self.all_workers = [{"runId": "run_other", "dispatchId": "ctx_o", "agentTerminalHandle": "term_shell"}]
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(other.exists(), out)
        self.assertIn("다른 Run 의 worker 터미널 term_shell", out)
        self.assertNotIn("terminal close", self.calls())

    def test_reopened_shell_is_not_closed_without_apply(self):
        path = self.reopened_shell("feat-s5")
        out = self.run_sweep("--run", "run_x")
        self.assertTrue(path.exists(), out)
        self.assertIn("빈 셸을 닫을 것: term_shell", out)
        self.assertNotIn("terminal close", self.calls())

    # 3-1. worker 가 끝난 뒤에도 그 경로를 쥔 프로세스 (--kill-holders)
    def finished_worker_with_holders(self, name, state="succeeded"):
        path = self.worktree(name)
        self.squash_merge(name, path)
        self.workers = [{"dispatchId": "ctx_k", "workerState": state, "agentTerminalHandle": "term_gone",
                         "resource": {"worktreeId": f"x::{path}", "releaseState": "released"}}]
        (path / "sub").mkdir()
        self.processes = [
            {"pid": 701, "ppid": 1, "cwd": str(path), "command": "claude --resume"},
            {"pid": 702, "ppid": 1, "cwd": str(path / "sub"), "command": "-/bin/zsh -l", "ignores": ["TERM"]},
            {"pid": 703, "ppid": 1, "cwd": str(path), "command": "node plugin.js"},
            {"pid": 709, "ppid": 1, "cwd": str(path) + "-other", "command": "-/bin/zsh -l"},
        ]
        return path

    def kill_calls(self):
        return [line for line in self.calls().splitlines() if line.startswith("kill ")]

    def remaining_pids(self):
        return {q["pid"] for q in json.loads((self.tmp / "state.json").read_text())["processes"]}

    def test_kill_holders_stops_processes_of_a_finished_worker_and_removes_worktree(self):
        path = self.finished_worker_with_holders("feat-k1")
        out = self.run_sweep("--run", "run_x", "--kill-holders", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertNotIn("feat-k1", self.branches())
        # TERM 을 무시한 로그인 셸에만 HUP 을 보낸다. 이름이 비슷한 다른 경로의 셸은 건드리지 않는다
        self.assertEqual(["kill -TERM 701 702 703", "kill -HUP 702"], self.kill_calls())
        self.assertEqual({709}, self.remaining_pids())

    def test_kill_holders_falls_back_to_kill_when_term_and_hup_are_ignored(self):
        path = self.finished_worker_with_holders("feat-k2")
        self.processes[0]["ignores"] = ["TERM", "HUP"]
        out = self.run_sweep("--run", "run_x", "--kill-holders", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertEqual(["kill -TERM 701 702 703", "kill -HUP 701 702", "kill -KILL 701"], self.kill_calls())

    def test_only_processes_started_by_orca_are_killed(self):
        path = self.finished_worker_with_holders("feat-k7")
        orca = "/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper"
        self.processes = [
            # Orca 터미널: Orca Helper → login → 로그인 셸 → claude
            {"pid": 800, "ppid": 1, "cwd": "/", "command": "/Applications/Orca.app/Contents/MacOS/Orca"},
            {"pid": 801, "ppid": 800, "cwd": "/", "command": orca},
            {"pid": 802, "ppid": 801, "cwd": "/", "command": "/usr/bin/login -fpl user /bin/zsh"},
            {"pid": 803, "ppid": 802, "cwd": str(path), "command": "-/bin/zsh -l"},
            {"pid": 804, "ppid": 803, "cwd": str(path), "command": "claude"},
            # iTerm 에서 그 폴더로 들어간 사용자 셸과, 편집기가 띄운 language server
            {"pid": 810, "ppid": 1, "cwd": "/", "command": "/Applications/iTerm.app/Contents/MacOS/iTerm2"},
            {"pid": 811, "ppid": 810, "cwd": "/", "command": "/usr/bin/login -fpl user /bin/zsh"},
            {"pid": 812, "ppid": 811, "cwd": str(path), "command": "-/bin/zsh -l"},
            {"pid": 820, "ppid": 1, "cwd": "/", "command": "/Applications/Code.app/Contents/MacOS/Code"},
            {"pid": 821, "ppid": 820, "cwd": str(path), "command": "node tsserver.js"},
        ]
        out = self.run_sweep("--run", "run_x", "--kill-holders", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertEqual(["kill -TERM 803 804"], self.kill_calls())
        self.assertIn("Orca 밖에서 띄웠거나", out)
        self.assertTrue({812, 821} <= self.remaining_pids())

    def test_sweep_itself_and_nested_worktree_users_are_not_killed(self):
        path = self.worktree("feat-k8")
        (path / ".gitignore").write_text("nested/\n")
        sh("git", "-C", str(path), "add", "-A")
        sh("git", "-C", str(path), "commit", "-q", "-m", "ignore nested")
        sh("git", "-C", str(path), "push", "-q")
        self.squash_merge("feat-k8", path)
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "-b", "other-k8", str(path / "nested"), "origin/main")
        self.workers = [{"dispatchId": "ctx_k", "workerState": "succeeded", "agentTerminalHandle": "term_gone",
                         "resource": {"worktreeId": f"x::{path}", "releaseState": "released"}}]
        self.processes = [
            {"pid": "SWEEP", "ppid": 1, "cwd": str(path), "command": "python3 cleanup-sweep.py"},
            {"pid": 851, "ppid": 1, "cwd": str(path / "nested"), "command": "claude"},
            {"pid": 852, "ppid": 1, "cwd": str(path), "command": "node plugin.js"},
        ]
        out = self.run_sweep("--run", "run_x", "--kill-holders", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertEqual(["kill -TERM 852"], self.kill_calls())
        self.assertIn(851, self.remaining_pids())
        self.assertIn("다음 실행에서 다시 시도", out)

    def test_session_end_hook_is_left_to_remove_worktree(self):
        # OMC session-end hook 만 남으면 건너뛰지 않고 remove-worktree.sh 에 넘긴다. 그 스크립트가 끝날 때까지 기다린다
        path = self.worktree("feat-h1")
        self.squash_merge("feat-h1", path)
        self.processes = [{"pid": 861, "ppid": 1, "cwd": str(path), "command": HOOK}]
        self.env["ORCH_HOOK_WAIT"] = "0"
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("OMC session-end hook 861 은 끄지 않는다", out)
        self.assertIn("session-end hook 861 는 스스로 끝난다", out)
        self.assertNotIn("다음 실행에서 다시 시도", out)

    def test_kill_holders_does_not_kill_session_end_hook(self):
        path = self.finished_worker_with_holders("feat-h2")
        self.processes.append({"pid": 862, "ppid": 1, "cwd": str(path), "command": HOOK})
        self.env["ORCH_HOOK_WAIT"] = "0"
        out = self.run_sweep("--run", "run_x", "--kill-holders", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertTrue(all("862" not in call for call in self.kill_calls()), self.kill_calls())
        self.assertIn(862, self.remaining_pids())

    def test_holders_are_not_killed_without_the_option(self):
        path = self.finished_worker_with_holders("feat-k3")
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertEqual([], self.kill_calls())
        self.assertIn("다음 실행에서 다시 시도", out)

    def test_holders_are_not_killed_without_a_known_finished_dispatch(self):
        path = self.finished_worker_with_holders("feat-k4")
        out = self.run_sweep("--kill-holders", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("그 경로의 worker 를 모른다", out)
        for state in ("failed", "abandoned"):
            self.workers[0]["workerState"] = state
            out = self.run_sweep("--run", "run_x", "--kill-holders", "--apply")
            self.assertTrue(path.exists(), out)
            self.assertIn("끝나지 않은 dispatch ctx_k", out)
        self.assertEqual([], self.kill_calls())

    def test_holders_are_not_killed_while_an_orca_terminal_stays_at_the_path(self):
        path = self.finished_worker_with_holders("feat-k5")
        # 닫기 명령이 성공을 돌려줘도 터미널이 남은 경우를 흉내 낸다
        self.terminals = [{"handle": "term_stuck", "worktreePath": str(path)}]
        self.orca_close_noop = True
        out = self.run_sweep("--run", "run_x", "--kill-holders", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("Orca 터미널이 남아 있거나", out)
        self.assertEqual([], self.kill_calls())

    def test_kill_holders_dry_run_sends_no_signal(self):
        path = self.finished_worker_with_holders("feat-k6")
        # 실제 실행은 MERGED 면 이 터미널을 먼저 닫으므로 dry-run 도 끈다고 낸다
        self.terminals = [{"handle": "term_k6", "worktreePath": str(path)}]
        out = self.run_sweep("--run", "run_x", "--kill-holders")
        self.assertTrue(path.exists(), out)
        self.assertIn("TERM, HUP, KILL 순으로 끈다", out)
        self.assertEqual([], self.kill_calls())

    # 4. 저장소 여러 개
    def test_several_repos_are_swept_in_one_run(self):
        second = self.make_repo("second")
        a = self.worktree("feat-s1")
        b = self.worktree("feat-s2", repo=second)
        self.squash_merge("feat-s1", a)
        sh("git", "-C", str(second), "push", "-q", "origin", "--delete", "feat-s2")
        self.prs["feat-s2"] = ["MERGED", sh("git", "-C", str(b), "rev-parse", "HEAD")]
        out = self.run_sweep("--apply", repos=[self.repo, second])
        self.assertFalse(a.exists(), out)
        self.assertFalse(b.exists(), out)
        self.assertIn(str(second), out)
        self.assertEqual(self.calls().count("terminal list"), 1)

    def test_unreadable_repo_does_not_stop_the_others(self):
        a = self.worktree("feat-t")
        self.squash_merge("feat-t", a)
        out = self.run_sweep("--apply", repos=[self.tmp / "missing", self.repo], code=2)
        self.assertFalse(a.exists(), out)

    # 5. 워크트리 없는 로컬 브랜치와 원격 브랜치
    def test_merged_local_branch_without_worktree_deletes_renamed_remote_branch(self):
        path = self.renamed_worktree("dev/proj-c", "proj/c")
        head = sh("git", "-C", str(path), "rev-parse", "HEAD")
        sh("git", "-C", str(self.repo), "worktree", "remove", str(path))
        self.prs["proj/c"] = ["MERGED", head]
        out = self.run_sweep("--apply")
        self.assertNotIn("dev/proj-c", self.branches(), out)
        self.assertNotIn("proj/c", self.remote_branches())

    def test_remote_branch_that_is_a_base_of_an_open_pr_is_kept(self):
        path = self.worktree("feat-u")
        head = sh("git", "-C", str(path), "rev-parse", "HEAD")
        sh("git", "-C", str(self.repo), "worktree", "remove", str(path))
        self.prs["feat-u"] = ["MERGED", head]
        self.open_bases = ["feat-u"]
        out = self.run_sweep("--apply")
        self.assertIn("feat-u", self.branches(), out)
        self.assertIn("feat-u", self.remote_branches())

    # 6. 예전에 머지된 PR 과 이름만 같은 새 브랜치
    def old_merged_pr(self, name):
        """그 이름의 PR 이 예전에 squash 머지되고 브랜치와 워크트리가 지워진 상태. 옛 PR HEAD 를 돌려준다."""
        old = self.worktree(name)
        head = self.squash_merge(name, old)
        sh("git", "-C", str(self.repo), "worktree", "remove", str(old))
        sh("git", "-C", str(self.repo), "branch", "-D", name)
        main = self.tmp / "main-clone"
        sh("git", "clone", "-q", str(self.tmp / "repo-origin.git"), str(main))
        (main / "squash.txt").write_text(name)
        sh("git", "-C", str(main), "add", "-A")
        sh("git", "-C", str(main), "commit", "-q", "-m", f"squash {name}")
        sh("git", "-C", str(main), "push", "-q", "origin", "main")
        sh("git", "-C", str(self.repo), "fetch", "-q", "origin")
        shutil.rmtree(main)
        return head

    def test_new_branch_with_the_name_of_an_old_merged_pr_is_kept(self):
        self.old_merged_pr("feature/x")
        path = self.worktree("feature/x", commits=0)
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("feature/x", self.branches())
        self.assertIn("feature/x", self.remote_branches())
        self.assertIn("이름만 같은 PR", out)
        self.assertNotIn("--merged-head", self.calls())

    def test_new_branch_with_own_commits_and_old_pr_name_is_kept(self):
        self.old_merged_pr("feature/x")
        path = self.worktree("feature/x", push=False)
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("이름만 같은 PR", out)

    def test_new_branch_from_stale_base_with_old_pr_name_is_kept(self):
        # 갱신하지 않은 base 에서 만든 브랜치의 끝 커밋은 옛 PR HEAD 의 조상이다. base 위 커밋이 0 개라 새 브랜치로 본다
        stale = sh("git", "-C", str(self.repo), "rev-parse", "origin/main")
        self.old_merged_pr("feature/x")
        path = self.wts / "feature-x-new"
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "-b", "feature/x", str(path), stale)
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("feature/x", self.branches())

    def test_merge_commit_pr_whose_head_is_the_branch_tip_is_cleaned(self):
        # 일반 merge 는 브랜치 커밋이 base 에 들어가 base 위 커밋이 0 개가 된다. 끝 커밋이 PR HEAD 와 같으면 머지로 본다
        path = self.worktree("feat-v")
        head = sh("git", "-C", str(path), "rev-parse", "HEAD")
        sh("git", "-C", str(self.repo), "merge", "-q", "--no-ff", "-m", "merge v", "feat-v")
        sh("git", "-C", str(self.repo), "push", "-q", "origin", "main")
        self.prs["feat-v"] = ["MERGED", head]
        out = self.run_sweep("--apply")
        self.assertFalse(path.exists(), out)
        self.assertNotIn("feat-v", self.branches())

    def test_remove_worktree_refuses_head_that_is_not_an_ancestor_of_merged_head(self):
        head = self.old_merged_pr("feature/x")
        path = self.worktree("feature/x", commits=0)
        self.save_state()
        env = dict(self.env, PATH=f"{self.bin}:{os.environ['PATH']}")
        remove = SCRIPT.parent / "remove-worktree.sh"
        done = subprocess.run(["zsh", str(remove), str(path), "--delete-branch", "--merged-head", head],
                              capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("조상도 아니다", done.stdout)
        self.assertTrue(path.exists())


    # 5. 저장소 밖 detached 워크트리
    def detached(self, name, push=True):
        """임시 폴더에 만든 detached 워크트리. push=False 면 HEAD 가 원격에 없는 커밋이다."""
        path = self.tmp / "scratch" / name
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "--detach", str(path), "origin/main")
        if not push:
            sh("git", "-C", str(path), "commit", "-q", "--allow-empty", "-m", "local only")
        return path

    def test_detached_worktree_outside_repo_is_removed(self):
        path = self.detached("baseline")
        out = self.run_sweep("--apply")
        self.assertFalse(path.exists(), out)
        self.assertIn("detached 워크트리 삭제", out)
        self.assertNotIn(str(path), sh("git", "-C", str(self.repo), "worktree", "list"))

    def test_detached_dry_run_keeps_it(self):
        path = self.detached("baseline-dry")
        out = self.run_sweep()
        self.assertTrue(path.exists())
        self.assertIn("detached 워크트리를 지울 것", out)

    def test_detached_with_changes_process_terminal_or_local_commit_is_kept(self):
        dirty = self.detached("d-dirty")
        (dirty / "x.txt").write_text("x")
        held = self.detached("d-held")
        self.held = [str(held)]
        term = self.detached("d-term")
        self.terminals = [{"handle": "term_d", "worktreePath": str(term)}]
        local = self.detached("d-local", push=False)
        out = self.run_sweep("--apply")
        for path in (dirty, held, term, local):
            self.assertTrue(path.exists(), out)
        self.assertIn(f"건너뜀 detached {dirty}: 커밋 안 된 변경", out)
        self.assertIn(f"건너뜀 detached {held}: 그 경로를 쓰는 프로세스", out)
        self.assertIn(f"건너뜀 detached {term}: Orca 터미널이 있다", out)
        self.assertIn(f"건너뜀 detached {local}: HEAD 가 원격에 없다", out)

    def test_detached_inside_repo_is_left_alone(self):
        path = self.repo / "worktrees" / "repo" / "tmp-check"
        sh("git", "-C", str(self.repo), "worktree", "add", "-q", "--detach", str(path), "origin/main")
        out = self.run_sweep("--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("브랜치가 없다(detached)", out)

    def test_registration_of_a_deleted_folder_is_pruned_first(self):
        path = self.detached("gone")
        shutil.rmtree(path)
        dry = self.run_sweep()
        self.assertIn("prune: Removing worktrees/gone", dry)
        self.assertIn(str(path), sh("git", "-C", str(self.repo), "worktree", "list"))
        out = self.run_sweep("--apply")
        self.assertIn("prune: Removing worktrees/gone", out)
        self.assertNotIn(str(path), sh("git", "-C", str(self.repo), "worktree", "list"))

    # 6. 하위 에이전트 워크트리의 빈 셸 터미널
    def agent_with_shell(self, name, child=False):
        path = self.worktree(name)
        self.squash_merge(name, path)
        shell = self.idle_shell(path, handle="term_agent", child=child)
        self.terminals = [{"handle": "term_agent", "worktreePath": str(path)}]
        self.processes = shell["processes"]
        # 모든 Run 범위를 읽지 못해 이 터미널이 누구 것인지 모른다
        self.scope = "bound"
        return path

    def test_idle_shell_of_agent_worktree_is_closed_when_runs_cannot_be_listed(self):
        path = self.agent_with_shell("agent-a1")
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertIn("하위 에이전트 워크트리의 빈 셸 터미널", out)
        self.assertIn("orca terminal close --terminal term_agent", self.calls())

    def test_agent_terminal_with_a_running_child_is_kept(self):
        path = self.agent_with_shell("agent-a2", child=True)
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("확인하지 못한 터미널 term_agent", out)
        self.assertNotIn("terminal close", self.calls())

    def test_idle_shell_outside_agent_glob_is_still_unknown(self):
        path = self.agent_with_shell("feat-a3")
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("확인하지 못한 터미널 term_agent", out)

    def test_agent_glob_option_changes_the_pattern(self):
        path = self.agent_with_shell("sub-a4")
        out = self.run_sweep("--run", "run_x", "--agent-glob", "sub-*", "--apply")
        self.assertFalse(path.exists(), out)

    def test_agent_path_with_known_foreign_worker_terminal_is_kept(self):
        path = self.agent_with_shell("agent-a5")
        self.scope = "all"
        self.all_workers = [{"runId": "run_other", "dispatchId": "ctx_o", "agentTerminalHandle": "term_agent"}]
        out = self.run_sweep("--run", "run_x", "--apply")
        self.assertTrue(path.exists(), out)
        self.assertIn("다른 Run 의 worker 터미널 term_agent", out)

    def merged_with_specs(self, name):
        path = self.worktree(name)
        self.squash_merge(name, path)
        specs = self.repo / ".omc/orch/specs"
        specs.mkdir(parents=True)
        (specs / f"spec-{name}.md").write_text("x")
        return path, specs

    def test_spec_of_a_live_dispatch_is_kept(self):
        # 브랜치가 머지돼도 그 지시서로 아직 일하는 worker 가 있다
        path, specs = self.merged_with_specs("feat-live")
        spec = specs / "spec-feat-live.md"
        self.tasks = [{"id": "task_1", "status": "dispatched", "spec": f"지시서 {spec} 를 끝까지 읽고 수행한다."}]
        out = self.run_sweep("--specs-dir", ".omc/orch/specs", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertTrue(spec.exists(), out)
        self.assertIn("살아 있는 dispatch 가 쓴다", out)

    def test_spec_of_a_finished_task_is_deleted(self):
        path, specs = self.merged_with_specs("feat-done")
        spec = specs / "spec-feat-done.md"
        self.tasks = [{"id": "task_1", "status": "completed", "spec": f"지시서 {spec} 를 끝까지 읽고 수행한다."}]
        self.run_sweep("--specs-dir", ".omc/orch/specs", "--apply")
        self.assertFalse(spec.exists())

    def test_specs_are_kept_when_live_dispatches_cannot_be_read(self):
        path, specs = self.merged_with_specs("feat-unknown")
        self.tasks_fail = True
        out = self.run_sweep("--specs-dir", ".omc/orch/specs", "--apply")
        self.assertFalse(path.exists(), out)
        self.assertTrue((specs / "spec-feat-unknown.md").exists())
        self.assertIn("목록을 읽지 못했다", out)

    def test_pr_body_files_next_to_the_specs_dir_are_deleted(self):
        path = self.worktree("mac/body")
        self.squash_merge("mac/body", path)
        orch = self.repo / ".omc/orch"
        (orch / "specs").mkdir(parents=True)
        for name in ("pr-body.md", "pr-mac-body.md", "pr-1.md", "pr-other.md"):
            (orch / name).write_text("x")
        out = self.run_sweep("--specs-dir", ".omc/orch/specs")
        self.assertIn(f"PR 본문을 지울 것 {orch / 'pr-mac-body.md'}", out)
        self.run_sweep("--specs-dir", ".omc/orch/specs", "--apply")
        self.assertEqual(["pr-other.md"], sorted(p.name for p in orch.glob("pr-*.md")))

    def test_base_checkout_is_fast_forwarded(self):
        other = self.tmp / "other"
        sh("git", "clone", "-q", str(self.tmp / "repo-origin.git"), str(other))
        sh("git", "-C", str(other), "commit", "-q", "--allow-empty", "-m", "ahead")
        sh("git", "-C", str(other), "push", "-q", "origin", "main")
        remote = sh("git", "-C", str(other), "rev-parse", "HEAD")
        out = self.run_sweep()
        self.assertIn("fast-forward 할 것 main", out)
        self.assertNotEqual(remote, sh("git", "-C", str(self.repo), "rev-parse", "HEAD"))
        out = self.run_sweep("--apply")
        self.assertIn("기준 브랜치 fast-forward main", out)
        self.assertEqual(remote, sh("git", "-C", str(self.repo), "rev-parse", "HEAD"))

    def test_base_checkout_with_local_commits_is_left_alone(self):
        sh("git", "-C", str(self.repo), "commit", "-q", "--allow-empty", "-m", "local")
        head = sh("git", "-C", str(self.repo), "rev-parse", "HEAD")
        out = self.run_sweep("--apply")
        self.assertIn("origin/main 에 없는 커밋이 있다", out)
        self.assertEqual(head, sh("git", "-C", str(self.repo), "rev-parse", "HEAD"))


if __name__ == "__main__":
    unittest.main()
