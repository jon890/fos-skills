"""check_references.py 가 플러그인 스킬 이름을 배치와 무관하게 찾는지 검증한다.

스크립트는 import 할 때 sys.argv 를 읽으므로 하위 프로세스로 부른다.
HOME 을 임시 디렉터리로 바꾸므로 인터프리터는 sys.executable 로 준다.
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_references.py"


class CheckReferencesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.home, self.repo = root / "home", root / "repo"
        self.home.mkdir()
        self.repo.mkdir()

    def write_claude_md(self, skill):
        (self.repo / "CLAUDE.md").write_text(f"# 지침\n\n`{skill}` 스킬을 쓴다.\n")

    def make_skill(self, relative):
        skill_file = self.home / ".claude/plugins" / relative / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text("---\nname: x\n---\n")

    def run_check(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.repo)],
            env={**os.environ, "HOME": str(self.home)},
            capture_output=True,
            text=True,
        )

    def test_finds_skill_of_plugin_laid_out_at_root(self):
        self.make_skill("cache/fos-skills/fos-skills/0123456789ab/planning")
        self.write_claude_md("planning")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("깨진 참조 0건", result.stdout)

    def test_finds_skill_of_plugin_laid_out_under_skills_dir(self):
        self.make_skill("cache/m/p/1.0.0/skills/brain-add")
        self.write_claude_md("brain-add")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_reports_missing_skill(self):
        (self.home / ".claude/plugins").mkdir(parents=True)
        self.write_claude_md("no-such-skill")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("[스킬] no-such-skill", result.stdout)


class SiblingAndPluginTest(CheckReferencesTest):
    """형제 스킬의 파일 참조와 플러그인 이름을 깨진 참조로 내지 않는지 검증한다."""

    def make_repo_skill(self, relative, *files):
        base = self.repo / relative
        base.mkdir(parents=True)
        (base / "SKILL.md").write_text("---\nname: x\n---\n")
        for name in files:
            target = base / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("# 문서\n")
        return base

    def write_doc(self, relative, text):
        doc = self.repo / relative
        doc.parent.mkdir(parents=True, exist_ok=True)
        doc.write_text(text)

    def test_sibling_skill_path_with_qualified_name_is_not_broken(self):
        self.make_repo_skill("plugins/nhn-dev/skills/dooray-cli", "references/mention-link.md")
        self.make_repo_skill("plugins/ai-sdt/skills/weekly-report")
        self.write_doc(
            "plugins/ai-sdt/skills/weekly-report/references/format.md",
            "`nhn-dev:dooray-cli` 스킬의 `references/mention-link.md` 가 소유한다.\n",
        )
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_sibling_skill_path_with_plain_name_is_not_broken(self):
        self.make_repo_skill("skills/alpha", "references/shared.md")
        self.make_repo_skill("skills/beta")
        self.write_doc("skills/beta/SKILL.md", "`alpha` 스킬의 `references/shared.md` 를 읽는다.\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_file_in_named_sibling_is_still_broken(self):
        self.make_repo_skill("plugins/nhn-dev/skills/dooray-cli", "references/other.md")
        self.make_repo_skill("plugins/ai-sdt/skills/weekly-report")
        self.write_doc(
            "plugins/ai-sdt/skills/weekly-report/references/format.md",
            "`nhn-dev:dooray-cli` 스킬의 `references/mention-link.md` 가 소유한다.\n",
        )
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("[경로] references/mention-link.md", result.stdout)

    def test_unknown_prefix_is_not_a_sibling_reference(self):
        self.make_repo_skill("plugins/nhn-dev/skills/dooray-cli", "references/mention-link.md")
        self.make_repo_skill("plugins/ai-sdt/skills/weekly-report")
        self.write_doc(
            "plugins/ai-sdt/skills/weekly-report/references/format.md",
            "`foo:dooray-cli` 의 `references/mention-link.md` 가 소유한다.\n",
        )
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_path_without_sibling_name_is_still_broken(self):
        self.make_repo_skill("skills/alpha", "references/shared.md")
        self.make_repo_skill("skills/beta")
        self.write_doc("skills/beta/SKILL.md", "`references/shared.md` 를 읽는다.\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_plugin_directory_name_is_not_a_skill_reference(self):
        self.make_repo_skill("plugins/nhn-dev/skills/dooray-cli")
        self.write_claude_md("nhn-dev")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_plugin_json_name_is_not_a_skill_reference(self):
        manifest = self.repo / ".claude-plugin/plugin.json"
        manifest.parent.mkdir()
        manifest.write_text('{"name": "my-plugin"}')
        self.write_claude_md("my-plugin")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unknown_name_is_still_reported_next_to_plugins(self):
        self.make_repo_skill("plugins/nhn-dev/skills/dooray-cli")
        self.write_claude_md("no-such-skill")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("[스킬] no-such-skill", result.stdout)


class GuideSectionRefTest(CheckReferencesTest):
    """파일 표기 바로 뒤의 「제목」 참조가 그 파일의 제목과 맞는지 검증한다."""

    def setUp(self):
        super().setUp()
        (self.repo / "AGENTS.md").write_text(
            "# 지침\n\n## 머지는 PR 로 한다\n\n## 용어\n\n- **코드 주석은 한국어로 쓴다.**\n"
        )

    def write(self, relative, text):
        target = self.repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def git_init(self, *files):
        for command in (["init", "-q"], ["add", *files]):
            subprocess.run(["git", *command], cwd=self.repo, check=True, capture_output=True)

    def test_existing_title_passes_for_every_file_notation(self):
        self.write(
            "CLAUDE.md",
            "`AGENTS.md` 「머지는 PR 로 한다」 가 정한다.\n"
            "[`AGENTS.md`](AGENTS.md) 의 「용어」 절에 있다.\n"
            "{@code AGENTS.md} 「용어」 를 따른다.\n"
            "맨 경로 AGENTS.md 에 「머지는 PR 로 한다」 가 있다.\n",
        )
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_title_is_reported_with_line(self):
        self.write("CLAUDE.md", "첫 줄\n`AGENTS.md` 「없는 제목」 을 따른다.\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("CLAUDE.md:2  [절 제목] AGENTS.md → 「없는 제목」", result.stdout)

    def test_title_is_compared_by_exact_text(self):
        self.write("CLAUDE.md", "`AGENTS.md` 「머지는 PR로 한다」 를 따른다.\n")
        self.assertEqual(self.run_check().returncode, 1)

    def test_chained_titles_are_each_checked(self):
        self.write("CLAUDE.md", "`AGENTS.md` 「용어」 의 「머지는 PR 로 한다」 를 따른다.\n`AGENTS.md` 「용어」 「없는 제목」.\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("「없는 제목」", result.stdout)
        self.assertEqual(result.stdout.count("[절 제목]"), 1)

    def test_bold_label_is_accepted_after_the_first_title_only(self):
        self.write("CLAUDE.md", "`AGENTS.md` 「용어」 의 「코드 주석은 한국어로 쓴다」 를 따른다.\n")
        self.assertEqual(self.run_check().returncode, 0)
        self.write("CLAUDE.md", "`AGENTS.md` 「코드 주석은 한국어로 쓴다」 를 따른다.\n")
        self.assertEqual(self.run_check().returncode, 1)

    def test_quote_without_file_notation_is_ignored(self):
        self.write("CLAUDE.md", "화면의 「저장」 버튼을 누른다. 「없는 제목」 이라는 문구가 뜬다.\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_placeholder_and_unresolved_file_are_skipped(self):
        self.write(
            "CLAUDE.md",
            "`AGENTS.md` 의 「...」 절\n`~/AGENTS.md` 「없는 제목」\n`no-such.md` 「없는 제목」\n"
            "`AGENTS.md` 「<제목>」\n",
        )
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_code_comment_pointing_to_instruction_is_checked(self):
        self.write("src/Rules.java", " * 근거: {@code AGENTS.md} 「없는 제목」.\n")
        self.write("README.md", "[`AGENTS.md`](AGENTS.md) 「용어」\n")
        self.git_init("AGENTS.md", "src/Rules.java", "README.md")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("src/Rules.java:1  [절 제목] AGENTS.md → 「없는 제목」", result.stdout)

    def test_code_comment_with_existing_title_passes(self):
        self.write("backend/Rules.java", " * 근거: backend/AGENTS.md 「포맷」 절, ../AGENTS.md 「용어」.\n")
        self.write("backend/AGENTS.md", "## 포맷\n")
        self.git_init("AGENTS.md", "backend/Rules.java", "backend/AGENTS.md")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_tracked_file_pointing_to_non_instruction_is_not_checked(self):
        self.write("docs/notes.md", "# 메모\n")
        self.write("src/Rules.java", " * {@code docs/notes.md} 「없는 제목」\n")
        self.git_init("AGENTS.md", "docs/notes.md", "src/Rules.java")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_untracked_and_binary_files_are_skipped(self):
        self.write("src/Untracked.java", " * `AGENTS.md` 「없는 제목」\n")
        (self.repo / "blob.bin").write_bytes(b"\0\xff`AGENTS.md` \xe3\x80\x8c\xea\xb0\x80\xe3\x80\x8d")
        self.git_init("AGENTS.md", "blob.bin")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_changelog_is_not_scanned_outside_instructions(self):
        self.write("CHANGELOG.md", "`AGENTS.md` 의 「옛 이름」 을 바꿨다.\n")
        self.git_init("AGENTS.md", "CHANGELOG.md")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_scope_limits_the_files_that_are_read(self):
        self.write("src/Rules.java", " * `AGENTS.md` 「없는 제목」\n")
        self.write("other/Rules.java", " * `AGENTS.md` 「없는 제목」\n")
        self.git_init("AGENTS.md", "src/Rules.java", "other/Rules.java")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.repo), "--scope", "other"],
            env={**os.environ, "HOME": str(self.home)},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("other/Rules.java:1", result.stdout)
        self.assertNotIn("src/Rules.java", result.stdout)


if __name__ == "__main__":
    unittest.main()
