"""생성된 HTML 과 CLI 종료 코드로 메신저 동작을 검증한다."""

from html.parser import HTMLParser
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


GENERATOR = Path(__file__).resolve().parents[1] / "scripts/dooray-preview/generate.py"


class PreviewParser(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.links = []
        self.alerts = 0
        self.text = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a":
            self.links.append(attrs.get("href"))
        if attrs.get("role") == "alert":
            self.alerts += 1

    def handle_data(self, data):
        self.text.append(data)


class DoorayPreviewTests(unittest.TestCase):
    def generate(self, body, mode="messenger", strict=False):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "preview.html"
            command = [sys.executable, str(GENERATOR), "--mode", mode,
                       "--title", "example channel", "--author", "example author",
                       "--md-file", "-", "--out", str(out)]
            if strict:
                command.append("--strict")
            result = subprocess.run(command, input=body, text=True, capture_output=True)
            return result, out.read_text() if out.exists() else ""

    def test_messenger_renders_only_verified_links(self):
        body = ('[@example](dooray://example/members/example "member")\n'
                'https://example.com/project/tasks/example\n'
                '**bold**\n- item\n`code`\n```python\npass\n```\n'
                '[example](https://example.com/page)')
        result, source = self.generate(body)
        parsed = PreviewParser(source)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertEqual(parsed.links, ["dooray://example/members/example",
                                       "https://example.com/project/tasks/example"])
        text = "".join(parsed.text)
        self.assertIn("example channel", text)
        self.assertIn("example author", text)
        self.assertIn('**bold**\n- item\n`code`\n```python\npass\n```', text)
        self.assertIn('[example](https://example.com/page)', text)
        self.assertNotIn("<strong>", source)

    def test_warning_and_strict_exit_still_generate_html(self):
        for resource in ("tasks", "pages"):
            for strict in (False, True):
                with self.subTest(resource=resource, strict=strict):
                    body = f'[example](dooray://example/{resource}/example "working")'
                    result, source = self.generate(body, strict=strict)
                    parsed = PreviewParser(source)
                    self.assertEqual(result.returncode, int(strict))
                    self.assertEqual(parsed.alerts, 1)
                    self.assertEqual(parsed.links, [])
                    self.assertIn(result.stderr.strip(), "".join(parsed.text))
                    self.assertIn("https", result.stderr)
                    self.assertLess(source.index('role="alert"'), source.index('class="dooray-head"'))
                    self.assertIn(body, "".join(parsed.text))

    def test_no_warning_for_verified_links_even_when_strict(self):
        result, source = self.generate(
            '[@example](dooray://example/members/example "member") https://example.com', strict=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertEqual(PreviewParser(source).alerts, 0)

    def test_html_is_text_and_url_attributes_are_escaped(self):
        result, source = self.generate('<img src=x onerror=alert(1)> </script>\nhttps://example.com/?a=1&b=2')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('<img src=x', source)
        self.assertIn('&lt;/script&gt;', source)
        self.assertEqual(PreviewParser(source).links, ['https://example.com/?a=1&b=2'])

    def test_url_sentence_punctuation_and_balanced_parentheses(self):
        _, source = self.generate('(https://example.com/path). https://example.com/a(b)')
        self.assertEqual(PreviewParser(source).links, ['https://example.com/path', 'https://example.com/a(b)'])

    def test_body_template_markers_remain_literal(self):
        result, source = self.generate('{{MD_BODY}} {{MODE}} {{WARNING_HTML}}')
        self.assertEqual(result.returncode, 0)
        self.assertIn('{{MD_BODY}} {{MODE}} {{WARNING_HTML}}', "".join(PreviewParser(source).text))

    def test_task_and_comment_modes_preserve_viewer_body(self):
        body = '[example](dooray://example/tasks/example "working")\n**bold**'
        for mode in ("task", "comment"):
            with self.subTest(mode=mode):
                result, source = self.generate(body, mode=mode, strict=True)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "")
                self.assertIn(body, source)
                self.assertEqual(PreviewParser(source).alerts, 0)
                self.assertIn(f'data-mode="{mode}"', source)


if __name__ == "__main__":
    unittest.main()
