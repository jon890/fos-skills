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
        self.assertCaught("# 미리 주어지는 것과 직접 쓰는 것을 가른다\n", "가른다")

    def test_deep_heading_is_scanned(self):
        self.assertCaught("#### 무엇을 가른다\n", "가른다")

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
        self.assertCaught("[가른다](https://example.com/a)\n", "가른다")

    def test_link_definition_line_is_skipped(self):
        self.assertPassed("[ref]: https://example.com/가른다\n")


class TestConjugation(Base):
    """등록 형태가 좁으면 같은 낱말의 다른 활용형이 빠져나간다."""

    def test_registered_forms_are_caught(self):
        for form in ("가른다", "가르는", "갈랐다", "가르지", "가르고", "가르며", "가름"):
            with self.subTest(form=form):
                self.assertCaught(f"둘을 {form} 자리다.\n", form)

    def test_attributive_form_is_caught(self):
        self.assertCaught("이미 가른 자리다.\n", "가른")


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


class TestExitCode(Base):
    """종료 코드 규약. 0 통과, 1 위반, 2 돌지 못함이다."""

    def test_clean_file_is_zero(self):
        self.assertPassed("문제가 없는 문장이다.\n")

    def test_missing_path_is_zero_here_and_two_in_check_sh(self):
        """없는 경로를 이 검사기는 건너뛰고 0 으로 끝낸다.

        `check.sh` 가 앞에서 2 로 막으므로 실사용에서는 드러나지 않는다.
        직접 부르는 쪽은 오타 난 경로가 통과로 보이므로, 현재 동작을 여기 고정해 둔다.
        """
        done = subprocess.run(
            ["python3", str(SCRIPT), str(self.root / "없다.md")],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 0)

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

    def test_no_argument_is_zero(self):
        done = subprocess.run(
            ["python3", str(SCRIPT)],
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 0)


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
        self.assertIn("가른다", done.stdout)

    def test_clean_file_exits_zero(self):
        done = self.hook(self.write("a.md", "문제가 없는 문장이다.\n"))
        self.assertEqual(done.returncode, 0)


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
        self.assertTrue(files, "검사할 .md 를 찾지 못했다")
        done = subprocess.run(
            ["python3", str(SCRIPT), *files], cwd=root,
            capture_output=True, text=True,
            env={"KOREAN_STYLE_RULES": str(RULES), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 0, done.stdout)


if __name__ == "__main__":
    unittest.main()
