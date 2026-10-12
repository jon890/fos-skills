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
        self.assertCaught("# 장애를 트리아지한다\n", "트리아지")

    def test_deep_heading_is_scanned(self):
        self.assertCaught("#### 트리아지 순서\n", "트리아지")

    def test_heading_inside_code_fence_is_skipped(self):
        self.assertPassed("```\n# 트리아지\n```\n")


class TestExclusion(Base):
    """제목 검사를 켤 때 함께 깨지기 쉬운 제외 규칙들이다."""

    def test_code_span_is_skipped(self):
        self.assertPassed("본문에서 `트리아지` 는 코드 스팬이라 제외된다.\n")

    def test_table_row_is_skipped(self):
        self.assertPassed("| 트리아지 | 분류 |\n| --- | --- |\n")

    def test_front_matter_is_skipped(self):
        self.assertPassed("---\ntriggers: 트리아지\n---\n\n본문이다.\n")

    def test_indented_code_fence_is_skipped(self):
        self.assertPassed("- 목록\n\n  ```\n  트리아지\n  ```\n")

    def test_link_url_is_skipped_but_text_is_scanned(self):
        self.assertPassed("[문구](https://example.com/트리아지)\n")
        self.assertCaught("[트리아지](https://example.com/a)\n", "트리아지")

    def test_link_definition_line_is_skipped(self):
        self.assertPassed("[ref]: https://example.com/트리아지\n")


class TestRegisteredForms(Base):
    """`기계` 는 한 글자로 등록하지 않고 조사가 붙은 형태만 등록한다.

    한 글자로 등록하면 기계 학습, 기계 번역까지 걸린다.
    """

    def test_registered_forms_are_caught(self):
        for form in ("기계가", "기계로", "기계적"):
            with self.subTest(form=form):
                self.assertCaught(f"{form} 판정한다.\n", form)

    def test_machine_learning_is_not_caught(self):
        self.assertPassed("기계 학습 모델과 기계 번역을 쓴다.\n")

    def test_test_is_caught(self):
        self.assertCaught("시험이 실패한다.\n", "시험")


class TestFalsePositive(Base):
    """부분 문자열로 찾으므로 무관한 낱말을 잡지 않는지 본다."""

    def test_compound_allow_still_works(self):
        self.assertPassed("새 설정을 시험적으로 도입한다.\n")
        self.assertCaught("시험적으로 도입하고 시험을 돌린다.\n", "시험")


class TestRemovedTerms(Base):
    """평범한 우리말과 영어 원어는 금지어가 아니다.

    금지어가 많아지자 에이전트가 영어 개발 용어를 우리말로 옮기며 어색한 말을 만들었다.
    그래서 누가 봐도 어색한 말만 남기고 나머지를 뺐다. 다시 넣으면 이 테스트가 실패한다.
    """

    def test_plain_korean_passes(self):
        samples = (
            "원인을 좁혀 나간다.",
            "두 경우를 가른다.",
            "테스트가 이 경우를 덮는다.",
            "응답 시간을 잰다.",
            "SDK 판을 올린다.",
            "로그 레벨을 강등한다.",
        )
        for text in samples:
            with self.subTest(text=text):
                self.assertPassed(f"{text}\n")

    def test_english_origins_pass(self):
        for term in ("matrix", "triage", "spike", "sweep", "gate", "wall-time", "baseline"):
            with self.subTest(term=term):
                self.assertPassed(f"{term} 을 사용한다.\n")


class TestTableParsing(Base):
    """표 형식에 따른 금지어 추출과 영문 금지어의 단어 경계를 임시 표로 고정한다.

    지금 표에는 영문 금지어가 없어, 실제 표로는 이 동작을 확인할 수 없다.
    """

    TABLE = (
        "## 어색한 말 매핑 표\n\n"
        "| 금지 | 원어 | 권장 |\n"
        "| --- | --- | --- |\n"
        "| 폭주 (CPU 폭주 등) | runaway | 과점유 |\n"
        "| gate / 게이트 | | 점검 |\n"
    )

    def run_with_table(self, text):
        rules = self.write("rules.md", self.TABLE)
        path = self.write("a.md", text)
        return subprocess.run(
            ["python3", str(SCRIPT), str(path)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(rules), "PATH": "/usr/bin:/bin"},
        )

    def test_slash_separates_terms(self):
        for text in ("외부 상태 gate 를 둔다.\n", "배포 게이트를 지난다.\n"):
            with self.subTest(text=text):
                self.assertEqual(self.run_with_table(text).returncode, 1)

    def test_parenthesized_note_and_origin_column_are_not_terms(self):
        self.assertEqual(self.run_with_table("CPU 가 runaway 상태다.\n").returncode, 0)
        self.assertEqual(self.run_with_table("CPU 가 폭주한다.\n").returncode, 1)

    def test_longer_english_word_is_not_caught(self):
        for text in ("aggregate 를 쓴다.\n", "gateway 를 앞에 둔다.\n", "pre-gate-check 라는 이름이다.\n"):
            with self.subTest(text=text):
                self.assertEqual(self.run_with_table(text).returncode, 0)


class TestInlinePlus(Base):
    """인라인 `+` 연결. 문장 구성 지침이라 경고로만 알리고 실패로 막지 않는다."""

    def test_inline_plus_warns_but_passes(self):
        done = self.run_on("배포 + 검증을 함께 한다.\n")
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertIn("경고: 인라인 + 연결", done.stdout)

    def assertNoWarning(self, text):
        done = self.run_on(text)
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertNotIn("인라인 + 연결", done.stdout)

    def test_plus_without_spaces_is_not_caught(self):
        self.assertNoWarning("a+b 를 계산한다.\n")

    def test_plus_in_code_span_is_not_caught(self):
        self.assertNoWarning("`GPU 수 + 1` 로 센다.\n")


class TestAutoLink(Base):
    """`<https://...>` 형태의 자동 링크 URL 은 제외한다."""

    def test_auto_link_url_is_skipped(self):
        self.assertPassed("<https://example.com/트리아지>\n")

    def test_text_around_auto_link_is_scanned(self):
        self.assertCaught("트리아지 <https://example.com/a>\n", "트리아지")


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
        self.assertCaught("장애를 트리아지했다.\n", "트리아지", "CHANGELOG.md")


class TestNonMarkdown(Base):
    """`.md` 가 아닌 경로는 이 검사기가 조용히 건너뛴다.

    `check.sh` 가 앞에서 2 로 막으므로 실사용에서는 드러나지 않는다.
    직접 부르는 쪽은 검사되지 않은 것이 통과로 보이므로 현재 동작을 고정한다.
    """

    def test_txt_is_skipped_here(self):
        path = self.write("a.txt", "트리아지 자리다.\n")
        done = subprocess.run(
            ["python3", str(SCRIPT), str(path)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 0)

    def test_txt_is_rejected_by_check_sh(self):
        path = self.write("a.txt", "트리아지 자리다.\n")
        done = subprocess.run(
            [str(SCRIPT.parent / "check.sh"), str(path)],
            capture_output=True, text=True,
        )
        self.assertEqual(done.returncode, 2)


class TestExitCode(Base):
    """종료 코드 규약. 0 통과, 1 금지어 발견, 2 돌지 못함이다."""

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

        path = self.write("a.md", "장애를 트리아지한다.\n")
        done = subprocess.run(
            ["python3", str(SCRIPT), str(path), str(self.root / "없다.md")],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 2)
        self.assertIn("트리아지", done.stdout)

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
            ["python3", str(SCRIPT), "--text", "장애를 트리아지한다"],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 2)

    def test_file_argument_still_runs(self):
        path = self.write("a.md", "장애를 트리아지한다.\n")
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
        done = self.hook(self.write("a.md", "# 장애를 트리아지한다\n"))
        self.assertEqual(done.returncode, 0)
        self.assertIn("트리아지", done.stdout)

    def test_clean_file_exits_zero(self):
        done = self.hook(self.write("a.md", "문제가 없는 문장이다.\n"))
        self.assertEqual(done.returncode, 0)

    def test_changelog_is_scanned_in_hook(self):
        done = self.hook(self.write("CHANGELOG.md", "예전에 장애를 트리아지했다.\n"))
        self.assertEqual(done.returncode, 0)
        self.assertIn("트리아지", done.stdout)


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
