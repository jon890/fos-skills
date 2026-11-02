"""report 스킬의 검사 스크립트(`scripts/check-report.py`)가 깨진 보고서를 잡고 정상 보고서를 통과시키는지 검증한다."""
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


if __name__ == "__main__":
    unittest.main()
