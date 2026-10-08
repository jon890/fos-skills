"""설정 파일 경로 결정과 config-path 명령, 미리보기의 경로 조회를 시험한다.

HOME 은 바꾸지 않는다. 옛 위치와 홈은 함수 인자로 바꾸고, 하위 프로세스는 실제 옛 위치 문자열과 비교한다.
하위 프로세스에는 CODEX_HOME 을 물려주지 않고 CLAUDE_CONFIG_DIR 는 임시 폴더로 준다.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent.parent

# 이 저장소는 <repo>/content-preview/ 에, 팀 저장소는 <repo>/plugins/<플러그인>/skills/content-preview/ 에 둔다.
# 시험 파일은 팀 저장소에서 <repo>/plugins/<플러그인>/tools/browser-driver/tests/ 에 놓인다.
SHOW_PREVIEW_CANDIDATES = (
    REPO / "content-preview" / "scripts" / "show-preview.sh",
    ROOT.parent.parent / "skills" / "content-preview" / "scripts" / "show-preview.sh",
)
SHOW_PREVIEW = next((p for p in SHOW_PREVIEW_CANDIDATES if p.is_file()), SHOW_PREVIEW_CANDIDATES[0])
sys.path.insert(0, str(ROOT))

from driver import config  # noqa: E402

REAL_LEGACY = Path.home() / ".claude" / "browser.config.json"


def copy_driver(dst):
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns("tests", "__pycache__"))
    return dst


class Layout:
    """plugins/cache/m/p/1.0.0/tools/browser-driver 를 임시 디렉터리에 만든다."""

    def __init__(self, codex=False):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        # Codex 설치본은 루트에 config.toml 파일이 있고 데이터 폴더가 없다. 데이터는 Claude 설정 폴더에 둔다.
        self.claude = self.root / "claude-home"
        self.driver = copy_driver(self.root / "plugins/cache/m/p/1.0.0/tools/browser-driver")
        self.data = self.root / "plugins/data/p-m"
        if codex:
            (self.root / "config.toml").write_text("", encoding="utf-8")
            self.data = self.claude / "plugins/data/p-m"

    def put_data_config(self):
        self.data.mkdir(parents=True)
        (self.data / "browser.config.json").write_text("{}", encoding="utf-8")
        return self.data / "browser.config.json"

    def run(self, *args, env_config=None, extra_env=None):
        env = {k: v for k, v in os.environ.items()
               if k not in ("BROWSER_CONFIG", "CODEX_HOME", "CLAUDE_CONFIG_DIR")}
        if env_config:
            env["BROWSER_CONFIG"] = str(env_config)
        env["CLAUDE_CONFIG_DIR"] = str(self.claude)
        env.pop("BROWSER_EGO_PURPOSE", None)
        env.pop("BROWSER_EGO_PROFILE", None)
        env.update(extra_env or {})
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
        return config.resolve_config_path(env or {}, module or self.mod, self.legacy, self.lay.root / "fake-home")

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


class CheckoutConfigTest(unittest.TestCase):
    """캐시 밖의 후보 수와 진단을 임시 홈, 임시 Claude 설정 폴더로 시험한다."""

    def setUp(self):
        self.lay = Layout()
        self.addCleanup(self.lay.close)
        self.home = self.lay.root / "fake-home"
        self.legacy = self.home / ".claude/browser.config.json"
        self.mod = self.lay.root / "checkout/tools/browser-driver/driver/config.py"
        self.env = {"CLAUDE_CONFIG_DIR": str(self.lay.claude)}

    def put_config(self, plugin="p-m", data=None):
        cfg = self.lay.claude / "plugins/data" / plugin / "browser.config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps({} if data is None else data), encoding="utf-8")
        return cfg

    def resolve(self, env=None):
        return config.resolve_config_path(self.env if env is None else env, self.mod, home=self.home)

    def test_one_candidate_beats_existing_legacy_without_changing_it(self):
        expected = self.put_config()
        self.legacy.parent.mkdir(parents=True)
        self.legacy.write_text('{"legacy": true}', encoding="utf-8")
        self.assertEqual(self.resolve(), expected)
        self.assertEqual(self.legacy.read_text(), '{"legacy": true}')

    def test_multiple_candidates_warn_with_sorted_list_and_use_legacy(self):
        second = self.put_config("z-m")
        first = self.put_config("a-m")
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(self.resolve(), self.legacy)
        warning = stderr.getvalue()
        self.assertIn("경고", warning)
        self.assertIn(str(self.legacy), warning)
        self.assertLess(warning.index(str(first)), warning.index(str(second)))
        self.assertIn("BROWSER_CONFIG", warning)
        self.assertFalse(self.legacy.exists())

    def test_no_candidates_use_legacy_without_creating_dirs(self):
        self.assertEqual(self.resolve(), self.legacy)
        self.assertFalse(self.home.exists())
        self.assertFalse(self.lay.claude.exists())

    def test_existing_legacy_symlink_is_preserved(self):
        cfg = self.put_config()
        self.legacy.parent.mkdir(parents=True)
        self.legacy.symlink_to(cfg)
        self.assertEqual(self.resolve(), cfg)
        self.assertTrue(self.legacy.is_symlink())
        self.assertEqual(self.legacy.readlink(), cfg)

    def test_symlink_to_checkout_uses_data_candidate(self):
        cfg = self.put_config()
        self.mod.parent.mkdir(parents=True)
        self.mod.touch()
        link = self.lay.root / "linked-config.py"
        link.symlink_to(self.mod)
        self.assertEqual(config.resolve_config_path(self.env, link, home=self.home), cfg)

    def test_browser_config_wins_even_if_missing_and_candidates_are_ambiguous(self):
        self.put_config("a-m")
        self.put_config("z-m")
        chosen = self.lay.root / "chosen.json"
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(self.resolve({**self.env, "BROWSER_CONFIG": str(chosen)}), chosen)
        self.assertEqual(stderr.getvalue(), "")

    def test_default_and_empty_claude_config_dir_use_supplied_home(self):
        cfg = self.home / ".claude/plugins/data/p-m/browser.config.json"
        cfg.parent.mkdir(parents=True)
        cfg.write_text("{}", encoding="utf-8")
        for env in ({}, {"CLAUDE_CONFIG_DIR": ""}):
            with self.subTest(env=env):
                self.assertEqual(self.resolve(env), cfg)

    def test_directory_named_browser_config_json_does_not_count(self):
        expected = self.put_config()
        (self.lay.claude / "plugins/data/q-m/browser.config.json").mkdir(parents=True)
        self.assertEqual(self.resolve(), expected)

    def test_cache_never_selects_another_plugin(self):
        self.put_config("other-m")
        cached_mod = self.lay.driver / "driver/config.py"
        self.assertEqual(config.resolve_config_path(self.env, cached_mod, home=self.home), self.legacy)

    def run_checkout(self, *args, extra_env=None):
        self.lay.driver = ROOT
        return self.lay.run(*args, extra_env={**self.env, **(extra_env or {})})

    def test_command_outside_cache_uses_one_candidate(self):
        expected = self.put_config()
        result = self.run_checkout("config-path")
        self.assertEqual((result.returncode, result.stdout), (0, f"{expected}\n"))
        self.assertEqual(result.stderr, "")

    def test_command_multiple_candidates_keeps_stdout_one_line(self):
        first = self.put_config("a-m")
        second = self.put_config("z-m")
        result = self.run_checkout("config-path")
        self.assertEqual((result.returncode, result.stdout), (0, f"{REAL_LEGACY}\n"))
        self.assertIn(str(first), result.stderr)
        self.assertIn(str(second), result.stderr)

    def test_doctor_explains_selected_path_and_reason(self):
        expected = self.put_config()
        result = self.run_checkout("doctor", extra_env={"BROWSER_DRIVER": "ego", "PATH": ""})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"설정 파일: {expected}", result.stdout)
        self.assertIn("설정 판정: 설치 캐시 밖에서 플러그인 데이터 설정 후보가 하나", result.stdout)

    def test_doctor_explains_ambiguous_candidates_and_legacy_fallback(self):
        from driver import admin
        self.put_config("a-m")
        self.put_config("z-m")
        resolution = config.resolve_config(self.env, self.mod, home=self.home)
        stdout = io.StringIO()
        with patch.object(admin, "CONFIG_PATH", resolution.path), \
                patch.object(admin, "CONFIG_RESOLUTION", resolution), \
                patch.object(admin.shutil, "which", return_value=None), \
                patch.object(admin, "resolve_backend_name", return_value=("ego", "시험")), \
                redirect_stdout(stdout):
            self.assertEqual(admin.cmd_doctor(), 0)
        self.assertIn(f"설정 파일: {self.legacy}", stdout.getvalue())
        self.assertIn("후보가 여러 개여서 옛 위치 사용", stdout.getvalue())

    def test_missing_config_profile_error_lists_search_paths_and_recovery(self):
        self.assert_profile_error()

    def test_config_without_ego_profiles_reports_selected_file_and_recovery(self):
        cfg = self.put_config()
        self.assert_profile_error(cfg)

    def test_empty_ego_profiles_report_recovery(self):
        cfg = self.put_config(data={"egoProfiles": {}})
        self.assert_profile_error(cfg)

    def test_ambiguous_profile_error_lists_all_candidates_and_legacy(self):
        first = self.put_config("a-m")
        second = self.put_config("z-m")
        message = self.assert_profile_error()
        self.assertIn(str(first), message)
        self.assertIn(str(second), message)

    def test_explicit_missing_config_profile_error_stays_on_that_path(self):
        selected = self.lay.root / "missing.json"
        self.env["BROWSER_CONFIG"] = str(selected)
        message = self.assert_profile_error(selected, check_glob=False)
        self.assertNotIn(str(self.lay.claude / "plugins/data/*/browser.config.json"), message)

    def test_selected_candidate_resolves_purpose_profile(self):
        from driver.backends.ego import resolve_profile
        cfg = self.put_config(data={"egoProfiles": {"personal": "Default"}})
        resolution = config.resolve_config(self.env, self.mod, home=self.home)
        self.assertEqual(resolution.path, cfg)
        with patch.dict(os.environ, {"BROWSER_EGO_PURPOSE": "personal"}, clear=True), \
                patch.object(config, "CONFIG_PATH", resolution.path):
            self.assertEqual(resolve_profile(), ("Default", "BROWSER_EGO_PURPOSE=personal → egoProfiles.personal"))

    def assert_profile_error(self, selected=None, check_glob=True):
        from driver.backends.ego import resolve_profile
        from driver.errors import UsageError
        resolution = config.resolve_config(self.env, self.mod, home=self.home)
        with patch.dict(os.environ, {"BROWSER_EGO_PURPOSE": "personal"}, clear=True), \
                patch.object(config, "CONFIG_PATH", resolution.path), \
                patch.object(config, "CONFIG_RESOLUTION", resolution):
            with self.assertRaises(UsageError) as error:
                resolve_profile()
        message = str(error.exception)
        self.assertIn("BROWSER_EGO_PURPOSE=personal", message)
        self.assertIn("egoProfiles", message)
        self.assertIn("찾아본 경로:", message)
        if check_glob:
            self.assertIn(str(self.lay.claude / "plugins/data/*/browser.config.json"), message)
        self.assertIn(str(selected or self.legacy), message)
        self.assertIn('export BROWSER_CONFIG=', message)
        self.assertIn('ln -s "$BROWSER_CONFIG"', message)
        self.assertIn(str(self.legacy), message)
        return message


class CodexLayoutTest(unittest.TestCase):
    """Codex 설치본은 <CODEX_HOME>/plugins/cache/... 이고 데이터 폴더는 Claude 설정 폴더 아래다."""

    def setUp(self):
        self.lay = Layout(codex=True)
        self.addCleanup(self.lay.close)
        self.legacy = self.lay.root / "legacy.json"
        self.mod = self.lay.driver / "driver" / "config.py"
        self.env = {"CLAUDE_CONFIG_DIR": str(self.lay.claude)}

    def test_config_toml_file_means_codex_and_data_dir_is_under_claude_dir(self):
        self.assertEqual(config.plugin_data_dir(self.mod, self.env), self.lay.data)

    def test_resolve_uses_claude_data_file(self):
        expected = self.lay.put_data_config()
        self.assertEqual(config.resolve_config_path(self.env, self.mod, self.legacy), expected)

    def test_resolve_falls_back_to_legacy_without_data_file(self):
        self.assertEqual(config.resolve_config_path(self.env, self.mod, self.legacy), self.legacy)

    def test_config_toml_directory_means_claude_code_install(self):
        (self.lay.root / "config.toml").unlink()
        (self.lay.root / "config.toml").mkdir()
        self.assertEqual(config.plugin_data_dir(self.mod, self.env), self.lay.root / "plugins/data/p-m")

    def test_empty_claude_config_dir_uses_dot_claude_in_home(self):
        home = self.lay.root / "fake-home"
        got = config.plugin_data_dir(self.mod, {"CLAUDE_CONFIG_DIR": ""}, home)
        self.assertEqual(got, home / ".claude/plugins/data/p-m")
        got = config.plugin_data_dir(self.mod, {}, home)
        self.assertEqual(got, home / ".claude/plugins/data/p-m")

    def test_relative_claude_config_dir_becomes_absolute(self):
        got = config.plugin_data_dir(self.mod, {"CLAUDE_CONFIG_DIR": "rel/dir"})
        self.assertEqual(got, Path("rel/dir").resolve() / "plugins/data/p-m")

    def test_does_not_create_dirs(self):
        config.resolve_config_path(self.env, self.mod, self.legacy)
        self.assertFalse(self.lay.claude.exists())

    def test_command_prints_claude_data_file(self):
        expected = self.lay.put_data_config()
        r = self.lay.run("config-path", extra_env=self.env)
        self.assertEqual((r.returncode, r.stdout), (0, f"{expected}\n"))


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
        if not SHOW_PREVIEW.is_file():
            self.skipTest("show-preview.sh 를 두 배치 어디에서도 찾지 못했다")
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
