#!/usr/bin/env python3
"""check-readability 의 검출력 검사.

검사마다 걸리는 표본과 걸리지 않는 표본을 함께 둔다.
걸리는 쪽만 두면 그 검사가 모든 것을 잡는 상태가 돼도 통과한다.

**허용 예외가 이 파일의 중심이다.**
DASH 는 목록과 표에서 이름과 설명을 나누는 용도를 허용하고,
TILDE 는 이스케이프한 물결표를 세지 않는다.
예외를 넓히는 변경은 조용히 통과하므로 표본으로 고정한다.
"""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check-readability.py"


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
        return subprocess.run(
            ["python3", str(SCRIPT), str(self.write(name, text))],
            capture_output=True, text=True,
        )

    def assertCaught(self, text, code):
        done = self.run_on(text)
        self.assertEqual(done.returncode, 1, f"통과하면 안 되는 표본이 통과했다: {text!r}")
        self.assertIn(f"[{code}]", done.stdout)

    def assertPassed(self, text):
        done = self.run_on(text)
        self.assertEqual(done.returncode, 0, f"걸리면 안 되는 표본이 걸렸다: {done.stdout}")


class TestNest(Base):
    """NEST 는 괄호 2겹 중첩을 잡는다."""

    def test_nested_paren_is_caught(self):
        self.assertCaught("값을 범위로 제한한다 (하한 (0) 과 상한).\n", "NEST")

    def test_sibling_parens_are_not_caught(self):
        self.assertPassed("값을 (하한) 과 (상한) 으로 제한한다.\n")


class TestSect(Base):
    """SECT 는 `§` 를 잡는다."""

    def test_section_mark_is_caught(self):
        self.assertCaught("자세한 것은 §3 에 있다.\n", "SECT")

    def test_word_section_is_not_caught(self):
        self.assertPassed("자세한 것은 3장에 있다.\n")


class TestTilde(Base):
    """TILDE 는 한 단락의 물결표 둘을 잡는다. 취소선으로 렌더되기 때문이다."""

    def test_two_tildes_in_one_paragraph_are_caught(self):
        self.assertCaught("범위는 3~5 이고 다른 것은 7~9 다.\n", "TILDE")

    def test_one_tilde_is_not_caught(self):
        self.assertPassed("범위는 3~5 다.\n")

    def test_escaped_tildes_are_not_caught(self):
        self.assertPassed("범위는 3\\~5 이고 다른 것은 7\\~9 다.\n")

    def test_tildes_in_separate_paragraphs_are_not_caught(self):
        self.assertPassed("범위는 3~5 다.\n\n다른 것은 7~9 다.\n")


class TestDash(Base):
    """DASH 는 절과 절을 잇는 엠대시를 잡고, 이름과 설명을 나누는 용도는 허용한다."""

    def test_em_dash_in_prose_is_caught(self):
        self.assertCaught("검사기를 고쳤다 — 제목이 빠져 있었다.\n", "DASH")

    def test_em_dash_in_heading_is_caught(self):
        self.assertCaught("## 검사 범위 — 제목까지\n", "DASH")

    def test_em_dash_in_list_item_is_allowed(self):
        self.assertPassed("- `check.sh` — 검사기 둘을 함께 돌린다\n")

    def test_em_dash_in_table_row_is_allowed(self):
        self.assertPassed("| `check.sh` — 묶음 | 둘을 돌린다 |\n| --- | --- |\n")


class TestExclusion(Base):
    """가독성 검사도 코드 블록과 코드 스팬을 제외한다."""

    def test_code_fence_is_skipped(self):
        self.assertPassed("```\nvalue = f(g(x))\n```\n")

    def test_code_span_is_skipped(self):
        self.assertPassed("`f(g(x))` 를 부른다.\n")


class TestTextMode(Base):
    """문자열 모드. 제목과 커밋 메시지가 이 경로로 들어온다."""

    def run_text(self, text):
        return subprocess.run(
            ["python3", str(SCRIPT), "--text", text],
            capture_output=True, text=True,
        )

    def test_violation_in_text_exits_one(self):
        done = self.run_text("검사기를 고쳤다 — 제목이 빠져 있었다")
        self.assertEqual(done.returncode, 1)
        self.assertIn("[DASH]", done.stdout)

    def test_clean_text_exits_zero(self):
        done = self.run_text("fix(korean-check): 제목을 검사 대상에 넣는다")
        self.assertEqual(done.returncode, 0)


class TestHookMode(Base):
    """훅 모드는 위반이 있어도 0 으로 끝난다. 편집을 막지 않고 결과만 알린다."""

    def hook(self, path):
        payload = json.dumps({"tool_input": {"file_path": str(path)}})
        return subprocess.run(
            ["python3", str(SCRIPT), "--hook"],
            input=payload, capture_output=True, text=True,
        )

    def test_violation_still_exits_zero(self):
        done = self.hook(self.write("a.md", "고쳤다 — 빠져 있었다.\n"))
        self.assertEqual(done.returncode, 0)
        self.assertIn("DASH", done.stdout)

    def test_clean_file_exits_zero(self):
        done = self.hook(self.write("a.md", "문제가 없는 문장이다.\n"))
        self.assertEqual(done.returncode, 0)


class TestExitCode(Base):
    """종료 코드 규약. 0 통과, 1 위반, 2 사용법 오류다."""

    def test_no_argument_is_two(self):
        done = subprocess.run(
            ["python3", str(SCRIPT)], capture_output=True, text=True,
        )
        self.assertEqual(done.returncode, 2)


class TestRepository(unittest.TestCase):
    """이 저장소 자신이 자기 규칙을 지키는지 본다."""

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
        )
        self.assertEqual(done.returncode, 0, done.stdout)


if __name__ == "__main__":
    unittest.main()
