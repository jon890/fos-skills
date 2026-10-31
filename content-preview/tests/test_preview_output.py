"""생성기가 이전 산출물을 스스로 지우고 원자적으로 덮어쓰는지 검증한다."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
GENERATORS = {
    "dooray": (SCRIPTS / "dooray-preview/generate.py", ["--mode", "comment"]),
    "github": (SCRIPTS / "github-preview/generate.py", ["--type", "pr"]),
}
STALE = "STALE-PREVIEW"


def run_generator(name, md_file, out, body=None):
    script, extra = GENERATORS[name]
    command = [sys.executable, str(script), *extra, "--title", "example",
               "--md-file", md_file, "--out", str(out)]
    return subprocess.run(command, input=body, text=True, capture_output=True)


class GeneratorOutputTests(unittest.TestCase):
    def test_overwrites_previous_output_without_leftovers(self):
        for name in GENERATORS:
            with self.subTest(generator=name), tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "preview.html"
                out.write_text(STALE, encoding="utf-8")
                result = run_generator(name, "-", out, body="new body")
                self.assertEqual(result.returncode, 0)
                text = out.read_text(encoding="utf-8")
                self.assertIn("new body", text)
                self.assertNotIn(STALE, text)
                self.assertEqual([p.name for p in Path(tmp).iterdir()], ["preview.html"])

    def test_failure_removes_previous_output(self):
        for name in GENERATORS:
            with self.subTest(generator=name), tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "preview.html"
                out.write_text(STALE, encoding="utf-8")
                result = run_generator(name, "-", out, body="bad </script> body")
                self.assertEqual(result.returncode, 1)
                self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_missing_body_file_removes_previous_output(self):
        for name in GENERATORS:
            with self.subTest(generator=name), tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "preview.html"
                out.write_text(STALE, encoding="utf-8")
                result = run_generator(name, str(Path(tmp) / "missing.md"), out)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
