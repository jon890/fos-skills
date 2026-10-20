"""spec-line.py 가 지시서의 `허락:` 줄을 첫 지시 줄에 붙이는지 검증한다."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "spec-line.py"


class SpecLineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.spec = self.tmp / "spec-x.md"

    def line(self, body, *args):
        self.spec.write_text(body, encoding="utf-8")
        return subprocess.run(["python3", str(SCRIPT), str(self.spec), *args], capture_output=True, text=True)

    def test_permission_is_put_into_the_first_line(self):
        r = self.line("# 지시서\n브랜치: `feature/x`\n허락: push 와 draft PR 생성(base main)은 사용자가 허락했다.\n")
        self.assertEqual(0, r.returncode, r.stderr)
        self.assertEqual(
            f"지시서 {self.spec.resolve()} 를 끝까지 읽고 수행한다. push 와 draft PR 생성(base main)은 사용자가 허락했다."
            " 못 읽으면 escalation 으로 알린다.",
            r.stdout.strip())

    def test_list_and_bold_forms_and_several_lines(self):
        r = self.line("- **허락:** push 는 사용자가 허락했다\n* 허락: PR 생성은 사용자가 허락했다.\n")
        self.assertIn("push 는 사용자가 허락했다. PR 생성은 사용자가 허락했다. 못 읽으면", r.stdout)

    def test_without_permission_line(self):
        r = self.line("# 지시서\nPR 은 열지 않는다.\n")
        self.assertEqual(0, r.returncode)
        self.assertEqual(f"지시서 {self.spec.resolve()} 를 끝까지 읽고 수행한다. 못 읽으면 escalation 으로 알린다.",
                         r.stdout.strip())
        self.assertEqual(1, self.line("# 지시서\n", "--require-permission").returncode)

    def test_missing_spec(self):
        r = subprocess.run(["python3", str(SCRIPT), str(self.tmp / "none.md")], capture_output=True, text=True)
        self.assertEqual(2, r.returncode)


if __name__ == "__main__":
    unittest.main()
