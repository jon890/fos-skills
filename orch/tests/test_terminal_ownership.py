"""사용자 보유와 조회 실패는 삭제 허가로 바뀌지 않는다."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "terminal_ownership.py"
spec = importlib.util.spec_from_file_location("terminal_ownership", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class OwnershipTest(unittest.TestCase):
    def test_user_owned_on_later_page_and_descendant_is_preserved(self):
        pages = [{"terminals": [{"handle": "t", "worktreePath": "/tmp/wt/sub"}]},
                 {"scope": {"source": "all"}, "workers": [], "page": {"nextCursor": "p"}},
                 {"scope": {"source": "all"}, "workers": [
                     {"resource": {"terminalHandle": "t", "ownershipState": "user_owned"}}]}]
        with patch.object(guard, "query", side_effect=pages):
            self.assertEqual(guard.blocker("/tmp/wt"), "사용자 보유 터미널")

    def test_query_failures_are_preserved(self):
        for error in (ValueError(), OSError(), KeyError()):
            with self.subTest(error=error), patch.object(guard, "query", side_effect=error):
                self.assertEqual(guard.blocker("/tmp/wt"), "터미널 소유 상태 조회 실패")

    def test_unmanaged_terminal_allowed_only_after_full_scope_query(self):
        for scope, expected in (("all", ""), ("bound", "터미널 소유 상태 조회 실패")):
            pages = [{"terminals": [{"handle": "t", "worktreePath": "/tmp/wt"}]},
                     {"scope": {"source": scope}, "workers": []}]
            with patch.object(guard, "query", side_effect=pages):
                self.assertEqual(guard.blocker("/tmp/wt"), expected)

    def test_released_resource_is_preserved(self):
        pages = [{"terminals": [{"handle": "t", "worktreePath": "/tmp/wt"}]},
                 {"scope": {"source": "all"}, "workers": [
                     {"agentTerminalHandle": "t", "resource": {"ownershipState": "released"}}]}]
        with patch.object(guard, "query", side_effect=pages):
            self.assertEqual(guard.blocker("/tmp/wt"), "사용자 보유 터미널")


if __name__ == "__main__":
    unittest.main()
