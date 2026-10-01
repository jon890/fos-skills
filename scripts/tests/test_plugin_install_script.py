"""scripts/test-plugin-install.sh 의 실행 불가 경로를 검증한다. 설치 자체는 스크립트를 실행하는 것이 시험이다."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "test-plugin-install.sh"


def run_script(*args, env=None):
    return subprocess.run(
        ["/bin/bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
    )


class PluginInstallScriptTest(unittest.TestCase):
    def test_unknown_argument_exits_2(self):
        result = run_script("--nope")
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("알 수 없는 인자: --nope", result.stderr)

    def test_missing_claude_exits_2(self):
        with tempfile.TemporaryDirectory() as bin_dir:
            for tool in ("git", "tar", "python3", "dirname", "mktemp"):
                found = shutil.which(tool)
                self.assertIsNotNone(found, f"{tool} 이 이 환경에 없다")
                os.symlink(found, Path(bin_dir) / tool)
            env = {**os.environ, "PATH": bin_dir}
            result = run_script(env=env)
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("claude", result.stderr)


if __name__ == "__main__":
    unittest.main()
