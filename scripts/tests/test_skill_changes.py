"""스킬 변경 이력 조각(`scripts/skill_changes.py`)의 검사와 버전 상향을 임시 git 저장소로 검증한다."""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import skill_changes as sc

SKILL_MD = '---\nname: orch\nmetadata:\n  version: "5.15.0"\n---\n본문\n'
CHANGELOG = "# CHANGELOG: orch\n\n## 5.15.0 (2026-11-01)\n\n- 앞 변경\n"
BOARD_LOG = "# CHANGELOG: work-board\n\n소개 문단.\n\n## 1.4.2 (2026-11-01)\n\n- 앞 변경\n"


def load_checker():
    spec = importlib.util.spec_from_file_location("check_skill_docs", ROOT / "scripts" / "check-skill-docs.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FragmentCheckTest(unittest.TestCase):
    def test_valid_fragment_passes(self):
        self.assertEqual(sc.check_fragment("fix-typo.patch.md", "- 문구를 고쳤다\n\n"), [])
        self.assertEqual(sc.check_fragment("add-queue.minor.md", "- 하나\n- 둘\n"), [])

    def test_bad_names_are_reported(self):
        for name in ("fix.md", "fix.major.md", "Fix.patch.md", "fix_x.patch.md", ".patch.md"):
            self.assertTrue(any("이름" in p for p in sc.check_fragment(name, "- a\n")), name)

    def test_non_bullet_line_is_reported(self):
        self.assertTrue(any("항목(`- `)이 아닌" in p for p in sc.check_fragment("a.patch.md", "# 제목\n- a\n")))

    def test_empty_fragment_is_reported(self):
        self.assertTrue(any("항목이 없다" in p for p in sc.check_fragment("a.patch.md", "\n")))

    def test_blank_bullet_is_reported(self):
        for text in ("- 정상\n- \n", "- 정상\n-   \n- 둘\n"):
            self.assertTrue(any("내용이 빈 항목" in p for p in sc.check_fragment("a.patch.md", text)), repr(text))

    def test_too_many_bullets_are_reported(self):
        text = "".join(f"- 항목 {n}\n" for n in range(6))
        self.assertTrue(any("6개" in p for p in sc.check_fragment("a.patch.md", text)))

    def test_long_bullet_is_reported(self):
        self.assertTrue(any("160자" in p for p in sc.check_fragment("a.patch.md", "- " + "가" * 161 + "\n")))
        self.assertEqual(sc.check_fragment("a.patch.md", "- " + "가" * 160 + "\n"), [])

    def test_compat_bullet_is_reported(self):
        self.assertTrue(any("호환성" in p for p in sc.check_fragment("a.minor.md", "- 호환성: 옵션을 지웠다\n")))

    def test_repository_has_no_bad_fragment(self):
        self.assertEqual(sc.check_changes(ROOT), [])

    def test_next_version(self):
        self.assertEqual(sc.next_version("5.15.9", "patch"), "5.15.10")
        self.assertEqual(sc.next_version("5.15.9", "minor"), "5.16.0")


class RepoCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        self.write("skills/orch/SKILL.md", SKILL_MD)
        self.write("skills/orch/CHANGELOG.md", CHANGELOG)
        self.write("skills/plan/SKILL.md", SKILL_MD.replace("orch", "plan").replace("5.15.0", "2.0.0"))
        self.write("skills/plan/CHANGELOG.md", CHANGELOG.replace("orch", "plan").replace("5.15.0", "2.0.0"))
        self.write("extensions/work-board/CHANGELOG.md", BOARD_LOG)
        self.commit("init")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def read(self, rel):
        return (self.root / rel).read_text(encoding="utf-8")

    def commit(self, subject):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", subject)

    def apply(self):
        return sc.apply_fragments(self.root, "2026-11-04")


class CheckChangesTest(RepoCase):
    def test_every_bad_fragment_is_reported_with_path_and_reason(self):
        self.write("skills/orch/changes/fix.md", "- a\n")
        self.write("skills/plan/changes/x.minor.md", "문단\n")
        self.write("extensions/work-board/changes/y.patch.md", "- 호환성: 지웠다\n")
        problems = sc.check_changes(self.root)
        self.assertEqual(len(problems), 3, problems)
        self.assertTrue(any(p.startswith("extensions/work-board/changes/y.patch.md: ") for p in problems))
        self.assertEqual(sum(p.startswith("skills/plan/changes/x.minor.md: ") for p in problems), 1)
        self.assertTrue(any(p.startswith("skills/orch/changes/fix.md: 이름") for p in problems))
        self.assertTrue(any(p.startswith("skills/plan/changes/x.minor.md: ") for p in problems))

    def test_valid_fragments_pass(self):
        self.write("skills/orch/changes/fix.patch.md", "- a\n")
        self.assertEqual(sc.check_changes(self.root), [])


class ConflictTest(RepoCase):
    def test_two_branches_adding_fragments_merge_without_conflict(self):
        for branch in ("a", "b"):
            self.git("checkout", "-q", "-b", branch, "main")
            self.write(f"skills/orch/changes/{branch}-work.minor.md", f"- {branch} 변경\n")
            self.commit(f"feat: {branch}")
        self.git("checkout", "-q", "main")
        self.git("merge", "-q", "--no-ff", "-m", "Merge a", "a")
        self.git("merge", "-q", "--no-ff", "-m", "Merge b", "b")
        names = sorted(p.name for p in (self.root / "skills/orch/changes").iterdir())
        self.assertEqual(names, ["a-work.minor.md", "b-work.minor.md"])


class ApplyTest(RepoCase):
    def test_minor_fragment_raises_version_and_writes_section(self):
        self.write("skills/orch/changes/add-queue.minor.md", "- 큐를 더했다\n- 설정을 더했다\n")
        self.commit("feat(orch): 큐")
        applied, warnings = self.apply()
        self.assertEqual(applied, [("orch", "5.16.0")])
        self.assertEqual(warnings, [])
        self.assertIn('version: "5.16.0"', self.read("skills/orch/SKILL.md"))
        self.assertIn("# CHANGELOG: orch\n\n## 5.16.0 (2026-11-04)\n\n- 큐를 더했다\n- 설정을 더했다\n\n## 5.15.0", self.read("skills/orch/CHANGELOG.md"))
        self.assertFalse((self.root / "skills/orch/changes").exists())

    def test_patch_fragment_raises_patch(self):
        self.write("skills/orch/changes/fix-typo.patch.md", "- 문구를 고쳤다\n")
        self.commit("fix")
        self.assertEqual(self.apply()[0], [("orch", "5.15.1")])

    def test_fragments_follow_merge_order_not_name_order(self):
        self.write("skills/orch/changes/zzz-first.minor.md", "- 먼저\n")
        self.commit("first")
        self.write("skills/orch/changes/aaa-second.patch.md", "- 나중\n")
        self.commit("second")
        applied, _ = self.apply()
        self.assertEqual(applied, [("orch", "5.16.0"), ("orch", "5.16.1")])
        log = self.read("skills/orch/CHANGELOG.md")
        self.assertIn("## 5.16.1 (2026-11-04)\n\n- 나중\n\n## 5.16.0 (2026-11-04)\n\n- 먼저\n\n## 5.15.0", log)

    def test_many_units_are_independent(self):
        self.write("skills/orch/changes/a.minor.md", "- orch\n")
        self.write("skills/plan/changes/b.patch.md", "- plan\n")
        self.write("extensions/work-board/changes/c.minor.md", "- board\n")
        self.commit("many")
        applied, _ = self.apply()
        self.assertEqual(sorted(applied), [("orch", "5.16.0"), ("plan", "2.0.1"), ("work-board", "1.5.0")])

    def test_extension_without_skill_md_changes_only_changelog(self):
        self.write("extensions/work-board/changes/c.minor.md", "- board\n")
        self.commit("board")
        self.apply()
        self.assertIn("소개 문단.\n\n## 1.5.0 (2026-11-04)\n\n- board\n\n## 1.4.2", self.read("extensions/work-board/CHANGELOG.md"))
        self.assertFalse((self.root / "extensions/work-board/SKILL.md").exists())

    def test_bad_fragment_is_skipped_with_warning_and_kept(self):
        self.write("skills/orch/changes/bad.minor.md", "# 제목\n")
        self.write("skills/plan/changes/ok.minor.md", "- 정상\n")
        self.commit("mixed")
        applied, warnings = self.apply()
        self.assertEqual(applied, [("plan", "2.1.0")])
        self.assertEqual(len(warnings), 1)
        self.assertIn("skills/orch/changes/bad.minor.md", warnings[0])
        self.assertTrue((self.root / "skills/orch/changes/bad.minor.md").exists())
        self.assertIn('version: "5.15.0"', self.read("skills/orch/SKILL.md"))

    def test_fragment_with_trailing_blank_bullet_is_skipped_and_result_passes_changelog_check(self):
        self.write("skills/orch/changes/empty.patch.md", "- valid change\n- \n")
        self.write("skills/plan/changes/ok.patch.md", "- 정상\n")
        self.commit("blank bullet")
        applied, warnings = self.apply()
        self.assertEqual(applied, [("plan", "2.0.1")])
        self.assertEqual(len(warnings), 1)
        self.assertIn("skills/orch/changes/empty.patch.md", warnings[0])
        self.assertTrue((self.root / "skills/orch/changes/empty.patch.md").exists())
        self.assertEqual(self.read("skills/orch/CHANGELOG.md"), CHANGELOG)
        checker = load_checker()
        self.assertEqual(checker.check_changelog("plan", self.read("skills/plan/CHANGELOG.md"), "2.0.1"), [])

    def test_no_fragments_changes_nothing_and_second_run_is_idempotent(self):
        self.assertEqual(self.apply(), ([], []))
        self.write("skills/orch/changes/a.minor.md", "- 하나\n")
        self.commit("a")
        self.apply()
        after = self.read("skills/orch/CHANGELOG.md")
        self.assertEqual(self.apply(), ([], []))
        self.assertEqual(self.read("skills/orch/CHANGELOG.md"), after)

    def test_unit_with_unreadable_changelog_is_skipped(self):
        self.write("skills/orch/CHANGELOG.md", "# CHANGELOG: orch\n")
        self.write("skills/orch/changes/a.minor.md", "- 하나\n")
        self.commit("broken")
        applied, warnings = self.apply()
        self.assertEqual(applied, [])
        self.assertIn("첫 버전 절", warnings[0])

    def test_skill_md_without_version_line_skips_unit_and_keeps_fragment(self):
        self.write("skills/orch/SKILL.md", "---\nname: orch\n---\n")
        self.write("skills/orch/changes/a.minor.md", "- 하나\n")
        self.commit("no version line")
        applied, warnings = self.apply()
        self.assertEqual(applied, [])
        self.assertIn("metadata.version", warnings[0])
        self.assertTrue((self.root / "skills/orch/changes/a.minor.md").exists())
        self.assertEqual(self.read("skills/orch/CHANGELOG.md"), CHANGELOG)

    def test_order_follows_main_for_merge_commits_even_when_names_sort_the_other_way(self):
        self.git("checkout", "-q", "-b", "first", "main")
        self.write("skills/orch/changes/zzz.minor.md", "- 먼저 머지\n")
        self.commit("feat: first")
        self.git("checkout", "-q", "-b", "second", "main")
        self.write("skills/orch/changes/aaa.patch.md", "- 나중 머지\n")
        self.commit("feat: second")
        self.git("checkout", "-q", "main")
        self.git("merge", "-q", "--no-ff", "-m", "Merge first", "first")
        self.git("merge", "-q", "--no-ff", "-m", "Merge second", "second")
        self.assertEqual(self.apply()[0], [("orch", "5.16.0"), ("orch", "5.16.1")])

    def test_order_follows_main_for_squash_merges(self):
        for branch, name in (("first", "zzz.minor.md"), ("second", "aaa.patch.md")):
            self.git("checkout", "-q", "-b", branch, "main")
            self.write(f"skills/orch/changes/{name}", f"- {branch}\n")
            self.commit(f"feat: {branch}")
            self.git("checkout", "-q", "main")
            self.git("merge", "-q", "--squash", branch)
            self.commit(f"{branch} (#1)")
        self.assertEqual(self.apply()[0], [("orch", "5.16.0"), ("orch", "5.16.1")])

    def test_fragments_move_with_their_folder_and_fall_back_to_name_order(self):
        self.write("skills/orch/changes/zzz.minor.md", "- 먼저\n")
        self.commit("first")
        self.write("skills/orch/changes/aaa.patch.md", "- 나중\n")
        self.commit("second")
        self.git("mv", "skills/orch", "skills/orch2")
        self.commit("move")
        applied, _ = self.apply()
        self.assertEqual(applied, [("orch2", "5.15.1"), ("orch2", "5.16.0")])

    def test_reused_slug_takes_the_position_of_its_latest_addition(self):
        self.write("skills/orch/changes/fix-docs.patch.md", "- 옛 조각\n")
        self.commit("old fix-docs")
        self.git("rm", "-q", "skills/orch/changes/fix-docs.patch.md")
        self.commit("bot: processed")
        self.write("skills/orch/changes/zzz.minor.md", "- 먼저 머지\n")
        self.commit("zzz")
        self.write("skills/orch/changes/fix-docs.patch.md", "- 다시 쓴 조각\n")
        self.commit("fix-docs again")
        self.assertEqual(self.apply()[0], [("orch", "5.16.0"), ("orch", "5.16.1")])
        self.assertIn("## 5.16.1 (2026-11-04)\n\n- 다시 쓴 조각", self.read("skills/orch/CHANGELOG.md"))

    def test_fragment_on_top_of_a_directly_bumped_version(self):
        self.write("skills/orch/CHANGELOG.md", "# CHANGELOG: orch\n\n## 5.16.0 (2026-11-02)\n\n- 직접 올림\n\n## 5.15.0 (2026-11-01)\n\n- 앞 변경\n")
        self.write("skills/orch/SKILL.md", SKILL_MD.replace("5.15.0", "5.16.0"))
        self.write("skills/orch/changes/a.minor.md", "- 조각\n")
        self.commit("mix across PRs")
        self.assertEqual(self.apply()[0], [("orch", "5.17.0")])

    def test_default_day_is_a_date(self):
        self.assertRegex(sc.today_seoul(), r"^\d{4}-\d{2}-\d{2}$")


if __name__ == "__main__":
    unittest.main()
