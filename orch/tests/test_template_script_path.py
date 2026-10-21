"""templates/spec-common.md 의 스크립트 경로 명령이 세션의 설치본을 고르는지 본다."""

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parents[1] / "templates" / "spec-common.md"


def resolver():
    m = re.search(r"ORCH_SCRIPTS=\$\((python3 -c '.*?')\) &&", TEMPLATE.read_text())
    assert m, "틀에서 경로를 푸는 명령을 찾지 못했다"
    return m.group(1)


def run(env_extra, home):
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
    env.update(env_extra, HOME=str(home))
    return subprocess.run(["sh", "-c", resolver()], capture_output=True, text=True, env=env)


def write_installed(config_dir, entries):
    (Path(config_dir) / "plugins").mkdir(parents=True)
    data = {"version": 2, "plugins": {"fos-skills@fos-skills": entries, "other@x": [{"scope": "user", "installPath": "/no"}]}}
    (Path(config_dir) / "plugins" / "installed_plugins.json").write_text(json.dumps(data))


class TemplateScriptPathTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp()))
        self.addCleanup(subprocess.run, ["rm", "-rf", str(self.tmp)])

    def test_no_fixed_path_placeholder_remains(self):
        self.assertNotIn("{{ORCH_SCRIPTS}}", TEMPLATE.read_text())

    def test_uses_claude_config_dir_and_prefers_user_scope(self):
        cfg = self.tmp / "profile with space" / "home"
        write_installed(cfg, [{"scope": "project", "installPath": "/p/old"}, {"scope": "user", "installPath": "/u/new"}])
        r = run({"CLAUDE_CONFIG_DIR": str(cfg)}, self.tmp / "nohome")
        self.assertEqual(0, r.returncode, r.stderr)
        self.assertEqual("/u/new/orch/scripts", r.stdout.strip())

    def test_falls_back_to_home_dot_claude(self):
        home = self.tmp / "h"
        write_installed(home / ".claude", [{"scope": "user", "installPath": "/home/bundle"}])
        r = run({}, home)
        self.assertEqual("/home/bundle/orch/scripts", r.stdout.strip())

    def test_resolves_to_this_machines_installed_bundle(self):
        cfg = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
        if not (cfg / "plugins" / "installed_plugins.json").exists():
            self.skipTest("fos-skills 설치본이 없다")
        r = run({"CLAUDE_CONFIG_DIR": str(cfg)}, Path.home())
        if r.returncode != 0:
            self.skipTest("fos-skills 항목이 없다")
        self.assertTrue(r.stdout.strip().endswith("/orch/scripts"))


if __name__ == "__main__":
    unittest.main()
