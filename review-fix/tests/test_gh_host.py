#!/usr/bin/env python3
"""gh_host.logged_in_hosts 검사."""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "gh_host", Path(__file__).resolve().parents[1] / "scripts" / "gh_host.py"
)
gh_host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gh_host)

# 사내 호스트의 토큰 확인이 timeout 나면 gh auth status 는 종료 코드 1 이다. github.com 은 정상이다.
PARTIAL_FAILURE = """github.nhnent.com
  X Timeout trying to log in to github.nhnent.com account dev-user (keyring)
  - Active account: true

github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
"""


class FakeDone:
    def __init__(self, code, out, err=""):
        self.returncode, self.stdout, self.stderr = code, out, err


class TestLoggedInHosts(unittest.TestCase):
    def test_hosts_are_read_even_when_auth_status_exits_nonzero(self):
        with patch.object(gh_host.subprocess, "run", return_value=FakeDone(1, "", PARTIAL_FAILURE)):
            self.assertEqual(gh_host.logged_in_hosts(), ["github.nhnent.com", "github.com"])

    def test_no_output_means_no_hosts(self):
        with patch.object(gh_host.subprocess, "run", return_value=FakeDone(1, "")):
            self.assertEqual(gh_host.logged_in_hosts(), [])

    def test_other_commands_still_need_exit_zero(self):
        with patch.object(gh_host.subprocess, "run", return_value=FakeDone(1, "x")):
            self.assertIsNone(gh_host._run(["git", "remote", "get-url", "origin"]))

    def test_resolve_uses_repo_lookup_instead_of_origin_when_auth_status_fails(self):
        def run(argv, **kw):
            if argv[:3] == ["gh", "auth", "status"]:
                return FakeDone(1, "", PARTIAL_FAILURE)
            if "github.com" in argv and "--hostname" in argv and argv[argv.index("--hostname") + 1] == "github.com":
                return FakeDone(0, "1")
            return FakeDone(1, "")
        with patch.dict(gh_host.os.environ, {}, clear=False), \
                patch.object(gh_host.subprocess, "run", side_effect=run), \
                patch.object(gh_host, "_from_origin", side_effect=AssertionError("origin 으로 되돌아갔다")):
            gh_host.os.environ.pop("GH_HOST", None)
            self.assertEqual(gh_host.resolve("octocat", "sample-repo"), "github.com")


if __name__ == "__main__":
    unittest.main()
