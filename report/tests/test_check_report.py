"""report 스킬의 검사 스크립트(`scripts/check-report.py`)가 깨진 보고서를 잡고 정상 보고서를 통과시키는지 검증한다."""
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SKILL = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = SKILL / "scripts" / "check-report.py"

OK_BODY = """<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>t</title>
<style>body{color:#000}.x{background:url(data:image/png;base64,AAAA)}</style></head>
<body>
<nav><a href="#concl">결론</a></nav>
<section id="concl"><p>본문이다 <a class="ref" href="#src-A1">[A1]</a>.</p>
<p>밖의 글은 <a href="https://example.com/doc">여기</a> 에 있다.</p>
<img src="data:image/png;base64,AAAA" alt="">
</section>
<table><tbody><tr id="src-A1"><td>A1</td><td><a href="https://example.com">문서</a></td></tr></tbody></table>
</body></html>
"""


def run(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False
    )


class CheckReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, body, name="sample-report.html"):
        path = self.dir / name
        path.write_text(body, encoding="utf-8")
        return path

    def assert_fails(self, body, kind, name="sample-report.html"):
        result = run(str(self.write(body, name)))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f": {kind}: ", result.stdout)
        return result

    def test_ok_report_passes(self):
        result = run(str(self.write(OK_BODY)))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("통과", result.stdout)

    def test_external_script(self):
        self.assert_fails(OK_BODY.replace("</head>", '<script src="https://cdn.example.com/a.js"></script></head>'), "external")

    def test_relative_stylesheet(self):
        self.assert_fails(OK_BODY.replace("</head>", '<link rel="stylesheet" href="x.css"></head>'), "external")

    def test_relative_image(self):
        self.assert_fails(OK_BODY.replace('src="data:image/png;base64,AAAA"', 'src="a.png"'), "external")

    def test_css_url_and_import(self):
        self.assert_fails(OK_BODY.replace("body{color:#000}", "body{background:url(https://x.example/bg.png)}"), "external")
        self.assert_fails(OK_BODY.replace("<style>", "<style>@import 'https://fonts.example/f.css';"), "external")

    def test_inline_style_url(self):
        self.assert_fails(OK_BODY.replace("<section ", '<section style="background:url(bg.png)" '), "external")

    def test_svg_use_and_meta_refresh(self):
        self.assert_fails(OK_BODY.replace("</section>", '<svg><use href="icons.svg#a"/></svg></section>'), "external")
        self.assert_fails(OK_BODY.replace("<title>", '<meta http-equiv="refresh" content="0; url=https://x.example"><title>'), "external")

    def test_svg_internal_use_passes(self):
        body = OK_BODY.replace("</section>", '<svg><defs><g id="dot"></g></defs><use href="#dot"/></svg></section>')
        self.assertEqual(run(str(self.write(body))).returncode, 0)

    def test_unclosed_tag(self):
        self.assert_fails(OK_BODY.replace("</section>", "<div></section>"), "tag")

    def test_crossed_tags(self):
        self.assert_fails(OK_BODY.replace("<p>본문", "<div><span>x</div></span><p>본문"), "tag")

    def test_missing_ref_target(self):
        self.assert_fails(OK_BODY.replace('href="#src-A1"', 'href="#src-B9"'), "ref")

    def test_unreferenced_source(self):
        body = OK_BODY.replace("</tbody>", '<tr id="src-Y"><td>Y</td><td>안 쓴 출처</td></tr></tbody>')
        self.assert_fails(body, "source")

    def test_duplicate_id(self):
        self.assert_fails(OK_BODY.replace("<nav>", '<nav id="concl">'), "id")

    def test_name_not_slug(self):
        self.assert_fails(OK_BODY, "name", name="My Report.html")

    def test_missing_file(self):
        self.assertEqual(run(str(self.dir / "none.html")).returncode, 2)

    def test_no_args(self):
        self.assertEqual(run().returncode, 2)

    def test_template_passes(self):
        """공통 틀을 그대로 복사한 보고서가 검사를 통과한다. 틀이 외부 자원과 깨진 각주를 갖지 않는다."""
        body = (SKILL / "assets" / "template.html").read_text(encoding="utf-8")
        result = run(str(self.write(body, "template-sample.html")))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_text_mode(self):
        body = OK_BODY.replace(
            "</section>",
            "<p>코드 <code>secret_code</code> 끝</p><script>var hidden=1;</script></section>",
        )
        result = run("--text", str(self.write(body)))
        self.assertEqual(result.returncode, 0)
        lines = result.stdout.splitlines()
        self.assertIn("A1", lines)
        self.assertIn("문서", lines)
        self.assertIn("코드 끝", lines)
        self.assertNotIn("secret_code", result.stdout)
        self.assertNotIn("hidden", result.stdout)
        self.assertNotIn("color", result.stdout)

    def test_text_mode_escapes_markdown_line_heads(self):
        """줄 머리의 <, |, # 가 korean-check 에서 HTML, 표 행, 제목으로 읽혀 빠지지 않게 \\ 를 붙인다."""
        body = OK_BODY.replace("</section>", "<p>&lt;저장소&gt; 경로</p><p>| 칸</p><p># 번호</p></section>")
        lines = run("--text", str(self.write(body))).stdout.splitlines()
        self.assertIn("\\<저장소> 경로", lines)
        self.assertIn("\\| 칸", lines)
        self.assertIn("\\# 번호", lines)

    def test_korean_finds_banned_word(self):
        bad = OK_BODY.replace("본문이다", "트리아지 결과다")
        result = run("--korean", str(self.write(bad)))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("트리아지", result.stdout)
        self.assertIn("sample-report.html", result.stdout)

    def test_korean_banned_word_in_table_cell(self):
        bad = OK_BODY.replace("<td>A1</td>", "<td>| 트리아지</td>")
        self.assertEqual(run("--korean", str(self.write(bad))).returncode, 1)

    def test_korean_passes_clean_report(self):
        self.assertEqual(run("--korean", str(self.write(OK_BODY))).returncode, 0)

    def test_korean_without_checker_exits_2(self):
        """korean-check 를 찾지 못하면 통과로 보이지 않게 종료 코드 2 로 끝난다."""
        scripts = self.dir / "lonely" / "report" / "scripts"
        scripts.mkdir(parents=True)
        copy = scripts / "check-report.py"
        copy.write_text(SCRIPT.read_text(encoding="utf-8"), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k != "KOREAN_CHECK"}
        env["HOME"] = str(self.dir / "home")
        result = subprocess.run(
            [sys.executable, str(copy), "--korean", str(self.write(OK_BODY))],
            capture_output=True, text=True, check=False, env=env,
        )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("korean-check", result.stderr)


class TemplateTest(unittest.TestCase):
    TEMPLATE = SKILL / "assets" / "template.html"

    def test_template_has_every_part(self):
        """스펙 R4 의 부품이 공통 틀에 모두 있다."""
        body = self.TEMPLATE.read_text(encoding="utf-8")
        for marker in (
            'class="toc"', 'class="top"', 'class="meta"', 'class="lead"', 'class="concl"',
            'class="chip y"', 'class="chip p"', 'class="chip n"', 'class="chip x"',
            'class="steps"', 'class="callout"', "<details", 'id="srcbox"', 'class="ref"',
        ):
            self.assertIn(marker, body, marker)

    def test_template_korean(self):
        self.assertEqual(run("--korean", str(self.TEMPLATE)).returncode, 0)


if __name__ == "__main__":
    unittest.main()


class SkillDocTest(unittest.TestCase):
    """스펙 R1(부르는 말)과 R8(다른 스킬과 나누는 문장)이 SKILL.md 에 남아 있는지 본다."""

    R8 = "청중 앞에서 넘기며 말하는 발표는 `presentation`, 외부에 게시할 글은 `content-preview`, 혼자 읽는 설명과 보고서는 `report`"

    def setUp(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        _, front, self.body = text.split("---", 2)
        self.description = front.split("description:", 1)[1].split("metadata:", 1)[0]

    def test_description_has_trigger_phrases(self):
        for phrase in ("/report", "HTML 로 시각화해서 설명", "보고서로 만들어", "한눈에 보이게 정리"):
            self.assertIn(phrase, self.description, phrase)

    def test_description_and_body_separate_siblings(self):
        self.assertIn(self.R8, " ".join(self.description.split()))
        self.assertIn(self.R8, self.body)
