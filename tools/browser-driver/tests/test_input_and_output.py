"""출력 분리, js 의 여러 문장과 --timeout, jsfile, 마우스 명령을 시험한다. 실제 브라우저는 열지 않는다.

하위 프로세스 시험은 PATH 에 가짜 ego-browser 를 둬 stdout 과 stderr 의 경계를 확인한다.
스크립트 실행 시험은 Node 로 ego 가 만든 스크립트를 가짜 page 에 대고 돌린다.
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from driver.args import parse_js_args, parse_pointer_args
from driver.backends.ego import EgoBackend, MARKER, NOTICE
from driver.errors import UsageError

ROOT = Path(__file__).resolve().parent.parent
ENTRY = ROOT / "browser_driver.py"
NODE = shutil.which("node")


class FakeEgo:
    """stdin 의 스크립트를 파일에 남기고, 정해 둔 출력을 stdout 으로 내는 ego-browser."""

    def __init__(self, stdout):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        bin_dir = base / "bin"
        bin_dir.mkdir()
        self.script_log = base / "stdin.js"
        out_file = base / "stdout.txt"
        out_file.write_text(stdout, encoding="utf-8")
        exe = bin_dir / "ego-browser"
        exe.write_text(f"#!/bin/sh\ncat > '{self.script_log}'\ncat '{out_file}'\n")
        exe.chmod(0o755)
        self.env = {**os.environ, "PATH": str(bin_dir) + os.pathsep + "/usr/bin:/bin",
                    "BROWSER_DRIVER": "ego", "BROWSER_CONFIG": str(base / "none.json")}
        for key in ("BROWSER_EGO_SPACE", "BROWSER_EGO_PROFILE", "BROWSER_EGO_PURPOSE"):
            self.env.pop(key, None)

    def run(self, *args):
        return subprocess.run([sys.executable, str(ENTRY), *args], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def script(self):
        return self.script_log.read_text(encoding="utf-8")

    def close(self):
        self.tmp.cleanup()


class OutputSeparationTest(unittest.TestCase):
    def fake(self, stdout):
        f = FakeEgo(stdout)
        self.addCleanup(f.close)
        return f

    def test_open_stdout_is_exactly_one_handle_line(self):
        f = self.fake(f"\n{MARKER}\n9:p2\tDefault\tPersonal\tbrowser-driver/Default{NOTICE} 업데이트가 있다")
        r = f.run("open", "about:blank")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "9:p2\n")
        self.assertIn("공간: browser-driver/Default", r.stderr)
        self.assertIn(NOTICE, r.stderr)

    def test_js_result_is_separated_from_trailing_notice(self):
        f = self.fake(f'\n{MARKER}\n"hello"{NOTICE} 업데이트가 있다\n')
        r = f.run("js", "9:p2", "'hello'")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "hello\n")
        self.assertNotIn("업데이트", r.stdout)
        self.assertIn(NOTICE, r.stderr)

    def test_without_notice_nothing_extra_on_stderr(self):
        f = self.fake(f'\n{MARKER}\n"hello"')
        r = f.run("js", "9:p2", "'hello'")
        self.assertEqual((r.stdout, r.stderr), ("hello\n", ""))

    def test_jsfile_sends_file_content_as_expression(self):
        f = self.fake(f'\n{MARKER}\n3')
        src = Path(f.tmp.name) / "probe.js"
        src.write_text("const a = 1;\na + 2", encoding="utf-8")
        r = f.run("jsfile", "9:p2", str(src), "--timeout", "40000")
        self.assertEqual((r.returncode, r.stdout), (0, "3\n"), r.stderr)
        self.assertIn("const a = 1;\\na + 2", f.script())
        self.assertIn("timeout: 40000", f.script())

    def test_jsfile_missing_file_is_usage_error(self):
        r = self.fake("").run("jsfile", "9:p2", "/no/such/file.js")
        self.assertEqual(r.returncode, 2)

    def test_help_lists_new_commands_as_supported_on_ego(self):
        lines = self.fake("").run("help").stdout.splitlines()
        for name in ("jsfile", "click", "drag", "hover"):
            line = next(l for l in lines if l.startswith(f"  {name} "))
            self.assertNotIn("(이 백엔드는 못 씀)", line)
        self.assertTrue(any("--timeout" in l for l in lines))


class OtherBackendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        bin_dir = Path(self.tmp.name) / "bin"
        bin_dir.mkdir()
        exe = bin_dir / "orca"
        exe.write_text("#!/bin/sh\necho '{\"ok\":true,\"result\":{\"result\":\"x\"}}'\n")
        exe.chmod(0o755)
        self.env = {**os.environ, "PATH": str(bin_dir) + os.pathsep + "/usr/bin:/bin",
                    "BROWSER_DRIVER": "orca", "BROWSER_CONFIG": str(Path(self.tmp.name) / "none.json")}

    def run_cmd(self, *args):
        return subprocess.run([sys.executable, str(ENTRY), *args], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def test_js_without_timeout_still_works(self):
        r = self.run_cmd("js", "tab1", "1")
        self.assertEqual((r.returncode, r.stdout), (0, "x\n"), r.stderr)

    def test_js_timeout_is_rejected_instead_of_ignored(self):
        r = self.run_cmd("js", "tab1", "1", "--timeout", "1000")
        self.assertEqual(r.returncode, 2)
        self.assertIn("--timeout", r.stderr)

    def test_mouse_commands_are_rejected(self):
        for args in (("click", "tab1", "1", "2"), ("hover", "tab1", "1", "2"),
                     ("drag", "tab1", "1", "2", "3", "4")):
            with self.subTest(args=args):
                r = self.run_cmd(*args)
                self.assertEqual(r.returncode, 2)
                self.assertIn("대응 명령을 확인하지 못했다", r.stderr)


class ArgsTest(unittest.TestCase):
    def test_js_args(self):
        self.assertEqual(parse_js_args(["h", "1+1"]), ["h", "1+1", None])
        self.assertEqual(parse_js_args(["h", "1+1", "--timeout", "500"]), ["h", "1+1", 500])
        self.assertEqual(parse_js_args(["h", "--timeout", "500", "1+1"]), ["h", "1+1", 500])

    def test_js_args_reject(self):
        for bad in (["h", "x", "--timeout"], ["h", "x", "--timeout", "0"],
                    ["h", "x", "--timeout", "soon"], ["h", "x", "y"]):
            with self.subTest(bad=bad), self.assertRaises(UsageError):
                parse_js_args(bad)

    def test_pointer_args(self):
        self.assertEqual(parse_pointer_args("click", ["h", "1", "2.5"], 1, True), ["h", 1.0, 2.5, "left"])
        self.assertEqual(parse_pointer_args("click", ["h", "1", "2", "--button", "right"], 1, True),
                         ["h", 1.0, 2.0, "right"])
        self.assertEqual(parse_pointer_args("drag", ["h", "1", "2", "3", "4"], 2, True),
                         ["h", 1.0, 2.0, 3.0, 4.0, "left"])

    def test_pointer_args_reject(self):
        cases = [("click", ["h", "a", "2"], 1, True), ("click", ["h", "1"], 1, True),
                 ("click", ["h", "1", "2", "--button", "back"], 1, True),
                 ("hover", ["h", "1", "2", "--button", "right"], 1, False),
                 ("drag", ["h", "1", "2", "3"], 2, True)]
        for cmd, args, points, allow in cases:
            with self.subTest(cmd=cmd, args=args), self.assertRaises(UsageError):
                parse_pointer_args(cmd, args, points, allow)


@unittest.skipIf(NODE is None, "ego 스크립트 실행 시험에는 Node.js 가 필요하다")
class EgoScriptTest(unittest.TestCase):
    """ego 가 만든 스크립트를 Node 에서 가짜 page 에 대고 돌려 결과를 본다."""

    FAKE_API = """
const calls = [];
const slot = {};
const fakePage = {
  label: 'p1',
  evaluate: async (src) => {
    calls.push(['evaluate', src.length]);
    return (0, eval)(src);
  },
  waitForFunction: async (src, _arg, opts) => {
    calls.push(['wait', opts.timeout]);
    for (let i = 0; i < 50 && !(await (0, eval)(src)); i += 1) await new Promise((r) => setTimeout(r, 10));
  },
  mouse: {
    click: async (...a) => calls.push(['click', ...a]),
    move: async (...a) => calls.push(['move', ...a]),
    down: async (...a) => calls.push(['down', ...a]),
    up: async (...a) => calls.push(['up', ...a]),
  },
};
globalThis.window = globalThis;
const taskSpace = async () => ({ spaceId: 1, page: () => fakePage });
"""

    def execute(self, cmd, args):
        out = io.StringIO()

        def fake_run(argv, stdin_text, check_exit):
            script = self.FAKE_API + stdin_text
            proc = subprocess.run([NODE, "--input-type=module"], input=script,
                                  capture_output=True, text=True, timeout=20)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return proc.stdout

        with patch("driver.backends.ego.run", side_effect=fake_run):
            with contextlib.redirect_stdout(out):
                result = EgoBackend().dispatch(cmd, args)
        return result

    def test_expression_forms(self):
        cases = [("1 + 1", 2), ("({a: 1})", {"a": 1}), ("'text'", "text"),
                 ("(async () => 'x')()", "x"), ("null", None)]
        for code, expected in cases:
            with self.subTest(code=code):
                got = self.execute("js", ["1:p1", code, None])
                self.assertEqual(got, "null" if expected is None else
                                 expected if isinstance(expected, str) else
                                 json.dumps(expected, separators=(",", ":")) if isinstance(expected, dict) else str(expected))

    def test_multiple_statements_return_last_value(self):
        self.assertEqual(self.execute("js", ["1:p1", "const a = 4; a * 2", None]), "8")
        self.assertEqual(self.execute("js", ["1:p1", "1; 2", None]), "2")

    def test_timeout_polls_instead_of_waiting_in_one_evaluate(self):
        got = self.execute("js", ["1:p1", "(async () => { await new Promise((r) => setTimeout(r, 30)); return 'late'; })()", 45000])
        self.assertEqual(got, "late")

    def test_timeout_surfaces_page_error(self):
        with self.assertRaises(Exception) as ctx:
            self.execute("js", ["1:p1", "(async () => { throw new Error('boom'); })()", 45000])
        self.assertIn("boom", str(ctx.exception))


class MouseScriptTest(unittest.TestCase):
    """마우스 스크립트에 들어가는 호출 순서와 인자를 확인한다."""

    def script(self, cmd, args):
        captured = {}

        def fake_run(argv, stdin_text, check_exit):
            captured["script"] = stdin_text
            return f"\n{MARKER}\n"

        with patch("driver.backends.ego.run", side_effect=fake_run):
            EgoBackend().dispatch(cmd, args)
        return captured["script"]

    def test_click(self):
        s = self.script("click", ["1:p1", 50.0, 60.0, "right"])
        self.assertIn('page.mouse.click(50.0, 60.0, { button: "right" })', s)

    def test_hover_only_moves(self):
        s = self.script("hover", ["1:p1", 5.0, 6.0, "left"])
        self.assertIn("page.mouse.move(5.0, 6.0)", s)
        self.assertNotIn("mouse.down", s)
        self.assertNotIn("mouse.click", s)

    def test_drag_presses_moves_and_releases_in_order(self):
        s = self.script("drag", ["1:p1", 1.0, 2.0, 30.0, 40.0, "left"])
        order = [s.index(t) for t in ("mouse.move(1.0, 2.0)", "mouse.down", "mouse.move(30.0, 40.0", "mouse.up")]
        self.assertEqual(order, sorted(order))


if __name__ == "__main__":
    unittest.main()
