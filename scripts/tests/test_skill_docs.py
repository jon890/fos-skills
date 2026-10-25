"""스킬 README 와 CHANGELOG 의 형식 검사기(`scripts/check-skill-docs.py`)가 저장소 스킬을 통과시키고 위반을 잡는지 검증한다."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("check_skill_docs", ROOT / "scripts" / "check-skill-docs.py")
docs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(docs)

README = """# demo

반복하던 수고를 덜어 준다.

## 이럴 때 쓴다

- 상황

## 사용 예시

```text
## 코드 블록 안의 제목은 절이 아니다
```

## 받는 것

- 결과

## 준비

- 설치

## 함께 쓰는 스킬

- 다른 스킬
"""

CHANGELOG = """# CHANGELOG: demo

버전은 SKILL.md 와 같은 값을 쓴다.

## 2.1.0 (2026-10-25)

- 새 명령을 더했다
- 호환성: 옛 옵션을 지웠다

## 2.0.0 (2026-10-20)

- 단계를 줄였다

## 1.x

- 처음 만들고 다듬었다
"""


class RepositorySkillsTest(unittest.TestCase):
    def test_every_skill_follows_the_format_or_is_pending(self):
        self.assertEqual([], [problem for name in docs.skill_names() for problem in docs.check_skill(name)])

    def test_pending_names_are_skills(self):
        names = set(docs.skill_names())
        self.assertLessEqual(docs.PENDING_README | docs.PENDING_CHANGELOG, names)


class ReadmeTest(unittest.TestCase):
    def test_valid_readme_passes(self):
        self.assertEqual([], docs.check_readme("demo", README))

    def test_missing_section_is_reported(self):
        problems = docs.check_readme("demo", README.replace("## 사용 예시", "## 예시"))
        self.assertTrue(any("`## 사용 예시`" in problem for problem in problems), problems)

    def test_wrong_order_is_reported(self):
        swapped = README.replace("## 이럴 때 쓴다", "## TMP").replace("## 받는 것", "## 이럴 때 쓴다").replace("## TMP", "## 받는 것")
        self.assertTrue(any("순서" in problem for problem in docs.check_readme("demo", swapped)))

    def test_file_listing_section_is_reported(self):
        problems = docs.check_readme("demo", README + "\n## 구성\n\n- `SKILL.md`\n")
        self.assertTrue(any("`## 구성`" in problem for problem in problems), problems)

    def test_missing_intro_is_reported(self):
        problems = docs.check_readme("demo", README.replace("반복하던 수고를 덜어 준다.\n", ""))
        self.assertTrue(any("첫 문단" in problem for problem in problems), problems)

    def test_wrong_title_is_reported(self):
        self.assertTrue(docs.check_readme("other", README))


class ChangelogTest(unittest.TestCase):
    def test_valid_changelog_passes(self):
        self.assertEqual([], docs.check_changelog("demo", CHANGELOG, "2.1.0"))

    def test_version_mismatch_is_reported(self):
        problems = docs.check_changelog("demo", CHANGELOG, "2.2.0")
        self.assertTrue(any("SKILL.md" in problem for problem in problems), problems)

    def test_heading_without_date_is_reported(self):
        problems = docs.check_changelog("demo", CHANGELOG.replace("2.0.0 (2026-10-20)", "2.0.0"), "2.1.0")
        self.assertTrue(any("`## 2.0.0`" in problem for problem in problems), problems)

    def test_previous_major_version_section_is_reported(self):
        text = CHANGELOG.replace("## 1.x", "## 1.3.0 (2026-10-01)")
        self.assertTrue(any("`## 1.x`" in problem for problem in docs.check_changelog("demo", text, "2.1.0")))

    def test_summary_of_current_major_is_reported(self):
        text = CHANGELOG.replace("## 1.x", "## 2.x")
        self.assertTrue(any("현재 major" in problem for problem in docs.check_changelog("demo", text, "2.1.0")))

    def test_too_many_bullets_are_reported(self):
        bullets = "".join(f"- 항목 {n}\n" for n in range(docs.MAX_VERSION_BULLETS + 1))
        text = CHANGELOG.replace("- 단계를 줄였다\n", bullets)
        self.assertTrue(any("상한" in problem for problem in docs.check_changelog("demo", text, "2.1.0")))

    def test_long_bullet_is_reported(self):
        text = CHANGELOG.replace("- 단계를 줄였다", "- " + "가" * (docs.MAX_BULLET_CHARS + 1))
        self.assertTrue(any("자를 넘는" in problem for problem in docs.check_changelog("demo", text, "2.1.0")))

    def test_prose_line_in_version_is_reported(self):
        text = CHANGELOG.replace("- 단계를 줄였다", "단계를 줄였다.")
        self.assertTrue(any("목록 항목이 아닌" in problem for problem in docs.check_changelog("demo", text, "2.1.0")))


class PendingTest(unittest.TestCase):
    def make_skill(self, root, readme):
        (root / "demo").mkdir()
        (root / "demo" / "SKILL.md").write_text('---\nmetadata:\n  version: "2.1.0"\n---\n', encoding="utf-8")
        (root / "demo" / "README.md").write_text(readme, encoding="utf-8")
        (root / "demo" / "CHANGELOG.md").write_text(CHANGELOG, encoding="utf-8")

    def test_pending_skill_with_old_format_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.make_skill(Path(tmp), "# demo\n\n## 구성\n")
            old = docs.PENDING_README
            docs.PENDING_README = {"demo"}
            try:
                self.assertEqual([], docs.check_skill("demo", Path(tmp)))
            finally:
                docs.PENDING_README = old

    def test_pending_skill_that_follows_the_format_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.make_skill(Path(tmp), README)
            old = docs.PENDING_README
            docs.PENDING_README = {"demo"}
            try:
                problems = docs.check_skill("demo", Path(tmp))
            finally:
                docs.PENDING_README = old
            self.assertTrue(any("PENDING_README" in problem for problem in problems), problems)


if __name__ == "__main__":
    unittest.main()
