"""nudge-worker.py 의 화면 판정과 입력 흐름을 검증한다. 흐름은 가짜 orca 로 돌아 Orca 에는 닿지 않는다."""

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "nudge-worker.py"
_spec = importlib.util.spec_from_file_location("nudge_worker", SCRIPT)
nw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nw)

CLAUDE_FOOTER = """\
───────────────────────────────────────────────────────────────
{input}
───────────────────────────────────────────────────────────────
   Model: Sonnet 5.5  Context: [██░░░░░░░░░░░░░░] 112k/1.0M (11%)
  ⏵⏵ bypass permissions on · 1 shell · ← 1 agent"""

CLAUDE_IDLE = """\
⏺ worker_done 을 보냈다.
✻ Baked for 41m 26s · done 오후 11:19 · 1 shell still running
※ recap: 작업은 끝났고 PR 을 열어 코디네이터에게 보고했다. (disable recaps in /config)
""" + CLAUDE_FOOTER.format(input="❯ ")

CLAUDE_WORKING = """\
⏺ 검사를 다시 돌린다.
✳ Lollygagging… (3m 0s · ↓ 9.2k tokens)
  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work
""" + CLAUDE_FOOTER.format(input="❯ ")

CLAUDE_DRAFT = CLAUDE_IDLE.replace("❯ ", "❯ 이 브랜치 이름을 바꿔")

CLAUDE_PERMISSION = """\
 Bash command
   rm -rf build
 Do you want to proceed?
 ❯ 1. Yes
   2. No, and tell Claude what to do differently (esc)"""

CODEX_FOOTER = """\
› {input}
  ~/work/repo · user/branch · GPT-6.1-Sol medium · Context 47% used
  ? for shortcuts                                       ⚠ 2 warnings · f2 to view"""

CODEX_HISTORY = """\
› You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
• 전체 CI 는 통과했고, 머지 완료를 기다리고 있습니다.
"""

CODEX_WORKING = CODEX_HISTORY + """\
• Working (50m 46s • esc to interrupt) · 1 background terminal running · /ps to view
  └ Tip: Use /hooks to view and manage lifecycle hooks.
""" + CODEX_FOOTER.format(input="Ask Codex to do anything")

CODEX_IDLE = CODEX_HISTORY + CODEX_FOOTER.format(input="Ask Codex to do anything")
CODEX_EMPTY = CODEX_HISTORY + CODEX_FOOTER.format(input="")
CODEX_DRAFT = CODEX_HISTORY + CODEX_FOOTER.format(input="PR 본문을 고쳐")

CODEX_PERMISSION = """\
  Would you like to run the following command?
  $ git push -u origin HEAD
› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)"""


class ClassifyTest(unittest.TestCase):
    def check(self, screen, expected):
        self.assertEqual(expected, nw.classify(screen.splitlines()), screen)

    def test_claude_states(self):
        self.check(CLAUDE_IDLE, "idle")
        self.check(CLAUDE_WORKING, "working")
        self.check(CLAUDE_DRAFT, "draft")
        self.check(CLAUDE_PERMISSION, "permission")

    def test_codex_states(self):
        self.check(CODEX_IDLE, "idle")
        self.check(CODEX_EMPTY, "idle")
        self.check(CODEX_WORKING, "working")
        self.check(CODEX_DRAFT, "draft")
        self.check(CODEX_PERMISSION, "permission")

    def test_prompt_far_above_the_bottom_is_history(self):
        self.check("› 지난 지시\n" + "\n".join(f"출력 {i}" for i in range(20)), "unknown")

    def test_shell_screen_is_unknown(self):
        self.check("~/work/repo on main\n$ ", "unknown")

    def test_classify_option_reads_stdin(self):
        done = subprocess.run(["python3", str(SCRIPT), "--classify"], input=CODEX_IDLE,
                              capture_output=True, text=True)
        self.assertEqual(0, done.returncode)
        self.assertEqual("idle", done.stdout.strip())


# 차례로 응답을 하나씩 낸다. 부를 때마다 인자를 기록한다
FAKE_ORCA = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    path = os.environ["FAKE_STATE"]
    st = json.load(open(path))
    open(os.environ["FAKE_LOG"], "a").write(json.dumps(sys.argv[1:]) + "\\n")
    reply = st["replies"].pop(0)
    json.dump(st, open(path, "w"))
    print(json.dumps(reply))
    sys.exit(0 if reply.get("ok") else 1)
    """)


def screen(text):
    return {"ok": True, "result": {"terminal": {"tail": text.splitlines(), "source": "screen"}}}


def receipt(*stages, observation="observed", request="req_1"):
    return {"ok": True, "result": {"send": {"accepted": True, "handle": "term_w", "prompt": {
        "requestId": request, "stages": list(stages), "provider": "claude", "observation": observation}}}}


class NudgeFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bin = Path(tempfile.mkdtemp())
        cls.addClassCleanup(shutil.rmtree, cls.bin)
        cls.orca = cls.bin / "orca"
        cls.orca.write_text(FAKE_ORCA)
        cls.orca.chmod(cls.orca.stat().st_mode | stat.S_IEXEC)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.state = self.tmp / "state.json"
        self.log = self.tmp / "log.txt"
        self.env = dict(os.environ, ORCA=str(self.orca), FAKE_STATE=str(self.state), FAKE_LOG=str(self.log))

    def run_nudge(self, replies):
        self.state.write_text(json.dumps({"replies": replies}))
        return subprocess.run(["python3", str(SCRIPT), "--terminal", "term_w", "--msg-id", "msg_1", "--wait-submit", "5"],
                              capture_output=True, text=True, env=self.env)

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def sends(self):
        return [c for c in self.calls() if c[:2] == ["terminal", "send"]]

    def test_idle_worker_is_nudged_once(self):
        r = self.run_nudge([screen(CLAUDE_IDLE), receipt("input_accepted", "turn_started")])
        self.assertEqual(0, r.returncode, r.stdout)
        self.assertTrue(r.stdout.startswith("nudged"))
        [call] = self.sends()
        self.assertIn("코디네이터 메시지 msg_1 를 orca orchestration check 로 읽고 수행한다", call)
        self.assertIn("--enter", call)
        self.assertNotIn("--retry-request", call)

    def test_swallowed_enter_is_retried_with_the_same_request(self):
        r = self.run_nudge([screen(CODEX_IDLE), receipt("input_accepted"), receipt("input_accepted", "turn_started")])
        self.assertEqual(0, r.returncode, r.stdout)
        first, retry = self.sends()
        self.assertEqual(first[:-1] + ["--retry-request", "req_1", "--json"], retry)

    def test_unobserved_after_retry_fails(self):
        r = self.run_nudge([screen(CODEX_IDLE), receipt("input_accepted"), receipt("input_accepted")])
        self.assertEqual(1, r.returncode)
        self.assertEqual(2, len(self.sends()))
        self.assertTrue(r.stdout.startswith("unobserved"))

    def test_permission_receipt_is_not_retried(self):
        r = self.run_nudge([screen(CLAUDE_IDLE), receipt("input_accepted", observation="permission")])
        self.assertEqual(4, r.returncode)
        self.assertEqual(1, len(self.sends()))

    def test_working_worker_is_left_alone(self):
        r = self.run_nudge([screen(CODEX_WORKING)])
        self.assertEqual(0, r.returncode)
        self.assertTrue(r.stdout.startswith("working"))
        self.assertEqual([], self.sends())

    def test_draft_and_permission_screens_are_left_alone(self):
        for text in (CLAUDE_DRAFT, CODEX_PERMISSION):
            self.log.unlink(missing_ok=True)
            r = self.run_nudge([screen(text)])
            self.assertEqual(4, r.returncode, text)
            self.assertEqual([], self.sends())

    def test_orca_error_is_printed(self):
        r = self.run_nudge([{"ok": False, "error": {"code": "terminal_not_found"}}])
        self.assertEqual(5, r.returncode)
        self.assertIn("terminal_not_found", r.stdout)

    def test_usage_errors(self):
        self.assertEqual(2, subprocess.run(["python3", str(SCRIPT)], capture_output=True).returncode)
        self.assertEqual(2, subprocess.run(["python3", str(SCRIPT), "--terminal", "t"], capture_output=True).returncode)


if __name__ == "__main__":
    unittest.main()
