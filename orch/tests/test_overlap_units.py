"""overlap_units.py 의 판정은 순수 함수로, git 연동은 임시 저장소로 검증한다.

예시 경로는 가상의 모노레포(`modules/api/`, `modules/common/`)다.
"""

import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "overlap_units.py"
SPEC = importlib.util.spec_from_file_location("overlap_units", SCRIPT)
ou = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ou)

SHARED = r"^(modules/common/|build\.gradle$|\.github/)"
DOCS = ["docs/*", "*.md"]


def judge(pr, base, **kw):
    kw.setdefault("shared_paths", SHARED)
    kw.setdefault("docs_globs", DOCS)
    return ou.judge(pr, base, **kw)


class UnitOfTest(unittest.TestCase):
    def test_module_folder_is_the_unit(self):
        self.assertEqual("api", ou.unit_of("modules/api/src/Main.java", "modules/"))
        self.assertEqual("api", ou.unit_of("modules/api/build.gradle", "modules/"))

    def test_other_files_are_their_own_unit(self):
        self.assertEqual("README.txt", ou.unit_of("README.txt", "modules/"))
        self.assertEqual("scripts/run.sh", ou.unit_of("scripts/run.sh", "modules/"))
        self.assertEqual("modules/loose.txt", ou.unit_of("modules/loose.txt", "modules/"))

    def test_prefix_is_a_folder_boundary(self):
        self.assertEqual("modules-old/api/x", ou.unit_of("modules-old/api/x", "modules"))
        self.assertEqual("api", ou.unit_of("modules/api/x", "modules"))

    def test_custom_prefix(self):
        self.assertEqual("web", ou.unit_of("apps/web/src/a.ts", "apps/"))


class JudgeTest(unittest.TestCase):
    def test_same_module_needs_update(self):
        v = judge(["modules/api/A.java"], ["modules/api/B.java", "modules/web/C.java"])
        self.assertTrue(v.update)
        self.assertEqual("갱신 필요(단위 겹침: api)", str(v))

    def test_different_modules_merge_directly(self):
        v = judge(["modules/api/A.java"], ["modules/web/C.java"])
        self.assertFalse(v.update)
        self.assertEqual("바로 머지", str(v))

    def test_shared_path_only_on_the_pr_side_needs_update(self):
        v = judge(["modules/common/Util.java"], ["modules/web/C.java"])
        self.assertEqual("갱신 필요(공용 경로: modules/common/Util.java)", str(v))

    def test_shared_path_only_on_the_base_side_needs_update(self):
        v = judge(["modules/api/A.java"], ["build.gradle"])
        self.assertEqual("갱신 필요(공용 경로: build.gradle)", str(v))

    def test_docs_only_pr_merges_directly_even_if_base_touched_shared_paths(self):
        v = judge(["docs/guide.txt", "README.md"], ["modules/common/Util.java"])
        self.assertFalse(v.update)

    def test_docs_on_the_base_side_do_not_count(self):
        v = judge(["modules/api/A.java"], ["docs/api.md", "modules/web/C.java"])
        self.assertFalse(v.update)
        self.assertFalse(judge(["docs/x.txt", "modules/api/A.java"], ["docs/x.txt", "modules/web/C.java"]).update)

    def test_docs_that_look_like_shared_paths_are_not_shared(self):
        v = judge(["modules/api/A.java"], [".github/README.md"], docs_globs=["*.md"])
        self.assertFalse(v.update)

    def test_base_without_new_code_merges_directly(self):
        self.assertFalse(judge(["modules/common/Util.java"], []).update)
        self.assertFalse(judge(["modules/common/Util.java"], ["docs/a.md"]).update)

    def test_same_plain_file_is_an_overlap_but_different_ones_are_not(self):
        self.assertTrue(judge(["scripts/run.sh"], ["scripts/run.sh"]).update)
        self.assertFalse(judge(["scripts/run.sh"], ["scripts/other.sh"]).update)

    def test_without_shared_paths_only_units_count(self):
        v = ou.judge(["modules/common/Util.java"], ["modules/web/C.java"], shared_paths="")
        self.assertFalse(v.update)

    def test_grouped_units_count_as_one_unit(self):
        groups = [["web", "bff"]]
        v = judge(["modules/web/A.ts"], ["modules/bff/B.java"], groups=groups)
        self.assertEqual("갱신 필요(단위 겹침: web+bff)", str(v))
        self.assertTrue(judge(["modules/bff/B.java"], ["modules/web/A.ts"], groups=groups).update)
        self.assertFalse(judge(["modules/web/A.ts"], ["modules/bff/B.java"]).update)

    def test_group_does_not_pull_in_other_units(self):
        self.assertFalse(judge(["modules/web/A.ts"], ["modules/api/B.java"], groups=[["web", "bff"]]).update)

    def test_group_members_may_be_plain_file_units(self):
        self.assertTrue(judge(["scripts/a.sh"], ["scripts/b.sh"], groups=[["scripts/a.sh", "scripts/b.sh"]]).update)

    def test_unit_in_two_groups_is_an_error(self):
        with self.assertRaises(ValueError):
            ou.group_map([["a", "b"], ["b", "c"]])
        # 같은 묶음을 두 번 적은 것은 모호하지 않다
        self.assertEqual({"a": "a+b", "b": "a+b"}, ou.group_map([["a", "b"], ["a", "b"]]))

    def test_long_name_lists_are_shortened(self):
        v = judge([f"modules/m{i}/a" for i in range(6)], [f"modules/m{i}/b" for i in range(6)])
        self.assertEqual("갱신 필요(단위 겹침: m0, m1, m2 외 3)", str(v))


def git(repo, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)


class GitIntegrationTest(unittest.TestCase):
    """main 에서 갈라진 feature 브랜치를 만들고 CLI 의 출력과 종료 코드를 본다."""

    def setUp(self):
        self.repo = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.repo, True)
        git(self.repo, "init", "-q", "-b", "main")
        self.write("modules/api/A.java", "a")
        self.write("modules/web/W.java", "w")
        self.commit("init")

    def write(self, name, body):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)

    def commit(self, message):
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", message)

    def cli(self, *extra, base="main", head="feature"):
        done = subprocess.run(
            ["python3", str(SCRIPT), "--repo", str(self.repo), "--base", base, "--head", head,
             "--shared-paths", SHARED, "--docs-glob", "docs/*,*.md", *extra], capture_output=True, text=True)
        return done.returncode, done.stdout.strip(), done.stderr.strip()

    def diverge(self, pr_file, base_file):
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.write(pr_file, "pr")
        self.commit("pr")
        git(self.repo, "checkout", "-q", "main")
        if base_file:
            self.write(base_file, "base")
            self.commit("base")

    def test_modules_overlap(self):
        self.diverge("modules/api/B.java", "modules/api/C.java")
        self.assertEqual((1, "갱신 필요(단위 겹침: api)", ""), self.cli())

    def test_modules_do_not_overlap(self):
        self.diverge("modules/api/B.java", "modules/web/C.java")
        self.assertEqual((0, "바로 머지", ""), self.cli())

    def test_shared_path_on_pr_side(self):
        self.diverge("modules/common/U.java", "modules/web/C.java")
        code, out, _ = self.cli()
        self.assertEqual(1, code)
        self.assertIn("공용 경로: modules/common/U.java", out)

    def test_shared_path_on_base_side(self):
        self.diverge("modules/api/B.java", "build.gradle")
        code, out, _ = self.cli()
        self.assertEqual(1, code)
        self.assertIn("공용 경로: build.gradle", out)

    def test_docs_only_pr(self):
        self.diverge("docs/guide.txt", "modules/api/C.java")
        self.assertEqual((0, "바로 머지", ""), self.cli())

    def test_base_already_merged_into_the_pr(self):
        self.diverge("modules/api/B.java", "modules/api/C.java")
        git(self.repo, "checkout", "-q", "feature")
        git(self.repo, "merge", "-q", "--no-edit", "main")
        self.assertEqual((0, "바로 머지", ""), self.cli())

    def update_pr_then_move_base(self, second_base_file):
        """PR 을 갱신(base 를 merge)한 뒤 base 가 또 움직인 상태. 첫 base 변경은 PR 과 겹쳤다."""
        self.diverge("modules/api/B.java", "modules/api/C.java")
        git(self.repo, "checkout", "-q", "feature")
        git(self.repo, "merge", "-q", "--no-edit", "main")
        git(self.repo, "checkout", "-q", "main")
        self.write(second_base_file, "second")
        self.commit("base again")

    def test_rejudge_after_update_sees_only_the_changes_that_came_in_since(self):
        # 갱신한 PR 의 새 merge-base 는 이미 품은 base 다. 앞서 겹쳤던 api 변경은 다시 세지 않는다
        self.update_pr_then_move_base("docs/guide.txt")
        self.assertEqual((0, "바로 머지", ""), self.cli())
        git(self.repo, "checkout", "-q", "main")
        self.write("modules/web/W.java", "web again")
        self.commit("base web")
        self.assertEqual((0, "바로 머지", ""), self.cli())

    def test_rejudge_after_update_updates_again_when_the_new_changes_overlap(self):
        self.update_pr_then_move_base("modules/api/D.java")
        self.assertEqual((1, "갱신 필요(단위 겹침: api)", ""), self.cli())

    def test_base_has_no_new_commit(self):
        self.diverge("modules/api/B.java", None)
        self.assertEqual((0, "바로 머지", ""), self.cli())

    def test_renamed_file_counts_its_old_module(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        git(self.repo, "mv", "modules/api/A.java", "modules/web/A.java")
        self.commit("rename")
        git(self.repo, "checkout", "-q", "main")
        self.write("modules/api/A.java", "changed")
        self.commit("base")
        code, out, _ = self.cli()
        self.assertEqual(1, code)
        self.assertIn("api", out)

    def test_unit_group_option(self):
        self.diverge("modules/api/B.java", "modules/web/C.java")
        self.assertEqual((1, "갱신 필요(단위 겹침: api+web)", ""), self.cli("--unit-group", "api,web"))
        self.assertEqual((0, "바로 머지", ""), self.cli("--unit-group", "api,db", "--unit-group", "web,x"))

    def test_conflicting_unit_groups_cannot_be_judged(self):
        self.diverge("modules/api/B.java", "modules/web/C.java")
        code, _, err = self.cli("--unit-group", "api,web", "--unit-group", "web,db")
        self.assertEqual(2, code)
        self.assertTrue(err.startswith("오류:"), err)

    def test_unknown_ref_cannot_be_judged(self):
        self.diverge("modules/api/B.java", "modules/web/C.java")
        code, out, err = self.cli(head="nothing")
        self.assertEqual(2, code)
        self.assertEqual("", out)
        self.assertTrue(err.startswith("오류:"), err)

    def test_shared_paths_starting_with_a_dash_are_read_as_a_value_with_equals(self):
        self.diverge("modules/api/B.java", "yarn-lock")
        code, out, _ = self.cli("--shared-paths=-lock$")
        self.assertEqual(1, code)
        self.assertIn("공용 경로: yarn-lock", out)
        # 띄워 넘기면 argparse 가 값을 옵션으로 읽어 판정하지 못한다
        code, _, err = self.cli("--shared-paths", "-lock$")
        self.assertEqual(2, code, err)

    def test_invalid_shared_paths_cannot_be_judged(self):
        self.diverge("modules/api/B.java", "modules/web/C.java")
        code, _, err = self.cli("--shared-paths", "(")
        self.assertEqual(2, code)
        self.assertTrue(err.startswith("오류:"), err)


if __name__ == "__main__":
    unittest.main()
