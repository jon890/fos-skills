#!/usr/bin/env python3
"""korean-style-check 의 검출력 검사.

검사마다 걸리는 표본과 걸리지 않는 표본을 함께 둔다.
걸리는 쪽만 두면 그 검사가 모든 것을 잡는 상태가 돼도 통과한다.

**제외 규칙이 이 파일의 중심이다.**
실측으로, 제목을 건너뛰던 규칙과 등록 형태가 좁던 것이 겹쳐
머지된 스킬 문서에 금지어 세 곳이 남았는데 종료 코드는 0 이었다.
제외를 넓히는 변경은 조용히 통과하므로 표본으로 고정한다.
"""

import importlib.util
import json
import os
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


class TestThresholdTerm(Base):
    """threshold 를 옮긴 「문턱」 은 조사와 합성어 형태까지 막는다."""

    def test_forms_are_caught(self):
        for form in ("문턱값", "문턱으로", "문턱을"):
            with self.subTest(form=form):
                self.assertCaught(f"{form} 넘는다.\n", "문턱")

    def test_recommended_terms_pass(self):
        self.assertPassed("임계값을 넘으면 기준값으로 되돌린다.\n")


class TestDbContext(Base):
    """DB 의 table 과 column 을 「표」, 「칸」 으로 옮긴 쓰임만 막는다."""

    def test_db_phrases_are_caught(self):
        for text in ("DB 표를 만든다.", "`sensor` DB 표 `raw_recipient` 를 본다.",
                     "`orders` 표에 행을 넣는다.", "`care.registry` 칸을 바꾼다.",
                     "`status` 칸은 null 이다."):
            with self.subTest(text=text):
                self.assertCaught(text + "\n", "금지어")

    def test_document_table_words_pass(self):
        for text in ("아래 표를 본다.", "결과를 표로 정리한다.", "표의 열을 맞춘다.",
                     "표를 만들어 비교한다.", "DB 표준을 따른다.", "DB 표시 방식을 바꾼다.",
                     "`a.md` 파일의 표시를 바꾼다.", "plan 디렉터리의 `remote.md` 표", "`run.py` 칸을 본다.", "빈 칸을 채운다."):
            with self.subTest(text=text):
                self.assertPassed(text + "\n")

    def test_recommended_terms_pass(self):
        self.assertPassed("`orders` 테이블의 `status` 컬럼을 바꾼다.\n")


class TestStandingMetaphorTerm(Base):
    """생기다, 만들어지다를 「서다」 로 비유한 말은 막고, 「순서」, 「서지」, 줄이 서는 뜻은 막지 않는다."""

    def test_phrases_are_caught(self):
        for text in ("위험 카드가 선다.", "티켓이 서지 않는다.", "카드가 서야 한다.", "표시가 서야 통과다.",
                     "알림이 선다고 본다.", "기록이 서지 않으면 실패다."):
            with self.subTest(text=text):
                self.assertCaught(text + "\n", "금지어")

    def test_ordinary_words_pass(self):
        for text in ("실행 순서가 중요하다.", "서지 정보를 읽는다.", "이 서지 정보는 따로 둔다.",
                     "대기 줄이 선다.", "요청 줄이 서야 한다.", "서버가 서류를 읽는다.", "여기서지 않는다."):
            with self.subTest(text=text):
                self.assertPassed(text + "\n")

    def test_recommended_terms_pass(self):
        self.assertPassed("위험 카드가 만들어진다. 티켓이 생기지 않는다. 표시된다.\n")


class TestStandingPlaceTerm(Base):
    """기획서 말투 「서는 화면」 계열은 막고, 「여기서는 화면」 처럼 「서는」 을 품은 말은 막지 않는다."""

    def test_phrases_are_caught(self):
        for text in ("결과가 서는 화면을 바꾼다.", "알림이 서는 곳을 정한다.", "버튼이 서는 자리에 둔다.",
                     "서는 화면이 둘이다."):
            with self.subTest(text=text):
                self.assertCaught(text + "\n", "서는")

    def test_ordinary_words_pass(self):
        for text in ("여기서는 화면을 나눈다.", "문서는 곳곳에 예시를 둔다.", "목록에서는 자리를 비운다.",
                     "이 계획서는 화면 설계를 다룬다.", "서버는 곳마다 다르다."):
            with self.subTest(text=text):
                self.assertPassed(text + "\n")

    def test_recommended_term_passes(self):
        self.assertPassed("결과가 보이는 화면을 바꾼다. 알림이 표시되는 곳을 정한다.\n")


class TestRawElementTerm(Base):
    """raw element 를 옮긴 「날 요소」 계열은 막고, 「날짜」 같은 평범한 말은 막지 않는다."""

    def test_phrases_are_caught(self):
        for phrase in ("날 요소", "날 HTML 요소", "날 태그", "날 <button> 대신"):
            with self.subTest(phrase=phrase):
                self.assertCaught(f"{phrase}를 쓴다.\n", "날")

    def test_ordinary_words_pass(self):
        for text in ("날짜를 적는다.", "그 날 요청이 들어왔다.", "오늘날 요소가 많다.",
                     "생일날 태그를 단다.", "날씨 HTML 을 만든다.", "a < b 이면 날 수 있다."):
            with self.subTest(text=text):
                self.assertPassed(text + "\n")

    def test_recommended_term_passes(self):
        self.assertPassed("HTML 기본 요소 대신 컴포넌트를 쓴다.\n")


class TestManualAndFilterTerm(Base):
    """「손으로」 와 filter 를 옮긴 「거르다」 활용형은 막고, 「근거를」 같은 합성어는 막지 않는다."""

    def test_phrases_are_caught(self):
        for text, term in (("파일을 손으로 옮겨 배포한다.", "손으로"),
                           ("조건으로 거르는 방식이다.", "거르"),
                           ("목록을 거른다.", "거른"),
                           ("중복을 거를 수 있다.", "거를"),
                           ("무효 항목을 걸러낸다.", "걸러")):
            with self.subTest(text=text):
                self.assertCaught(text + "\n", term)

    def test_ordinary_words_pass(self):
        for text in ("근거를 남긴다.", "증거를 모은다.", "판단 근거를 적는다.",
                     "빈손으로 돌아왔다.", "맨손으로 만졌다.", "왼손으로 쓴다."):
            with self.subTest(text=text):
                self.assertPassed(text + "\n")

    def test_recommended_terms_pass(self):
        self.assertPassed("메일함 필터링 조건을 추가하고 직접 확인한다.\n")


class TestVersionTerm(Base):
    """version 의 뜻으로 쓴 「판」 은 막고, 다른 낱말 속의 「판」 은 막지 않는다.

    「판」 한 글자는 판단, 판정, 출판 까지 걸려 등록하지 못한다.
    그래서 버전 뜻으로만 쓰이는 구절을 등록하고, 앞 글자가 한글이면(`번호판`, `출판`) 건너뛴다.
    """

    def test_version_phrases_are_caught(self):
        for text in (
            "SDK 판을 올린다.", "라이브러리 판 올리기를 한다.", "배포 판 번호를 적는다.", "의존성 판 고정이 필요하다.",
            "SDK 판이 바뀌었다.", "의존성 판을 고정한다.", "최신 판으로 올린다.", "새 판이 나왔다.",
            "기준 판을 정한다.", "판마다 다르다.", "판 접두사를 붙인다.", "릴리스 판에서 확인한다.",
        ):
            with self.subTest(text=text):
                self.assertCaught(f"{text}\n", "금지어")

    def test_other_words_with_pan_pass(self):
        samples = (
            "원인을 판단한다.", "결과를 판별한다.", "통과 여부를 판정한다.", "문서를 출판한다.",
            "간판을 단다.", "게시판에 올린다.", "게시판을 올려 둔다.", "게시판 번호를 적는다.",
            "간판을 올린다.", "상품을 판매한다.", "판단 기준을 정한다.", "새 판단을 내린다.",
            "번호판 번호를 확인한다.", "출판 번호를 적는다.", "자판 번호를 누른다.",
            "전광판 번호를 본다.", "초판을 올린다.", "철판을 올린다.",
            "바둑판을 올린다.", "계산판 고정 나사.",
            "기준 판단을 내린다.", "새 판단을 한다.", "판별 fixture 를 둔다.", "두 방식은 판이하게 다르다.",
            "판정 결과를 판독한다.", "판례를 찾는다.", "판도가 바뀐다.", "게시판을 올려 둔다.",
        )
        for text in samples:
            with self.subTest(text=text):
                self.assertPassed(f"{text}\n")


class TestWordStartPrefixes(unittest.TestCase):
    """WORD_START_PREFIXES 에 글자가 둘 이상일 때 각각의 글자로 시작하는 금지어에 경계가 걸린다.

    checker-maintenance.md 가 말하는 「막아야 하는 구절과 통과해야 하는 합성어를 함께 넣는다」 의 예시다.
    실제 규칙 파일의 금지어를 쓰지 않으려고 모듈을 읽어 접두사와 금지어를 바꿔 넣는다.
    """

    def setUp(self):
        spec = importlib.util.spec_from_file_location("korean_style_check", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.module.WORD_START_PREFIXES = ("가", "다")
        self.matchers = dict(self.module.build_matchers(["가나", "다라", "마바"]))

    def test_each_prefix_applies_word_start_boundary(self):
        for term in ("가나", "다라"):
            with self.subTest(term=term):
                self.assertTrue(self.matchers[term](f"새 {term} 를 쓴다"))
                self.assertFalse(self.matchers[term](f"초{term} 를 쓴다"))

    def test_term_without_registered_prefix_keeps_substring_match(self):
        self.assertTrue(self.matchers["마바"]("초마바 를 쓴다"))


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

    def test_plus_between_code_spans_is_not_caught(self):
        self.assertNoWarning("`BASE` + `OFFSET` 으로 계산한다.\n")

    def test_plus_between_constants_is_not_caught(self):
        self.assertNoWarning("TIMEOUT + RETRY_DELAY 만큼 기다린다.\n")

    def test_plus_between_code_span_and_constant_is_not_caught(self):
        self.assertNoWarning("`base` + MAX_SIZE 로 상한을 정한다.\n")

    def test_plus_between_words_still_warns(self):
        done = self.run_on("(배포 + 검증) 을 함께 한다.\n")
        self.assertIn("인라인 + 연결", done.stdout)

    def test_plus_between_code_span_and_word_still_warns(self):
        done = self.run_on("`build` + 검증을 함께 한다.\n")
        self.assertIn("인라인 + 연결", done.stdout)


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

    def test_unknown_option_is_reported_as_option_by_check_sh(self):
        path = self.write("a.md", "문제가 없는 문장이다.\n")
        done = subprocess.run(
            [str(SCRIPT.parent / "check.sh"), "--bogus", str(path)],
            capture_output=True, text=True,
        )
        self.assertEqual(done.returncode, 2)
        self.assertIn("다루지 않는 옵션", done.stderr)
        self.assertNotIn("대상이 없다", done.stderr)


class TestAllowFile(Base):
    """저장소의 `.claude/korean-check-allow.txt` 는 그 문자열 안의 발견만 건너뛴다.

    예외가 문자열 밖까지 번지거나 저장소 경계를 넘으면 검사가 조용히 꺼지므로 둘 다 표본으로 고정한다.
    """

    NAME = "시험 던전"

    def make_repo(self, allow_text=None, repo="repo"):
        repo_dir = self.root / repo
        (repo_dir / ".git").mkdir(parents=True)
        (repo_dir / "docs").mkdir()
        if allow_text is not None:
            (repo_dir / ".claude").mkdir()
            (repo_dir / ".claude" / "korean-check-allow.txt").write_text(allow_text, encoding="utf-8")
        return repo_dir

    def run_in(self, repo_dir, text, env_extra=None):
        doc = repo_dir / "docs" / "a.md"
        doc.write_text(text, encoding="utf-8")
        env = {"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin", **(env_extra or {})}
        return subprocess.run(["python3", str(SCRIPT), str(doc)], capture_output=True, text=True, env=env)

    def test_without_allow_file_the_name_is_caught(self):
        repo = self.make_repo()
        done = self.run_in(repo, f"{self.NAME} 입장 조건이다.\n")
        self.assertEqual(done.returncode, 1)

    def test_listed_name_is_skipped(self):
        repo = self.make_repo(f"# 게임 콘텐츠 이름\n\n{self.NAME}\n")
        done = self.run_in(repo, f"{self.NAME} 입장 조건이다.\n")
        self.assertEqual((done.returncode, done.stdout), (0, ""))

    def test_forbidden_word_outside_the_name_is_still_caught(self):
        repo = self.make_repo(f"{self.NAME}\n")
        done = self.run_in(repo, f"{self.NAME} 에서 시험 한다.\n")
        self.assertEqual(done.returncode, 1)
        self.assertIn('"시험"', done.stdout)

    def test_comments_are_not_entries(self):
        repo = self.make_repo(f"# {self.NAME}\n")
        self.assertEqual(self.run_in(repo, f"{self.NAME} 입장이다.\n").returncode, 1)

    def test_single_character_entry_does_not_disable_the_check(self):
        repo = self.make_repo("시\n")
        done = self.run_in(repo, "시험 한다.\n")
        self.assertEqual(done.returncode, 1)
        self.assertIn("너무 짧아", done.stderr)

    def test_allow_file_above_the_repository_boundary_is_not_used(self):
        outer = self.root / "outer"
        (outer / ".claude").mkdir(parents=True)
        (outer / ".claude" / "korean-check-allow.txt").write_text(f"{self.NAME}\n", encoding="utf-8")
        inner = outer / "inner"
        (inner / ".git").mkdir(parents=True)
        (inner / "docs").mkdir()
        self.assertEqual(self.run_in(inner, f"{self.NAME} 입장이다.\n").returncode, 1)

    def test_allow_file_in_a_parent_directory_of_the_same_repository_is_used(self):
        repo = self.make_repo(f"{self.NAME}\n")
        nested = repo / "docs" / "deep"
        nested.mkdir()
        doc = nested / "a.md"
        doc.write_text(f"{self.NAME} 입장이다.\n", encoding="utf-8")
        done = subprocess.run(["python3", str(SCRIPT), str(doc)], capture_output=True, text=True,
                              env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"})
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_env_override_points_at_a_specific_file(self):
        repo = self.make_repo()
        allow = self.write("elsewhere.txt", f"{self.NAME}\n")
        done = self.run_in(repo, f"{self.NAME} 입장이다.\n", {"KOREAN_CHECK_ALLOW": str(allow)})
        self.assertEqual(done.returncode, 0, done.stdout)


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
        # git archive 사본처럼 저장소 밖에서 돌리면 git ls-files 가 실패해 검사할 목록을 얻지 못한다.
        # 저장소 밖이거나 git 이 없을 때만 건너뛴다. .git 이 깨졌거나 소유자가 달라 git 이 거부한 경우는 실패로 둔다.
        try:
            inside = subprocess.run(
                ["git", "rev-parse", "--is-inside-work-tree"], cwd=root,
                capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"},
            )
        except FileNotFoundError:
            self.skipTest("git 이 없어 추적 중인 .md 목록을 얻을 수 없다")
        if inside.returncode != 0:
            if "not a git repository" not in inside.stderr:
                self.fail(f"git 이 저장소를 읽지 못했다: {inside.stderr}")
            self.skipTest("git 저장소 밖이라 추적 중인 .md 목록을 얻을 수 없다")
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
