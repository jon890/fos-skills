"""ego lite 를 먼저 권하는 안내 문구를 확인한다. 실제 브라우저는 열지 않는다."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENTRY = ROOT / "browser_driver.py"
EXAMPLE = ROOT / "browser.config.example.json"
URL = "https://lite.ego.app/"


class Env:
    """가짜 PATH 와 설정 파일 위치를 만든다. HOME 은 건드리지 않는다."""

    def __init__(self, installed=(), config=None, driver_env=None):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        bin_dir = base / "bin"
        bin_dir.mkdir()
        for name in installed:
            exe = bin_dir / name
            exe.write_text("#!/bin/sh\nexit 0\n")
            exe.chmod(0o755)
        cfg = base / "browser.config.json"
        if config is not None:
            cfg.write_text(json.dumps(config), encoding="utf-8")
        self.env = {**os.environ, "PATH": str(bin_dir), "BROWSER_CONFIG": str(cfg)}
        self.env.pop("BROWSER_DRIVER", None)
        if driver_env:
            self.env["BROWSER_DRIVER"] = driver_env

    def run(self, *args):
        return subprocess.run([sys.executable, str(ENTRY), *args], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def close(self):
        self.tmp.cleanup()


class EgoGuidanceTest(unittest.TestCase):
    def make(self, **kw):
        e = Env(**kw)
        self.addCleanup(e.close)
        return e

    def test_example_config_prefers_ego_and_keeps_preview_orca(self):
        data = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        self.assertEqual(data["driver"], "ego")
        self.assertEqual(data["previewDriver"], "orca")
        self.assertEqual(next(iter(data["_drivers"])), "ego")
        self.assertIn("권장", data["_drivers"]["ego"])

    def test_no_backend_error_recommends_ego_lite(self):
        r = self.make().run("doctor")
        self.assertEqual(r.returncode, 2)
        self.assertIn(URL, r.stdout)
        self.assertLess(r.stdout.index("ego lite"), r.stdout.index("orca 나 agent-browser"))

    def test_no_backend_error_on_command(self):
        r = self.make().run("open", "about:blank")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(URL, r.stderr + r.stdout)

    def test_doctor_recommends_when_other_backend_and_ego_missing(self):
        r = self.make(installed=("orca",)).run("doctor")
        self.assertEqual(r.returncode, 0)
        self.assertIn("판정: orca", r.stdout)
        self.assertIn("권고:", r.stdout)
        self.assertIn(URL, r.stdout)

    def test_doctor_recommends_when_ego_installed_but_pinned_elsewhere(self):
        r = self.make(installed=("ego-browser", "orca"), config={"driver": "orca"}).run("doctor")
        self.assertEqual(r.returncode, 0)
        self.assertIn("판정: orca", r.stdout)
        self.assertIn("권고:", r.stdout)
        self.assertNotIn(URL, r.stdout.split("판정:")[1])

    def test_doctor_silent_when_ego_selected(self):
        r = self.make(installed=("ego-browser", "orca")).run("doctor")
        self.assertEqual(r.returncode, 0)
        self.assertIn("판정: ego", r.stdout)
        self.assertNotIn("권고:", r.stdout)

    def test_preview_driver_does_not_trigger_recommendation(self):
        r = self.make(installed=("ego-browser", "orca"), config={"previewDriver": "orca"}).run("doctor")
        self.assertIn("판정: ego", r.stdout)
        self.assertNotIn("권고:", r.stdout)


if __name__ == "__main__":
    unittest.main()
