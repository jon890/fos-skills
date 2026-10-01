#!/usr/bin/env python3
"""korean-style-check 의 검출력 검사.

검사마다 걸리는 표본과 걸리지 않는 표본을 함께 둔다.
걸리는 쪽만 두면 그 검사가 모든 것을 잡는 상태가 돼도 통과한다.

**제외 규칙이 이 파일의 중심이다.**
실측으로, 제목을 건너뛰던 규칙과 등록 형태가 좁던 것이 겹쳐
머지된 스킬 문서에 금지어 세 곳이 남았는데 종료 코드는 0 이었다.
제외를 넓히는 변경은 조용히 통과하므로 표본으로 고정한다.
"""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "korean-style-check.py"
RULES = Path(__file__).resolve().parents[1] / "references" / "korean-style.md"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def write(self, name, text):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path

    def run_on(self, text, name="a.md"):
        path = self.write(name, text)
        return subprocess.run(
            ["python3", str(SCRIPT), str(path)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )

    def assertCaught(self, text, term=None, name="a.md"):
        done = self.run_on(text, name)
        self.assertEqual(done.returncode, 1, f"통과하면 안 되는 표본이 통과했다: {text!r}")
        if term:
            self.assertIn(term, done.stdout)

    def assertPassed(self, text, name="a.md"):
        done = self.run_on(text, name)
        self.assertEqual(done.returncode, 0, f"걸리면 안 되는 표본이 걸렸다: {done.stdout}")


class TestHeading(Base):
    """제목은 검사 대상이다.

    본문과 같은 무게로 읽히므로 제외하지 않는다.
    """

    def test_heading_is_scanned(self):
        self.assertCaught("# 미리 주어지는 것과 직접 쓰는 것을 가른다\n", "가른")

    def test_deep_heading_is_scanned(self):
        self.assertCaught("#### 무엇을 가른다\n", "가른")

    def test_heading_inside_code_fence_is_skipped(self):
        self.assertPassed("```\n# 가른다\n```\n")


class TestExclusion(Base):
    """제목 검사를 켤 때 함께 깨지기 쉬운 제외 규칙들이다."""

    def test_code_span_is_skipped(self):
        self.assertPassed("본문에서 `가른다` 는 코드 스팬이라 제외된다.\n")

    def test_table_row_is_skipped(self):
        self.assertPassed("| 가른다 | 나눈다 |\n| --- | --- |\n")

    def test_front_matter_is_skipped(self):
        self.assertPassed("---\ntriggers: 가른다\n---\n\n본문이다.\n")

    def test_indented_code_fence_is_skipped(self):
        self.assertPassed("- 목록\n\n  ```\n  가른다\n  ```\n")

    def test_link_url_is_skipped_but_text_is_scanned(self):
        self.assertPassed("[문구](https://example.com/가른다)\n")
        self.assertCaught("[가른다](https://example.com/a)\n", "가른")

    def test_link_definition_line_is_skipped(self):
        self.assertPassed("[ref]: https://example.com/가른다\n")


class TestConjugation(Base):
    """등록 형태가 좁으면 같은 낱말의 다른 활용형이 빠져나간다."""

    def test_registered_forms_are_caught(self):
        for form in ("가른", "가르는", "갈랐다", "가르지", "가르고", "가르며", "가름"):
            with self.subTest(form=form):
                self.assertCaught(f"둘을 {form} 자리다.\n", form)

    def test_declarative_form_is_covered_by_attributive(self):
        """`가른` 이 `가른다` 를 포함하므로 따로 등록하지 않는다.

        둘 다 등록하면 한 위반이 두 줄로 보고돼 건수를 세는 쪽이 두 배로 읽는다.
        """
        done = self.run_on("둘을 가른다 자리다.\n")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(done.stdout.count("금지어"), 1)

    def test_narrow_verb_forms_are_caught(self):
        for form in ("좁힌다", "좁혀", "좁혔다", "좁히면", "좁힐", "좁힘", "좁힙니다"):
            with self.subTest(form=form):
                self.assertCaught(f"대상을 {form}.\n")

    def test_narrow_adjective_forms_are_not_caught(self):
        for form in ("좁은", "좁다", "좁았다"):
            with self.subTest(form=form):
                self.assertPassed(f"길이 {form}.\n")


class TestFalsePositive(Base):
    """부분 문자열로 찾으므로 무관한 낱말을 잡지 않는지 본다."""

    def test_teaching_verb_is_not_caught(self):
        self.assertPassed("남을 가르치는 일이다.\n")

    def test_intransitive_idiom_is_not_caught(self):
        self.assertPassed("의견이 갈리다. 판정이 갈린다.\n")

    def test_splitting_apart_is_not_caught(self):
        self.assertPassed("원본과 갈라지는 문제가 생긴다.\n")

    def test_compound_allow_still_works(self):
        self.assertPassed("API 게이트웨이를 앞에 둔다.\n")
        self.assertCaught("배포 게이트를 통과한다.\n", "게이트")


class TestVersionPhrase(Base):
    """버전 뜻의 구절은 잡고 판단·판정이 들어간 문장은 통과시킨다."""

    def test_registered_noun_phrases_are_caught(self):
        for prefix in ("SDK", "BOM", "같은", "고정", "마지막", "지시문"):
            for particle, action in (("을", "사용한다"), ("이", "필요하다"), ("으로", "변경한다")):
                term = f"{prefix} 판{particle}"
                with self.subTest(term=term):
                    self.assertCaught(f"{term} {action}.\n", term)

    def test_registered_verb_phrases_are_caught(self):
        samples = (
            ("판을 올", "판을 올린다."),
            ("판이 바뀌", "판이 바뀌었다."),
            ("판으로 고정", "판으로 고정한다."),
            ("판도 올", "판도 올렸다."),
        )
        for term, text in samples:
            with self.subTest(term=term):
                self.assertCaught(f"{text}\n", term)

    def test_judgment_words_with_candidate_prefixes_pass(self):
        for prefix in ("SDK", "BOM", "같은", "고정", "마지막", "지시문"):
            for word in ("판단", "판정"):
                for particle in ("을", "이", "으로"):
                    text = f"{prefix} {word}{particle} 표시한다.\n"
                    with self.subTest(text=text):
                        self.assertPassed(text)

    def test_natural_judgment_sentences_pass(self):
        samples = (
            "판단을 다시 한다. 같은 판정을 낸다.",
            "판단을 올려 보고한다.",
            "판정이 바뀌었다.",
            "판단으로 고정하지 않는다.",
            "판정으로 고정한다.",
            "판단도 올바르다. 판정도 올바르다.",
        )
        for text in samples:
            with self.subTest(text=text):
                self.assertPassed(f"{text}\n")

    def test_recommended_version_phrases_pass(self):
        self.assertPassed("SDK 버전을 올린다. 같은 버전으로 고정한다.\n")
        self.assertPassed("BOM 버전이 바뀌었다. 지시문 버전도 올렸다.\n")


class TestEnglishTerm(Base):
    """영문 금지어는 단어 경계로 찾는다. 부분 문자열로 찾으면 다른 낱말을 잡는다."""

    def test_allowed_english_terms_pass(self):
        for term in ("baseline", "fan-out", "flat fan-out", "in-flight", "ingest"):
            with self.subTest(term=term):
                self.assertPassed(f"{term} 을 사용한다.\n")

    def test_korean_transliteration_and_remaining_english_terms_are_caught(self):
        for term in ("베이스라인", "wall-time", "sweep"):
            with self.subTest(term=term):
                self.assertCaught(f"{term} 을 사용한다.\n", term)

    def test_bare_english_term_is_caught(self):
        self.assertCaught("외부 상태 gate 를 둔다.\n", "gate")

    def test_longer_word_containing_it_is_not_caught(self):
        self.assertPassed("aggregate 를 쓴다.\n")
        self.assertPassed("gateway 를 앞에 둔다.\n")

    def test_hyphen_is_part_of_the_word(self):
        self.assertPassed("pre-gate-check 라는 이름이다.\n")


class TestInlinePlus(Base):
    """인라인 `+` 연결. 검사기가 선언한 두 축 중 하나다."""

    def test_inline_plus_is_caught(self):
        done = self.run_on("배포 + 검증을 함께 한다.\n")
        self.assertEqual(done.returncode, 1)
        self.assertIn("인라인 + 연결", done.stdout)

    def test_plus_without_spaces_is_not_caught(self):
        self.assertPassed("a+b 를 계산한다.\n")

    def test_plus_in_code_span_is_not_caught(self):
        self.assertPassed("`GPU 수 + 1` 로 센다.\n")


class TestAutoLink(Base):
    """`<https://...>` 형태의 자동 링크 URL 은 제외한다."""

    def test_auto_link_url_is_skipped(self):
        self.assertPassed("<https://example.com/가른>\n")

    def test_text_around_auto_link_is_scanned(self):
        self.assertCaught("둘을 가른 <https://example.com/a>\n", "가른")


class TestRulesFileItself(Base):
    """매핑 표 자신은 건너뛴다. 표가 곧 금지어 목록이라 전부 위반으로 잡힌다."""

    def test_rules_file_is_skipped(self):
        done = subprocess.run(
            ["python3", str(SCRIPT), str(RULES)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_changelog_is_scanned_when_passed_directly(self):
        self.assertCaught("대상을 좁혔다.\n", "좁혔", "CHANGELOG.md")


class TestNonMarkdown(Base):
    """`.md` 가 아닌 경로는 이 검사기가 조용히 건너뛴다.

    `check.sh` 가 앞에서 2 로 막으므로 실사용에서는 드러나지 않는다.
    직접 부르는 쪽은 검사되지 않은 것이 통과로 보이므로 현재 동작을 고정한다.
    """

    def test_txt_is_skipped_here(self):
        path = self.write("a.txt", "둘을 가른 자리다.\n")
        done = subprocess.run(
            ["python3", str(SCRIPT), str(path)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 0)

    def test_txt_is_rejected_by_check_sh(self):
        path = self.write("a.txt", "둘을 가른 자리다.\n")
        done = subprocess.run(
            [str(SCRIPT.parent / "check.sh"), str(path)],
            capture_output=True, text=True,
        )
        self.assertEqual(done.returncode, 2)


class TestExitCode(Base):
    """종료 코드 규약. 0 통과, 1 위반, 2 돌지 못함이다."""

    def test_clean_file_is_zero(self):
        self.assertPassed("문제가 없는 문장이다.\n")

    def test_missing_path_is_two_here_and_in_check_sh(self):
        """없는 경로는 검사기를 직접 불러도 2 로 끝난다. 0 이면 오타 난 경로가 통과로 보인다."""
        done = subprocess.run(
            ["python3", str(SCRIPT), str(self.root / "없다.md")],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 2)

        path = self.write("a.md", "이 게이트를 지난다.\n")
        done = subprocess.run(
            ["python3", str(SCRIPT), str(path), str(self.root / "없다.md")],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 2)
        self.assertIn("게이트", done.stdout)

        wrapper = SCRIPT.parent / "check.sh"
        done = subprocess.run(
            [str(wrapper), str(self.root / "없다.md")],
            capture_output=True, text=True,
        )
        self.assertEqual(done.returncode, 2)

    def test_missing_rules_is_two(self):
        path = self.write("a.md", "문장이다.\n")
        done = subprocess.run(
            ["python3", str(SCRIPT), str(path)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(self.root / "없다.md"), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 2)

    def test_no_argument_is_two(self):
        done = subprocess.run(
            ["python3", str(SCRIPT)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 2)

    def test_unknown_option_is_two(self):
        """이 검사기는 --text 를 받지 않는다. check.sh 가 임시 파일로 바꿔 넘긴다.

        받아들이면 옵션이 파일 경로로 읽혀 금지어가 있어도 통과로 끝난다.
        """
        done = subprocess.run(
            ["python3", str(SCRIPT), "--text", "게이트를 지난다"],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 2)

    def test_file_argument_still_runs(self):
        path = self.write("a.md", "이 게이트를 지난다.\n")
        done = subprocess.run(
            ["python3", str(SCRIPT), str(path)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 1)


class TestHookMode(Base):
    """훅 모드는 위반이 있어도 0 으로 끝난다. 편집을 막지 않고 결과만 알린다."""

    def hook(self, path):
        payload = json.dumps({"tool_input": {"file_path": str(path)}})
        return subprocess.run(
            ["python3", str(SCRIPT), "--hook"],
            input=payload, capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )

    def test_violation_still_exits_zero(self):
        done = self.hook(self.write("a.md", "# 무엇을 가른다\n"))
        self.assertEqual(done.returncode, 0)
        self.assertIn("가른", done.stdout)

    def test_clean_file_exits_zero(self):
        done = self.hook(self.write("a.md", "문제가 없는 문장이다.\n"))
        self.assertEqual(done.returncode, 0)

    def test_changelog_is_scanned_in_hook(self):
        done = self.hook(self.write("CHANGELOG.md", "예전에 대상을 좁혔다.\n"))
        self.assertEqual(done.returncode, 0)
        self.assertIn("좁혔", done.stdout)


class TestRepository(unittest.TestCase):
    """이 저장소 자신이 자기 규칙을 지키는지 본다.

    실측으로, 이 스킬의 `SKILL.md` 가 자기 금지어를 쓰고 있던 적이 있다.
    """

    def test_repo_markdown_passes(self):
        root = Path(__file__).resolve().parents[2]
        files = subprocess.run(
            ["git", "ls-files", "*.md"], cwd=root,
            capture_output=True, text=True, check=True,
        ).stdout.split()
        # 과거 변경 이력의 표현은 수정하지 않는다. 새 이력은 직접 검사한다.
        files = [path for path in files if Path(path).name != "CHANGELOG.md"]
        self.assertTrue(files, "검사할 .md 를 찾지 못했다")
        done = subprocess.run(
            ["python3", str(SCRIPT), *files], cwd=root,
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 0, done.stdout)


if __name__ == "__main__":
    unittest.main()
