#!/usr/bin/env python3
"""plan_precheck 의 판정 함수 검사."""

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "plan_precheck", Path(__file__).resolve().parents[1] / "scripts" / "plan_precheck.py"
)
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)


def branch(exists=True, impl=None, merged=False, name="plan001-x"):
    f = {"branch": name, "remote_exists": exists}
    if exists:
        f["impl_files"] = impl or []
        f["has_impl_commits"] = bool(impl)
        f["merged_into_main"] = merged
    return f


class TestJudge(unittest.TestCase):
    def test_pending_clean_branch_passes(self):
        found = pc.judge({"status": "pending"}, branch(), [])
        self.assertEqual(found, [])

    def test_completed_is_flagged(self):
        found = pc.judge({"status": "completed"}, branch(merged=True), [])
        self.assertTrue(any("completed" in f for f in found))

    def test_completed_but_unmerged_is_flagged(self):
        found = pc.judge({"status": "completed"}, branch(merged=False), [])
        self.assertTrue(any("머지되지 않았다" in f for f in found))

    def test_completed_with_deleted_branch_still_flags_completion(self):
        """머지 후 브랜치를 지운 것이 가장 흔한 재실행 사례다."""
        found = pc.judge({"status": "completed"}, branch(exists=False), [])
        self.assertTrue(any("completed" in f for f in found))
        self.assertTrue(any("머지 후 정리된" in f for f in found))

    def test_missing_branch_for_pending_points_at_planning(self):
        found = pc.judge({"status": "pending"}, branch(exists=False), [])
        self.assertTrue(any("planning 이 push 하지 않았거나" in f for f in found))

    def test_impl_commits_are_flagged(self):
        found = pc.judge({"status": "pending"}, branch(impl=["src/a.ts"]), [])
        self.assertTrue(any("src/a.ts" in f for f in found))

    def test_planning_only_changes_are_not_impl(self):
        b = branch()
        b["impl_files"] = []
        b["has_impl_commits"] = False
        self.assertEqual(pc.judge({"status": "pending"}, b, []), [])

    def test_open_pr_is_flagged(self):
        found = pc.judge(
            {"status": "pending"}, branch(),
            [{"number": 7, "title": "t", "url": "u"}],
        )
        self.assertTrue(any("#7" in f for f in found))

    def test_cancelled_reports_reason(self):
        found = pc.judge(
            {"status": "cancelled", "blocked_reason": "설계 변경"}, branch(), []
        )
        self.assertTrue(any("설계 변경" in f for f in found))

    def test_failed_without_reason_says_so(self):
        found = pc.judge({"status": "failed"}, branch(), [])
        self.assertTrue(any("사유 없음" in f for f in found))


class TestFindLocal(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        for name in ("plan001-alpha", "plan002-beta", "plan0020-gamma"):
            d = self.repo / "tasks" / name
            d.mkdir(parents=True)
            (d / "index.json").write_text("{}")

    def tearDown(self):
        self.tmp.cleanup()

    def test_exact_name(self):
        self.assertEqual(pc.find_local(self.repo, "plan001-alpha").name, "plan001-alpha")

    def test_prefix_needs_a_hyphen(self):
        """plan002 가 plan0020 까지 잡으면 엉뚱한 plan 을 돌린다."""
        self.assertEqual(pc.find_local(self.repo, "plan002").name, "plan002-beta")

    def test_no_match_returns_none(self):
        self.assertIsNone(pc.find_local(self.repo, "plan999"))

    def test_no_tasks_dir_returns_none(self):
        import tempfile
        with tempfile.TemporaryDirectory() as empty:
            self.assertIsNone(pc.find_local(Path(empty), "plan001"))


class TestMonorepo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        for rel in ("tasks/fe-plan027-login", "tasks/be-plan027-login", "backend/tasks/be-plan003-x"):
            d = self.repo / rel
            d.mkdir(parents=True)
            (d / "index.json").write_text("{}")

    def test_prefixed_plan_is_found_by_its_prefix(self):
        self.assertEqual(pc.find_local(self.repo, "fe-plan027").name, "fe-plan027-login")

    def test_other_prefix_with_same_number_is_not_matched(self):
        # 접두사를 떼고 번호만 맞추면 be-plan027 이 fe-plan027 자리에 잡힌다.
        self.assertIsNone(pc.find_local(self.repo, "plan027"))

    def test_tasks_dir_under_subproject(self):
        self.assertEqual(pc.find_local(self.repo, "be-plan003", "backend/tasks").name, "be-plan003-x")
        self.assertIsNone(pc.find_local(self.repo, "be-plan003"))

    def test_subproject_docs_are_planning_not_implementation(self):
        def command(args, cwd):
            if args[1] == "ls-remote":
                return "abc\trefs/heads/plan/fe-027-login"
            if args[1] == "diff":
                return "tasks/fe-plan027-login/phase-01.md\nfrontend/docs/flow.md\nfrontend/src/app.ts"
            return ""
        with patch.object(pc, "run", side_effect=command):
            facts = pc.branch_facts(Path("."), "plan/fe-027-login", "main", ("tasks/", "frontend/docs/"))
        self.assertEqual(facts["impl_files"], ["frontend/src/app.ts"])

    def test_default_prefixes_treat_subproject_docs_as_implementation(self):
        # 기본값은 이전과 같다. 루트 docs/ 만 기획으로 본다.
        def command(args, cwd):
            if args[1] == "ls-remote":
                return "abc\trefs/heads/x"
            if args[1] == "diff":
                return "docs/flow.md\nfrontend/docs/flow.md"
            return ""
        with patch.object(pc, "run", side_effect=command):
            facts = pc.branch_facts(Path("."), "x", "main")
        self.assertEqual(facts["impl_files"], ["frontend/docs/flow.md"])


@patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"})
class TestDeletedPlan(unittest.TestCase):
    """구현이 끝나 지운 계획서를 git 이력에서 찾는다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.git("init", "--quiet", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout

    def add(self, rel):
        path = self.repo / rel / "index.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}")
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", f"add {rel}")

    def delete(self, rel):
        self.git("rm", "-r", "--quiet", rel)
        self.git("commit", "--quiet", "-m", f"delete {rel}")
        return self.git("rev-parse", "--short", "HEAD").strip()

    def test_deleted_plan_is_found_by_prefix(self):
        self.add("tasks/plan002-beta")
        commit = self.delete("tasks/plan002-beta")
        self.assertEqual(pc.find_deleted(self.repo, "plan002"), ("plan002-beta", commit))

    def test_deleted_on_unmerged_branch_is_found(self):
        self.add("tasks/plan003-x")
        self.git("checkout", "--quiet", "-b", "plan003-x")
        commit = self.delete("tasks/plan003-x")
        self.git("checkout", "--quiet", "main")
        self.assertEqual(pc.find_deleted(self.repo, "plan003-x"), ("plan003-x", commit))

    def test_live_plan_is_not_deleted(self):
        self.add("tasks/plan004-live")
        self.assertIsNone(pc.find_deleted(self.repo, "plan004"))

    def test_similar_number_and_other_prefix_do_not_match(self):
        self.add("tasks/plan0020-gamma")
        self.add("tasks/be-plan002-x")
        self.delete("tasks")
        self.assertIsNone(pc.find_deleted(self.repo, "plan002"))
        self.assertEqual(pc.find_deleted(self.repo, "be-plan002")[0], "be-plan002-x")

    def run_main(self, plan):
        import contextlib, io, sys
        facts = {"branch": plan, "remote_exists": False, "base": "main"}
        with patch.object(pc, "resolve_base", return_value="main"), patch.object(pc, "branch_facts", return_value=facts), \
                patch.object(sys, "argv", ["plan_precheck.py", plan, "--repo", str(self.repo)]), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            code = pc.main()
        return code, out.getvalue() + err.getvalue()

    def test_main_reports_deleted_plan_as_user_decision(self):
        self.add("tasks/plan005-done")
        self.delete("tasks/plan005-done")
        code, out = self.run_main("plan005")
        self.assertEqual(code, 1, out)
        self.assertIn("지운 계획서", out)

    def test_main_unknown_plan_is_still_execution_error(self):
        self.add("tasks/plan006-live")
        code, out = self.run_main("plan007")
        self.assertEqual(code, 2, out)
        self.assertIn("planning 을 먼저", out)

    def test_tasks_dir_under_subproject(self):
        self.add("frontend/tasks/fe-plan001-a")
        self.delete("frontend/tasks/fe-plan001-a")
        self.assertIsNone(pc.find_deleted(self.repo, "fe-plan001"))
        self.assertEqual(pc.find_deleted(self.repo, "fe-plan001", "frontend/tasks")[0], "fe-plan001-a")


class TestBaseBranch(unittest.TestCase):
    def test_explicit_base_overrides_git_setting(self):
        with patch.object(pc, "try_run") as optional, patch.object(pc, "run") as run:
            self.assertEqual(pc.resolve_base(Path("."), "develop"), "develop")
            optional.assert_not_called()
            run.assert_called_once_with(["git", "check-ref-format", "--branch", "develop"], Path("."))

    def test_git_setting_overrides_remote_default(self):
        with patch.object(pc, "try_run", return_value="develop"), patch.object(pc, "run") as run:
            self.assertEqual(pc.resolve_base(Path(".")), "develop")
            self.assertEqual(run.call_count, 1)

    def test_remote_default_can_be_trunk(self):
        with patch.object(pc, "try_run", return_value=None), patch.object(pc, "run", side_effect=["ref: refs/heads/trunk\tHEAD\nabc\tHEAD", ""]):
            self.assertEqual(pc.resolve_base(Path(".")), "trunk")

    def test_unknown_base_is_execution_error(self):
        with patch.object(pc, "try_run", return_value=None), patch.object(pc, "run", return_value="abc\tHEAD"):
            with self.assertRaises(pc.PrecheckError):
                pc.resolve_base(Path("."))

    def test_develop_diff_excludes_changes_already_on_base(self):
        def command(args, cwd):
            if args[1] == "ls-remote":
                return "abc\trefs/heads/feature/app"
            if args[1] == "diff":
                self.assertIn("origin/develop...FETCH_HEAD", args)
                return "tasks/plan1/phase-01.md\ndocs/flow.md"
            if args[1] == "branch":
                return "origin/develop"
            return ""
        with patch.object(pc, "run", side_effect=command):
            facts = pc.branch_facts(Path("."), "feature/app", "develop")
        self.assertFalse(facts["has_impl_commits"])
        self.assertTrue(facts["merged_into_base"])
        self.assertEqual(facts["base"], "develop")

    def test_diff_failure_is_not_clean_branch(self):
        def command(args, cwd):
            if args[1] == "ls-remote":
                return "abc\trefs/heads/feature/app"
            if args[1] == "diff":
                raise pc.PrecheckError("비교 기준이 없다")
            return ""
        with patch.object(pc, "run", side_effect=command):
            with self.assertRaises(pc.PrecheckError):
                pc.branch_facts(Path("."), "feature/app", "develop")

    def test_completed_uses_develop_merge_fact(self):
        facts = {"branch": "feature/app", "remote_exists": True, "base": "develop", "merged_into_base": True}
        self.assertFalse(any("머지되지 않았다" in f for f in pc.judge({"status": "completed"}, facts, [])))

    def test_git_setting_is_read_from_repository_only(self):
        with patch.object(pc, "try_run", return_value=None) as optional, patch.object(pc, "run", side_effect=["ref: refs/heads/main\tHEAD", ""]):
            pc.resolve_base(Path("."))
            optional.assert_called_once_with(["git", "config", "--local", "--get", "build-with-teams.baseBranch"], Path("."))

    # 사용자 전역 설정의 build-with-teams.baseBranch 나 init.defaultBranch 가 결과를 바꾸지 않게 한다.
    @patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"})
    def test_real_git_remote_uses_develop_and_detects_later_implementation(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            root = Path(tmp)
            repo, remote = root / "repo", root / "remote.git"
            repo.mkdir()

            def git(*args):
                return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)

            git("init", "--quiet", "-b", "main")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Test")
            (repo / "README.md").write_text("initial\n")
            git("add", ".")
            git("commit", "--quiet", "-m", "initial")
            git("checkout", "--quiet", "-b", "develop")
            (repo / "src").mkdir()
            (repo / "src" / "app.py").write_text("existing implementation\n")
            git("add", ".")
            git("commit", "--quiet", "-m", "develop implementation")
            git("checkout", "--quiet", "-b", "feature/app")
            (repo / "docs").mkdir()
            (repo / "docs" / "flow.md").write_text("new plan\n")
            git("add", ".")
            git("commit", "--quiet", "-m", "planning")
            git("clone", "--quiet", "--bare", str(repo), str(remote))
            subprocess.run(["git", "--git-dir", str(remote), "symbolic-ref", "HEAD", "refs/heads/develop"], check=True, capture_output=True)
            git("remote", "add", "origin", str(remote))
            base = pc.resolve_base(repo)
            self.assertEqual(base, "develop")
            self.assertTrue(pc.branch_facts(repo, "feature/app", "main")["has_impl_commits"])
            self.assertFalse(pc.branch_facts(repo, "feature/app", base)["has_impl_commits"])
            (repo / "src" / "app.py").write_text("changed implementation\n")
            git("add", ".")
            git("commit", "--quiet", "-m", "implementation")
            git("push", "--quiet", "origin", "feature/app")
            facts = pc.branch_facts(repo, "feature/app", base)
            self.assertEqual(facts["impl_files"], ["src/app.py"])


if __name__ == "__main__":
    unittest.main()
