"""plan_number.sh 가 접두사와 tasks 경로를 세는지 실제 git 저장소로 검증한다."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "plan_number.sh"
# 사용자 전역 설정(서명, 훅 경로)이 테스트 저장소에 끼어들지 않게 한다.
ENV = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}


class PlanNumberTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.remote, self.repo = root / "remote.git", root / "repo"
        self.git(root, "init", "--quiet", "--bare", "-b", "main", str(self.remote))
        self.git(root, "clone", "--quiet", str(self.remote), str(self.repo))
        self.git(self.repo, "checkout", "--quiet", "-b", "main")
        self.git(self.repo, "config", "user.email", "t@example.com")
        self.git(self.repo, "config", "user.name", "t")
        self.commit("README.md", "init")

    def git(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True, capture_output=True, text=True).stdout

    def commit(self, rel, message):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
        self.git(self.repo, "add", "-A")
        self.git(self.repo, "commit", "--quiet", "-m", message)

    def remove(self, rel, message):
        self.git(self.repo, "rm", "-r", "--quiet", rel)
        self.git(self.repo, "commit", "--quiet", "-m", message)

    def run_script(self, *args):
        self.git(self.repo, "push", "--quiet", "-u", "origin", "HEAD")
        result = subprocess.run(["bash", str(SCRIPT), *args], cwd=self.repo, env=ENV, capture_output=True, text=True)
        return result.returncode, result.stdout

    def test_default_counts_tree_like_before(self):
        self.commit("tasks/plan1-a/index.json", "plan1")
        self.commit("tasks/plan2-b/index.json", "plan2")
        code, out = self.run_script()
        self.assertEqual(code, 0, out)
        self.assertEqual(out.splitlines()[-1], "다음 번호: 3")

    def test_positional_tasks_dir_is_still_accepted(self):
        self.commit("work/plan4-a/index.json", "plan4")
        code, out = self.run_script("work")
        self.assertEqual((code, out.splitlines()[-1]), (0, "다음 번호: 5"))

    def test_prefix_counts_only_its_own_sequence(self):
        self.commit("tasks/fe-plan026-a/index.json", "fe")
        self.commit("tasks/be-plan040-b/index.json", "be")
        self.commit("tasks/plan090-c/index.json", "legacy")
        code, out = self.run_script("--prefix", "fe-")
        self.assertEqual(out.splitlines()[-1], "다음 번호: 27", out)
        self.assertNotIn("be-plan", out)

    def test_no_prefix_ignores_prefixed_plans(self):
        self.commit("tasks/fe-plan050-a/index.json", "fe")
        self.commit("tasks/plan3-c/index.json", "legacy")
        code, out = self.run_script()
        self.assertEqual(out.splitlines()[-1], "다음 번호: 4", out)

    def test_zero_padded_number_is_decimal(self):
        # 앞의 0 을 셸 산술에 그대로 넘기면 8진수로 읽혀 plan010 다음이 9 가 된다.
        self.commit("tasks/plan010-a/index.json", "plan010")
        code, out = self.run_script()
        self.assertEqual(out.splitlines()[-1], "다음 번호: 11", out)

    def test_subdirectory_tasks_dir_with_prefix(self):
        self.commit("backend/tasks/be-plan002-a/index.json", "be")
        self.commit("frontend/tasks/be-plan009-x/index.json", "다른 디렉터리")
        code, out = self.run_script("--tasks-dir", "backend/tasks/", "--prefix", "be-")
        self.assertEqual(out.splitlines()[-1], "다음 번호: 3", out)

    def test_unmerged_branch_is_reported(self):
        self.commit("tasks/plan1-a/index.json", "plan1")
        self.git(self.repo, "push", "--quiet", "-u", "origin", "main")
        self.git(self.repo, "checkout", "--quiet", "-b", "plan2-b")
        self.commit("tasks/plan2-b/index.json", "plan2")
        self.git(self.repo, "push", "--quiet", "-u", "origin", "plan2-b")
        self.git(self.repo, "checkout", "--quiet", "main")
        self.git(self.repo, "branch", "--quiet", "-D", "plan2-b")
        code, out = self.run_script()
        self.assertIn("밖에만 있다", out)
        self.assertEqual(out.splitlines()[-1], "다음 번호: 3")

    def test_invalid_prefix_is_rejected(self):
        code, _ = self.run_script("--prefix", "fe.*")
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
