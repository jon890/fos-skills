"""공간 선택을 가짜 ego API 로 시험한다. 실제 브라우저는 호출하지 않는다."""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from driver.backends.ego import EgoBackend
from driver.errors import EXIT_USAGE, UsageError
from test_ego_guidance import Env


NODE = shutil.which("node")
FAKE_API = """
const profiles = async () => [{id: 'Default', name: 'Personal', isDefault: true}];
const listTaskSpaces = async () => fixture;
const fakePage = {
  label: 'p1', goto: async () => {}, waitForLoadState: async () => {},
  close: async () => { throw new Error('reset 은 page 를 하나씩 닫지 않고 finish 로 닫는다'); },
  url: async () => 'https://example.com'
};
const taskSpace = async (key, options) => {
  if (typeof key === 'string' && (!options || options.profileId !== 'Default')) {
    throw new Error('잘못된 프로필로 공간을 만들었다');
  }
  const spaceId = typeof key === 'number' ? key : 99;
  return {
    spaceId, page: () => fakePage, newPage: async () => fakePage,
    tabs: async () => tabsFixture,
    // 실제 ego 와 같은 규칙이다 (실측). 관리 중인 page 는 keep 에 없으면 닫고,
    // 사용자 탭(label 이 없는 것)이 남아 있거나 keep 이 있으면 공간을 닫지 않는다.
    finish: async (options) => {
      const labels = tabsFixture.filter((t) => t.label).map((t) => t.label);
      const kept = labels.filter((l) => options.keep.includes(l));
      const unmanaged = tabsFixture.filter((t) => !t.label).length;
      return {
        spaceId, closedSpace: kept.length === 0 && unmanaged === 0,
        keptManagedLabels: kept, closedManagedLabels: labels.filter((l) => !kept.includes(l)),
        preservedUnmanagedCount: unmanaged,
      };
    }
  };
};
"""


class EgoSpaceTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        config = patch("driver.backends.ego.config_value", return_value=None)
        config.start()
        self.addCleanup(config.stop)
        self.backend = EgoBackend()

    def execute(self, cmd, args=(), spaces=(), tabs=None):
        if NODE is None:
            self.skipTest("가짜 ego API 시험에는 Node.js 가 필요하다")

        def fake_run(argv, stdin_text, check_exit):
            self.assertEqual(argv, ["ego-browser", "nodejs"])
            self.assertTrue(check_exit)
            if tabs is None:
                tab_list = [{"label": "p1", "openedBy": "agent", "url": "about:blank"}]
            else:
                tab_list = tabs
            script = ("const fixture = " + json.dumps(spaces) + ";\n"
                      "const tabsFixture = " + json.dumps(tab_list) + ";\n"
                      + FAKE_API + stdin_text)
            result = subprocess.run(
                [NODE, "--input-type=module"], input=script,
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

        stderr = io.StringIO()
        with patch("driver.backends.ego.run", side_effect=fake_run):
            with contextlib.redirect_stderr(stderr):
                result = self.backend.dispatch(cmd, list(args))
        return result, stderr.getvalue()

    def space(self, name, ownership="agent", profile="Default", space_id=7):
        item = {"id": space_id, "name": name, "ownership": ownership}
        if profile is not None:
            item["profileId"] = profile
        return item

    def test_default_name_with_unset_or_empty_variable(self):
        for value in (None, ""):
            with self.subTest(value=value):
                if value is not None:
                    os.environ["BROWSER_EGO_SPACE"] = value
                handle, note = self.execute("open", ["https://example.com"])
                self.assertEqual(handle, "99:p1")
                self.assertIn("공간: browser-driver/Default", note)

    def test_custom_name_is_trimmed_and_reported(self):
        os.environ["BROWSER_EGO_SPACE"] = '  월 공수 "등록"  '
        os.environ["BROWSER_EGO_PROFILE"] = "Personal"
        handle, note = self.execute("open", ["https://example.com"])
        self.assertEqual(handle, "99:p1")
        self.assertIn('공간: 월 공수 "등록"', note)
        self.assertIn("BROWSER_EGO_PROFILE=Personal", note)
        self.assertEqual(len(note.splitlines()), 1)

    def test_numbered_space_after_user_takes_control(self):
        os.environ["BROWSER_EGO_SPACE"] = "작업"
        spaces = [self.space("작업", "user"), self.space("작업 #2", "user")]
        handle, note = self.execute("open", ["https://example.com"], spaces)
        self.assertEqual(handle, "99:p1")
        self.assertIn("공간: 작업 #3", note)

    def test_reuses_numbered_agent_space(self):
        os.environ["BROWSER_EGO_SPACE"] = "작업"
        spaces = [self.space("작업", "user"), self.space("작업 #2", space_id=8)]
        handle, note = self.execute("open", ["https://example.com"], spaces)
        self.assertEqual(handle, "8:p1")
        self.assertIn("공간: 작업 #2", note)

    def test_custom_space_requires_matching_profile(self):
        os.environ["BROWSER_EGO_SPACE"] = "작업"
        for profile in (None, "Other"):
            with self.subTest(profile=profile):
                spaces = [self.space("작업", profile=profile)]
                handle, note = self.execute("open", ["https://example.com"], spaces)
                self.assertEqual(handle, "99:p1")
                self.assertIn("공간: 작업 #2", note)

    def test_default_space_keeps_missing_profile_compatibility(self):
        spaces = [self.space("browser-driver/Default", profile=None)]
        handle, _ = self.execute("open", ["https://example.com"], spaces)
        self.assertEqual(handle, "7:p1")

    def test_default_pages_keeps_current_name(self):
        spaces = [self.space("browser-driver/Default", space_id=5), self.space("작업")]
        for value in (None, ""):
            if value is not None:
                os.environ["BROWSER_EGO_SPACE"] = value
            with self.subTest(value=value):
                output, _ = self.execute("pages", spaces=spaces)
                self.assertTrue(output.startswith("5:p1\t"), output)

    def test_default_space_reset_is_refused_without_calling_ego(self):
        for value in (None, ""):
            if value is not None:
                os.environ["BROWSER_EGO_SPACE"] = value
            with self.subTest(value=value):
                with patch.object(self.backend, "_run") as run:
                    with contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(UsageError) as caught:
                            self.backend.dispatch("reset", [])
                run.assert_not_called()
                self.assertIn("BROWSER_EGO_SPACE", str(caught.exception))

    def test_default_space_reset_exits_with_usage_code(self):
        env = Env(installed=("ego-browser",), driver_env="ego")
        self.addCleanup(env.close)
        for value in (None, ""):
            if value is None:
                env.env.pop("BROWSER_EGO_SPACE", None)
            else:
                env.env["BROWSER_EGO_SPACE"] = value
            with self.subTest(value=value):
                result = env.run("reset")
                self.assertEqual(result.returncode, EXIT_USAGE, result.stderr)
                self.assertIn("BROWSER_EGO_SPACE", result.stderr)

    def test_pages_and_reset_target_only_selected_name_and_profile(self):
        spaces = [
            self.space("browser-driver/Default", space_id=1),
            self.space("作業", profile="Other", space_id=2),
            self.space("作業 #2", space_id=3),
            self.space("다른 작업", space_id=4),
        ]
        os.environ["BROWSER_EGO_SPACE"] = "作業"
        for cmd in ("pages", "reset"):
            with self.subTest(cmd=cmd):
                output, _ = self.execute(cmd, ["Personal"], spaces)
                self.assertTrue(output.startswith("3:p1\t"), output)

    def test_reset_closes_space_and_reports_closed_tabs(self):
        os.environ["BROWSER_EGO_SPACE"] = "작업"
        output, note = self.execute("reset", spaces=[self.space("작업", space_id=3)])
        self.assertEqual(output, "3:p1\tabout:blank")
        self.assertIn("공간 3 를 닫았다", note)

    def test_reset_keeps_space_when_user_tab_remains(self):
        os.environ["BROWSER_EGO_SPACE"] = "작업"
        tabs = [{"label": "p1", "openedBy": "agent", "url": "https://a"},
                {"openedBy": "user", "url": "https://user"}]
        output, note = self.execute("reset", spaces=[self.space("작업", space_id=3)], tabs=tabs)
        self.assertEqual(output, "3:p1\thttps://a")
        self.assertIn("공간 3 는 닫지 않았다: 사용자 탭 1개", note)
        self.assertNotIn("공간 3 를 닫았다", note)

    def test_reset_keeps_labeled_page_with_unknown_owner(self):
        os.environ["BROWSER_EGO_SPACE"] = "작업"
        tabs = [{"label": "p1", "openedBy": "agent", "url": "https://a"},
                {"label": "p2", "openedBy": "unknown", "url": "https://u"}]
        output, note = self.execute("reset", spaces=[self.space("작업", space_id=3)], tabs=tabs)
        self.assertEqual(output, "3:p1\thttps://a")
        self.assertIn("소유를 판정하지 못한 page p2", note)

    def test_reset_by_id_ignores_space_name_variable(self):
        spaces = [self.space("남은 작업", space_id=9)]
        for value in (None, "", "다른 이름"):
            with self.subTest(value=value):
                if value is not None:
                    os.environ["BROWSER_EGO_SPACE"] = value
                output, note = self.execute("reset", ["", "9"], spaces)
                self.assertEqual(output, "9:p1\tabout:blank")
                self.assertIn("공간 9 를 닫았다", note)

    def test_reset_by_id_refuses_user_default_and_missing_spaces(self):
        spaces = [self.space("남은 작업", "user", space_id=5),
                  self.space("browser-driver/Default", space_id=6)]
        for space_id, expect in (("5", "에이전트가 가진 공간이 아니다"),
                                 ("6", "기본 공간이라 닫지 않는다"),
                                 ("77", "공간 77 가 없다")):
            with self.subTest(space_id=space_id):
                with self.assertRaises(UsageError) as caught:
                    self.execute("reset", ["", space_id], spaces)
                self.assertIn(expect, str(caught.exception))

    def test_spaces_lists_only_agent_spaces_with_tab_count(self):
        spaces = [self.space("fos 확인", space_id=3), self.space("fos 다른", "user", space_id=4),
                  self.space("다른 저장소", space_id=5)]
        tabs = [{"label": "p1", "openedBy": "agent", "url": "a"},
                {"label": "p2", "openedBy": "agent", "url": "b"}]
        output, _ = self.execute("spaces", spaces=spaces, tabs=tabs)
        self.assertEqual(output.splitlines(), ["3\tfos 확인\t2", "5\t다른 저장소\t2"])
        output, _ = self.execute("spaces", ["fos"], spaces, tabs)
        self.assertEqual(output, "3\tfos 확인\t2")

    def test_spaces_prints_nothing_without_agent_spaces(self):
        output, _ = self.execute("spaces", spaces=[self.space("작업", "user")])
        self.assertIsNone(output)

    def test_spaces_does_not_need_space_variable(self):
        os.environ["BROWSER_EGO_SPACE"] = "\n"
        output, _ = self.execute("spaces", spaces=[self.space("작업", space_id=3)])
        self.assertTrue(output.startswith("3\t작업\t"), output)


    def test_pages_and_reset_do_not_create_or_use_unrelated_spaces(self):
        os.environ["BROWSER_EGO_SPACE"] = "작업"
        spaces = [self.space("browser-driver/Default"), self.space("작업", "user")]
        for cmd in ("pages", "reset"):
            with self.subTest(cmd=cmd):
                output, _ = self.execute(cmd, spaces=spaces)
                self.assertIsNone(output)

    def test_invalid_names_fail_before_backend_call(self):
        for value in ("  ", "\t", "작업\n이름", "작업\r", "\n작업", "작업 이름"):
            for cmd, args in (("open", ["https://example.com"]), ("pages", []), ("reset", [])):
                with self.subTest(value=value, cmd=cmd):
                    os.environ["BROWSER_EGO_SPACE"] = value
                    with patch.object(self.backend, "_run") as run:
                        with contextlib.redirect_stderr(io.StringIO()):
                            with self.assertRaises(UsageError):
                                self.backend.dispatch(cmd, args)
                    run.assert_not_called()

    def test_invalid_name_exits_with_usage_code(self):
        env = Env(installed=("ego-browser",), driver_env="ego")
        self.addCleanup(env.close)
        env.env["BROWSER_EGO_SPACE"] = "   "
        for cmd in ("open", "pages", "reset", "doctor"):
            args = ["https://example.com"] if cmd == "open" else []
            result = env.run(cmd, *args)
            self.assertEqual(result.returncode, EXIT_USAGE, result.stderr)

    def test_doctor_describes_default_and_custom_space(self):
        self.assertIn("browser-driver/<해석된 프로필 id>", self.backend.prepare_note())
        os.environ["BROWSER_EGO_SPACE"] = "작업"
        self.assertIn("공간 해석: 작업", self.backend.prepare_note())

    def test_handle_commands_ignore_space_environment(self):
        os.environ["BROWSER_EGO_SPACE"] = "\n"
        for cmd, args in (("url", ["42:p1"]), ("close", ["42:p1"]),
                          ("nav", ["42:p1", "https://example.com"]),
                          ("js", ["42:p1", "document.title"])):
            with self.subTest(cmd=cmd):
                with patch.object(self.backend, "_run", return_value="") as run:
                    self.backend.dispatch(cmd, args)
                self.assertIn("taskSpace(42)", run.call_args.args[0])
                self.assertNotIn("listTaskSpaces", run.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
