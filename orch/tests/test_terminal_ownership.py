"""사용자 보유와 조회 실패는 삭제 허가로 바뀌지 않는다."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "terminal_ownership.py"
spec = importlib.util.spec_from_file_location("terminal_ownership", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class FakeOrca:
    """bound 범위만 주는 Orca. 범위 없는 worker-list 는 묶인 Run 만 주고, Run 은 run-list 로 찾아 --run 으로 읽는다."""

    def __init__(self, terminals, runs, scope="bound", fail_run=None):
        self.terminals, self.runs, self.scope, self.fail_run = terminals, runs, scope, fail_run
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        flag = dict(zip(args[2::2], args[3::2]))
        if args[:2] == ("terminal", "list"):
            return {"terminals": self.terminals}
        if args[:2] == ("orchestration", "run-list"):
            # 한 페이지에 Run 하나씩 주고 cursor 로 잇는다
            ids, at = list(self.runs), int(flag.get("--cursor", 0))
            return {"runs": [{"id": ids[at]}], "nextCursor": str(at + 1) if at + 1 < len(ids) else None}
        if args[:2] == ("orchestration", "worker-list") and "--run" in flag:
            if flag["--run"] == self.fail_run:
                raise ValueError("Orca 조회 실패")
            return {"scope": {"source": "flag"}, "workers": self.runs[flag["--run"]], "page": {"nextCursor": None}}
        if args[:2] == ("orchestration", "worker-list"):
            rows = next(iter(self.runs.values())) if self.scope == "bound" else sum(self.runs.values(), [])
            return {"scope": {"source": self.scope}, "workers": rows, "page": {"nextCursor": None}}
        raise AssertionError(args)


def row(handle, state="owned", run="run_a"):
    return {"runId": run, "terminalState": "active",
            "resource": {"terminalHandle": handle, "ownershipState": state}}


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

    def test_unmanaged_terminal_is_allowed_after_reading_every_run(self):
        for scope in ("all", "bound"):
            orca = FakeOrca([{"handle": "t", "worktreePath": "/tmp/wt"}],
                            {"run_a": [row("x")], "run_b": [row("y", run="run_b")]}, scope)
            with self.subTest(scope=scope), patch.object(guard, "query", orca):
                self.assertEqual(guard.blocker("/tmp/wt"), "")
                listed = [c for c in orca.calls if c[:2] == ("orchestration", "run-list")]
                self.assertEqual(len(listed), 2 if scope == "bound" else 0)

    def test_bound_scope_finds_user_owned_terminal_of_another_run(self):
        orca = FakeOrca([{"handle": "t", "worktreePath": "/tmp/wt"}],
                        {"run_a": [row("x")], "run_b": [row("t", "user_owned", "run_b")]})
        with patch.object(guard, "query", orca):
            self.assertEqual(guard.blocker("/tmp/wt"), "사용자 보유 터미널")

    def test_bound_scope_fails_when_one_run_cannot_be_read(self):
        orca = FakeOrca([{"handle": "t", "worktreePath": "/tmp/wt"}],
                        {"run_a": [row("x")], "run_b": [row("y", run="run_b")]}, fail_run="run_b")
        with patch.object(guard, "query", orca):
            self.assertEqual(guard.blocker("/tmp/wt"), "터미널 소유 상태 조회 실패")

    def test_every_run_is_read_once_for_many_paths(self):
        orca = FakeOrca([{"handle": "t1", "worktreePath": "/tmp/wt1"}, {"handle": "t2", "worktreePath": "/tmp/wt2"}],
                        {"run_a": [row("t1")], "run_b": [row("t2", run="run_b")]})
        workers = guard.cached(guard.all_workers)
        with patch.object(guard, "query", orca):
            self.assertEqual(guard.blocker("/tmp/wt1", workers=workers), "")
            self.assertEqual(guard.blocker("/tmp/wt2", workers=workers), "")
        self.assertEqual(len([c for c in orca.calls if c[:2] == ("orchestration", "worker-list")]), 3)

    def test_failure_is_remembered_and_not_retried(self):
        orca = FakeOrca([{"handle": "t", "worktreePath": "/tmp/wt"}], {"run_a": [row("x")]}, fail_run="run_a")
        workers = guard.cached(guard.all_workers)
        with patch.object(guard, "query", orca):
            for _ in range(2):
                self.assertEqual(guard.blocker("/tmp/wt", workers=workers), "터미널 소유 상태 조회 실패")
        self.assertEqual(len([c for c in orca.calls if "--run" in c]), 1)

    def test_rows_are_read_again_after_max_age(self):
        orca = FakeOrca([{"handle": "t", "worktreePath": "/tmp/wt"}], {"run_a": [row("t")]})
        workers = guard.cached(guard.all_workers, max_age=0)
        with patch.object(guard, "query", orca):
            self.assertEqual(guard.blocker("/tmp/wt", workers=workers), "")
            orca.runs["run_a"][0]["resource"]["ownershipState"] = "user_owned"
            self.assertEqual(guard.blocker("/tmp/wt", workers=workers), "사용자 보유 터미널")

    def test_agent_handle_differing_from_resource_handle_is_checked(self):
        stale = {"agentTerminalHandle": "t", "resource": {"terminalHandle": "old", "ownershipState": "user_owned"}}
        orca = FakeOrca([{"handle": "t", "worktreePath": "/tmp/wt"}], {"run_a": [stale]})
        with patch.object(guard, "query", orca):
            self.assertEqual(guard.blocker("/tmp/wt"), "사용자 보유 터미널")

    def test_released_resource_is_preserved(self):
        pages = [{"terminals": [{"handle": "t", "worktreePath": "/tmp/wt"}]},
                 {"scope": {"source": "all"}, "workers": [
                     {"agentTerminalHandle": "t", "resource": {"ownershipState": "released"}}]}]
        with patch.object(guard, "query", side_effect=pages):
            self.assertEqual(guard.blocker("/tmp/wt"), "사용자 보유 터미널")

    def test_ignored_handle_skips_ownership_check_but_others_still_block(self):
        pages = [{"terminals": [{"handle": "a", "worktreePath": "/tmp/wt"}, {"handle": "b", "worktreePath": "/tmp/wt"}]},
                 {"scope": {"source": "all"}, "workers": [
                     {"resource": {"terminalHandle": "a", "ownershipState": "user_owned"}},
                     {"resource": {"terminalHandle": "b", "ownershipState": "owned"}}]}]
        with patch.object(guard, "query", side_effect=pages):
            self.assertEqual(guard.blocker("/tmp/wt", {"a"}), "")
        with patch.object(guard, "query", side_effect=pages):
            self.assertEqual(guard.blocker("/tmp/wt"), "사용자 보유 터미널")
        pages[1]["workers"][1]["resource"]["ownershipState"] = "user_owned"
        with patch.object(guard, "query", side_effect=pages):
            self.assertEqual(guard.blocker("/tmp/wt", {"a"}), "사용자 보유 터미널")


if __name__ == "__main__":
    unittest.main()
