"""옛 .py 경로를 같은 이름의 .ts 로 넘기는 shim(ts_shim.py)을 가짜 node 로 본다."""

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import ts_shim  # noqa: E402

SHIM = SCRIPTS / "launch-worker.py"
TARGET = SCRIPTS / "launch-worker.ts"


class NodeTooOldTest(unittest.TestCase):
    def test_versions_from_22_18_pass(self):
        for text in ("v22.18.0", "v24.1.0", "v22.18.0\n"):
            with self.subTest(text=text):
                self.assertFalse(ts_shim.node_too_old(text))

    def test_older_or_unreadable_versions_are_too_old(self):
        for text in ("v22.17.9", "v20.19.0", "garbage", ""):
            with self.subTest(text=text):
                self.assertTrue(ts_shim.node_too_old(text))


class ExecTest(unittest.TestCase):
    def setUp(self):
        self.bin = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.bin, True)

    def fake_node(self, version):
        """--version 에 version 을 내고, 그 밖에는 받은 인자를 한 줄씩 내는 가짜 node."""
        node = self.bin / "node"
        node.write_text("#!/bin/sh\n"
                        f'if [ "$1" = "--version" ]; then echo {version}; exit 0; fi\n'
                        'for a in "$@"; do printf "%s\\n" "$a"; done\n'
                        "exit 7\n")
        node.chmod(0o755)

    def shim(self, path_value):
        # python3 은 절대경로로 부른다. PATH 를 바꿔도 인터프리터를 찾게 한다
        env = dict(os.environ, PATH=path_value)
        return subprocess.run([sys.executable, str(SHIM), "--help"], capture_output=True, text=True, env=env)

    def test_old_node_stops_with_node_too_old_before_exec(self):
        self.fake_node("v22.17.0")
        done = self.shim(f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}")
        self.assertEqual(127, done.returncode, done.stdout + done.stderr)
        self.assertTrue(done.stdout.startswith("NODE-TOO-OLD v22.17.0"), done.stdout)
        self.assertNotIn("--help", done.stdout)

    def test_new_node_gets_the_ts_file_and_arguments(self):
        self.fake_node("v22.18.0")
        done = self.shim(f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}")
        # 종료 코드는 node 의 것이다
        self.assertEqual(7, done.returncode, done.stderr)
        self.assertEqual(["--disable-warning=ExperimentalWarning", str(TARGET), "--help"], done.stdout.splitlines())
        self.assertIn(f"DEPRECATED python3 launch-worker.py → node --disable-warning=ExperimentalWarning {TARGET}",
                      done.stderr)

    def test_missing_node_is_127(self):
        done = self.shim(str(self.bin))
        self.assertEqual(127, done.returncode, done.stdout + done.stderr)
        self.assertIn("node 22.18 이상이 PATH 에 필요하다", done.stderr)

    def test_import_does_not_exec(self):
        spec = importlib.util.spec_from_file_location("launch_worker_shim", SHIM)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertIs(ts_shim, module.ts_shim)


if __name__ == "__main__":
    unittest.main()
