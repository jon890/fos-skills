#!/usr/bin/env python3
"""static_check 의 검출력 검사.

각 검사마다 걸리는 표본과 걸리지 않는 표본을 함께 둔다.
걸리는 쪽만 두면 그 검사가 모든 것을 잡는 상태가 돼도 통과한다.
"""

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "static_check.py"
spec = importlib.util.spec_from_file_location("static_check", SCRIPT)
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)


def lines(text):
    return text.splitlines()


class TestUnit(unittest.TestCase):
    def test_slug_drops_punctuation_and_keeps_hangul(self):
        self.assertEqual(sc.slug("E. ADR 자명성"), "e-adr-자명성")
        self.assertEqual(sc.slug("A. 부패"), "a-부패")

    def test_anchors_number_duplicate_headings(self):
        found = sc.anchors_of(lines("## 같은 이름\n## 같은 이름\n## 같은 이름"))
        self.assertEqual(found, {"같은-이름", "같은-이름-1", "같은-이름-2"})

    def test_anchors_skip_code_fence(self):
        self.assertEqual(sc.anchors_of(lines("```\n## 가짜\n```")), set())

    def test_is_local_rejects_schemes_and_site_root(self):
        for target in ("https://a/b", "dooray://task/1", "/nhncloud/ko", "mailto:a@b"):
            self.assertFalse(sc.is_local(target), target)
        for target in ("other.md", "../a/b.md", "sub/c.md"):
            self.assertTrue(sc.is_local(target), target)

    def test_table_column_mismatch(self):
        body = "| 머리 | 값 |\n| --- | --- |\n| 하나 |"
        found = sc.check_markdown(Path("t.md"), lines(body))
        self.assertEqual(len(found), 1)
        self.assertIn("표 열 수 불일치", found[0])

    def test_table_with_matching_columns_passes(self):
        body = "| 머리 | 값 |\n| --- | --- |\n| 하나 | 1 |"
        self.assertEqual(sc.check_markdown(Path("t.md"), lines(body)), [])

    def test_escaped_pipe_in_code_span_is_not_a_column(self):
        """실측 오탐 둘. 코드 스팬 안의 `\\|` 를 열 구분자로 세었다."""
        head = "| 이름 | 설명 | 처리 |\n| --- | --- | --- |\n"
        cases = (
            "| `table_cell_health` | 셀 안의 `\\|` 를 센다 | 고쳤다 |",
            "| 배포 방식 | `[Ship\\|Show\\|Ask]` 로 적는다 | 그대로 |",
        )
        for row in cases:
            with self.subTest(row=row):
                found = sc.check_markdown(Path("t.md"), lines(head + row))
                self.assertEqual(found, [])

    def test_bare_pipe_in_code_span_still_counts(self):
        """GFM 은 백틱 안의 맨 파이프도 셀을 가른다. 그래서 이것은 진짜 어긋남이다."""
        body = "| 머리 | 값 |\n| --- | --- |\n| `a|b` | 1 |"
        found = sc.check_markdown(Path("t.md"), lines(body))
        self.assertEqual(len(found), 1)
        self.assertIn("표 열 수 불일치", found[0])

    def test_escaped_backslash_before_pipe_is_a_column(self):
        """`\\\\|` 는 역슬래시 다음의 진짜 구분자다. 지워서 놓치지 않는다."""
        body = "| 머리 | 값 |\n| --- | --- |\n| 경로\\\\ | 1 | 남는다 |"
        found = sc.check_markdown(Path("t.md"), lines(body))
        self.assertEqual(len(found), 1)

    def test_heading_level_skip(self):
        found = sc.check_markdown(Path("t.md"), lines("# 하나\n#### 넷"))
        self.assertEqual(len(found), 1)
        self.assertIn("헤딩 레벨 건너뜀", found[0])

    def test_sequential_heading_levels_pass(self):
        self.assertEqual(sc.check_markdown(Path("t.md"), lines("# 하나\n## 둘\n### 셋")), [])

    def test_unclosed_fence(self):
        found = sc.check_markdown(Path("t.md"), lines("# 제목\n```bash\necho 열림"))
        self.assertEqual(len(found), 1)
        self.assertIn("코드 펜스", found[0])

    def test_shell_comment_in_fence_is_not_heading(self):
        body = "# 하나\n\n```bash\n#### 셸 주석\n| 표 | 아님 |\n```"
        self.assertEqual(sc.check_markdown(Path("t.md"), lines(body)), [])

    def test_plan_ref_catches_prose_path_and_frontmatter(self):
        for body, want in (
            ("이 결정의 출처는 (ADR-008, plan051) 이다.", 1),
            ("구현은 `tasks/plan059-foo/` 에 있다.", 1),
            ("source: [plan037, plan041]", 2),
            ("plan-018 을 본다.", 1),
        ):
            found = sc.check_plan_ref(Path("docs/a.md"), lines(body))
            self.assertEqual(len(found), want, body)
            self.assertIn("PLAN_REF", found[0])

    def test_plan_ref_skips_identifier_placeholder_and_fence(self):
        for body in (
            "`tests/unit/test_plan032_error_classify.py` 를 본다.",
            "`tasks/plan{N}-{slug}/` 를 만든다.",
            "사고 사례(plan###)는 1개로 충분하다.",
            "```\ntasks/plan051/\n```",
        ):
            self.assertEqual(sc.check_plan_ref(Path("docs/a.md"), lines(body)), [], body)

    def test_plan_ref_skips_file_inside_plan_dir(self):
        body = "plan059 의 두 번째 phase 다."
        path = Path("tasks/plan059-foo/phase-01.md")
        self.assertEqual(sc.check_plan_ref(path, lines(body)), [])


class TestRepo(unittest.TestCase):
    """실제 git 저장소에서 파일 수집과 종료 코드를 본다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.git("init", "-q", ".")
        self.git("config", "user.email", "t@t")
        self.git("config", "user.name", "t")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def write(self, name, body):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")

    def invoke(self, *args):
        return subprocess.run(
            ["python3", str(SCRIPT), *args],
            cwd=self.root, capture_output=True, text=True,
        )

    def test_hangul_filename_is_checked(self):
        """git ls-files 가 비ASCII 경로를 이스케이프해 통째로 빠지던 자리다."""
        self.write("한글 이름.md", "# 제목\n\n[깨짐](없다.md)\n")
        done = self.invoke()
        self.assertEqual(done.returncode, 1)
        self.assertIn("한글 이름.md", done.stdout)
        self.assertIn("1개", done.stderr)

    def test_untracked_file_is_checked(self):
        self.write("새문서.md", "# 제목\n\n[깨짐](없다.md)\n")
        self.assertEqual(self.invoke().returncode, 1)

    def test_gitignored_file_is_skipped(self):
        self.write(".gitignore", "무시.md\n")
        self.write("무시.md", "# 제목\n\n[깨짐](없다.md)\n")
        self.write("정상.md", "# 제목\n")
        done = self.invoke()
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_no_markdown_is_not_a_pass(self):
        self.write("code.py", "x = 1\n")
        done = self.invoke()
        self.assertEqual(done.returncode, 2)

    def test_index_desync_detected(self):
        self.write("docs/adr/ADR-001.md", "# 하나\n\n## ADR-001 첫 결정\n")
        self.write("docs/adr/ADR-002.md", "# 둘\n\n## ADR-002 둘째 결정\n")
        self.write("docs/adr/INDEX.md", "# INDEX\n\n- [ADR-001](ADR-001.md)\n")
        done = self.invoke("docs/adr")
        self.assertEqual(done.returncode, 1)
        self.assertIn("INDEX_DESYNC", done.stdout)
        self.assertIn("ADR-002", done.stdout)

    def test_index_in_sync_passes_with_list_and_table_forms(self):
        self.write("docs/adr/ADR-001.md", "# 하나\n\n## ADR-001 첫 결정\n")
        self.write("docs/adr/ADR-002.md", "# 둘\n\n## ADR-002 둘째 결정\n")
        self.write(
            "docs/adr/INDEX.md",
            "# INDEX\n\n- [ADR-001](ADR-001.md)\n\n| 번호 | 제목 |\n| --- | --- |\n"
            "| ADR-002 | 둘째 |\n\n향후 ADR은 ADR-009부터 추가한다.\n",
        )
        done = self.invoke("docs/adr")
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_missing_index_skips_the_check(self):
        self.write("docs/adr/ADR-001.md", "# 하나\n\n## ADR-001 첫 결정\n")
        done = self.invoke("docs/adr")
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_missing_adr_dir_is_usage_error(self):
        self.write("a.md", "# 제목\n")
        self.assertEqual(self.invoke("없는디렉터리").returncode, 2)

    def test_missing_scope_is_usage_error(self):
        self.write("a.md", "# 제목\n")
        self.assertEqual(self.invoke("", "없는경로").returncode, 2)

    def test_outside_git_is_usage_error(self):
        with tempfile.TemporaryDirectory() as plain:
            done = subprocess.run(
                ["python3", str(SCRIPT)], cwd=plain, capture_output=True, text=True,
                env={**os.environ, "GIT_CEILING_DIRECTORIES": plain},
            )
            self.assertEqual(done.returncode, 2)

    def test_cross_file_anchor(self):
        self.write("a.md", "# 하나\n\n[정상](b.md#비-절)\n[깨짐](b.md#없다)\n")
        self.write("b.md", "# 비\n\n## 비 절\n")
        done = self.invoke()
        self.assertEqual(done.returncode, 1)
        self.assertIn("b.md#없다", done.stdout)
        self.assertNotIn("b.md#비-절", done.stdout)


if __name__ == "__main__":
    unittest.main()
