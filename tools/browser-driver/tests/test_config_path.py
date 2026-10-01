"""설정 파일 경로 결정과 config-path 명령, 미리보기의 경로 조회를 시험한다.

HOME 은 바꾸지 않는다. 옛 위치는 함수 인자로 바꾸고, 하위 프로세스는 실제 옛 위치 문자열과 비교한다.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent.parent
SHOW_PREVIEW = REPO / "content-preview" / "scripts" / "show-preview.sh"
sys.path.insert(0, str(ROOT))

from driver import config  # noqa: E402

REAL_LEGACY = Path.home() / ".claude" / "browser.config.json"


def copy_driver(dst):
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns("tests", "__pycache__"))
    return dst


class Layout:
    """plugins/cache/m/p/1.0.0/tools/browser-driver 를 임시 디렉터리에 만든다."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.driver = copy_driver(self.root / "plugins/cache/m/p/1.0.0/tools/browser-driver")
        self.data = self.root / "plugins/data/p-m"

    def put_data_config(self):
        self.data.mkdir(parents=True)
        (self.data / "browser.config.json").write_text("{}", encoding="utf-8")
        return self.data / "browser.config.json"

    def run(self, *args, env_config=None):
        env = {k: v for k, v in os.environ.items() if k != "BROWSER_CONFIG"}
        if env_config:
            env["BROWSER_CONFIG"] = str(env_config)
        return subprocess.run([sys.executable, str(self.driver / "browser_driver.py"), *args],
                              env=env, capture_output=True, text=True, timeout=30)

    def close(self):
        self.tmp.cleanup()


class ResolveConfigPathTest(unittest.TestCase):
    def setUp(self):
        self.lay = Layout()
        self.addCleanup(self.lay.close)
        self.legacy = self.lay.root / "legacy.json"
        self.mod = self.lay.driver / "driver" / "config.py"

    def resolve(self, env=None, module=None):
        return config.resolve_config_path(env or {}, module or self.mod, self.legacy)

    def test_cache_with_data_file_uses_data_dir(self):
        expected = self.lay.put_data_config()
        self.assertEqual(self.resolve(), expected)

    def test_cache_without_data_file_falls_back_to_legacy(self):
        self.assertEqual(self.resolve(), self.legacy)

    def test_env_wins_over_data_file(self):
        self.lay.put_data_config()
        self.assertEqual(self.resolve({"BROWSER_CONFIG": "/x/y.json"}), Path("/x/y.json"))

    def test_outside_cache_uses_legacy(self):
        outside = copy_driver(self.lay.root / "checkout/tools/browser-driver")
        self.assertEqual(self.resolve(module=outside / "driver" / "config.py"), self.legacy)

    def test_symlinked_driver_dir_is_resolved(self):
        expected = self.lay.put_data_config()
        link = self.lay.root / "link"
        link.symlink_to(self.lay.driver)
        self.assertEqual(self.resolve(module=link / "driver" / "config.py"), expected)

    def test_does_not_create_data_dir(self):
        self.resolve()
        self.assertFalse(self.lay.data.exists())


class ConfigPathCommandTest(unittest.TestCase):
    def test_prints_one_line_and_exits_zero_even_if_missing(self):
        lay = Layout()
        self.addCleanup(lay.close)
        r = lay.run("config-path")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, f"{REAL_LEGACY}\n")

    def test_prints_data_file_when_present(self):
        lay = Layout()
        self.addCleanup(lay.close)
        expected = lay.put_data_config()
        r = lay.run("config-path")
        self.assertEqual((r.returncode, r.stdout), (0, f"{expected}\n"))

    def test_env_wins(self):
        lay = Layout()
        self.addCleanup(lay.close)
        lay.put_data_config()
        r = lay.run("config-path", env_config="/tmp/with space/x.json")
        self.assertEqual(r.stdout, "/tmp/with space/x.json\n")

    def test_help_lists_command(self):
        lay = Layout()
        self.addCleanup(lay.close)
        r = lay.run("help")
        self.assertIn("config-path", r.stdout)


class ShowPreviewConfigTest(unittest.TestCase):
    """show-preview.sh 가 드라이버에게 경로를 묻는지, 모르는 드라이버와도 도는지 본다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.html = self.base / "p.html"
        self.html.write_text("<p>x</p>", encoding="utf-8")
        self.log = self.base / "driver.log"

    def fake_driver(self, answer):
        """answer 가 None 이면 config-path 를 모르는 드라이버처럼 종료 코드 2 로 끝난다."""
        d = self.base / "fake-driver"
        reply = "exit 2" if answer is None else f"echo {answer}; exit 0"
        d.write_text(
            "#!/bin/sh\n"
            f'echo "BD=$BROWSER_DRIVER" >> {self.log}\n'
            f'[ "$1" = config-path ] && {{ {reply}; }}\n'
            "exit 1\n")
        d.chmod(0o755)
        return d

    def run_preview(self, driver, extra_env=None):
        env = {k: v for k, v in os.environ.items()
               if k not in ("BROWSER_CONFIG", "PREVIEW_BROWSER_DRIVER", "BROWSER_DRIVER_PATH")}
        env.update({"BROWSER_DRIVER_PATH": str(driver), "PATH": "/usr/bin:/bin"})
        env.update(extra_env or {})
        # 드라이버는 항상 실패하므로 뒤의 기본 브라우저 단계에서 open 이 불리지 않게 막는다.
        shim = self.base / "shim"
        shim.mkdir(exist_ok=True)
        for name in ("open", "osascript", "xdg-open"):
            f = shim / name
            f.write_text("#!/bin/sh\nexit 0\n")
            f.chmod(0o755)
        env["PATH"] = f"{shim}:{env['PATH']}"
        return subprocess.run(["bash", str(SHOW_PREVIEW), str(self.html)], env=env,
                              capture_output=True, text=True, timeout=60)

    def make_cfg(self, name, driver):
        cfg = self.base / name
        cfg.write_text(json.dumps({"previewDriver": driver}), encoding="utf-8")
        return cfg

    def test_asks_driver_for_config_path(self):
        cfg = self.make_cfg("from-driver.json", "orca")
        r = self.run_preview(self.fake_driver(cfg))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("BD=orca", self.log.read_text())

    def test_env_beats_driver_answer(self):
        from_driver = self.make_cfg("from-driver.json", "orca")
        from_env = self.make_cfg("from-env.json", "cmux")
        r = self.run_preview(self.fake_driver(from_driver), {"BROWSER_CONFIG": str(from_env)})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("BD=cmux", self.log.read_text())

    def test_old_driver_without_config_path_still_works(self):
        r = self.run_preview(self.fake_driver(None))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("config-path", r.stderr)


class AdminGuidanceTest(unittest.TestCase):
    def test_install_guides_mkdir_before_cp(self):
        from driver import admin
        src = (ROOT / "driver" / "admin.py").read_text(encoding="utf-8")
        self.assertIn("mkdir -p", src)
        self.assertLess(src.index("mkdir -p"), src.index("cp {"))
        self.assertIn("shlex.quote", src)
        self.assertTrue(hasattr(admin, "shlex"))


if __name__ == "__main__":
    unittest.main()
