"""cd 뒤 git 쓰기, worker 터미널 직접 send, spec-line 이 아닌 --spec 을 hook 이 거부하는지 본다.

각 hook 의 오탐 기준(머리 주석의 「오탐을 피하는 기준」)마다 통과 사례를 둔다.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ROOT / "hooks"


def decide(hook, command, tool="Bash", env=None):
    payload = json.dumps({"tool_name": tool, "tool_input": {"command": command}})
    done = subprocess.run(["python3", str(HOOKS / hook)], input=payload, capture_output=True, text=True,
                          env=env or os.environ)
    assert done.returncode == 0, done.stderr
    if not done.stdout.strip():
        return "pass"
    return json.loads(done.stdout)["hookSpecificOutput"]["permissionDecision"]


class GitAfterCdTest(unittest.TestCase):
    HOOK = "block-git-after-cd.py"

    def test_git_write_after_semicolon_or_newline_cd_is_denied(self):
        for command in (
            "cd worktrees/x; git merge origin/main",
            "cd worktrees/x\ngit commit -m wip",
            "cd /repo && git fetch; git push -u origin HEAD",
            "cd /repo || true; git reset --hard origin/main",
            "cd /repo & git rebase origin/main",
            "cd /repo; git -c core.editor=true rebase --continue",
            "cd /r; (git commit -m x)",
            "for d in a b; do cd $d; git commit -m x; done",
            "pushd /r; git push",
            "cd /r; git commit -m x; set -e",
            "cd /r && make; git push",
        ):
            with self.subTest(command=command):
                self.assertEqual("deny", decide(self.HOOK, command))

    def test_safe_forms_pass(self):
        for command in (
            "cd /repo && git merge origin/main && git push",
            "git -C /repo merge origin/main; git -C /repo push",
            "cd /repo || exit 1; git commit -m x",
            "cd /repo || return\ngit push",
            "set -euo pipefail\ncd /repo\ngit commit -m x",
            "(cd /repo && git commit -m x); ls",
            "cd /repo; git status; git log --oneline -3",
            "git commit -m 'cd x; git push 를 고친다'",
            'git commit -m "$(cat <<\'EOF\'\nfix: cd a\ngit push\nEOF\n)"',
            "cat > /tmp/x.sh <<'EOF'\ncd /repo\ngit push\nEOF",
            "git push origin HEAD",
            # 리뷰에서 재현한 오탐: 리다이렉션의 &, 연산자 뒤 줄바꿈, subshell, 중괄호 가드, 읽기 명령, 주석
            "cd /r && make 2>&1 && git commit -m x",
            "cd /r && npm test >/dev/null 2>&1 && git push",
            "cd /r && make &> log && git commit -m x",
            "cd /r &&\n  git add . &&\n  git commit -m x",
            "(cd /r && make); git commit -m x",
            "(cd /r && make)\ngit push",
            "cd /r || { echo fail; exit 1; }\ngit commit -m x",
            "cd /r || { exit 1; }\ngit push",
            "cd /r; git merge-base --is-ancestor a b",
            "cd /r; git merge-tree --write-tree a b",
            "set -o errexit\ncd /r\ngit commit -m x",
            "cd /r && git status  # check; git push later",
            'cd "$WT" && git commit -m "$(cat <<\'EOF\'\nfix: x\nEOF\n)"',
            "x=$((1<<2)); git -C /r push",
        ):
            with self.subTest(command=command):
                self.assertEqual("pass", decide(self.HOOK, command))

    def test_here_string_and_shift_do_not_hide_later_commands(self):
        for command in ("echo $((1<<2))\ncd /r; git push", "grep x <<< word\ncd /r; git push"):
            with self.subTest(command=command):
                self.assertEqual("deny", decide(self.HOOK, command))

    def test_other_tools_and_broken_input_pass(self):
        self.assertEqual("pass", decide(self.HOOK, "cd x; git push", tool="Read"))
        done = subprocess.run(["python3", str(HOOKS / self.HOOK)], input="not json", capture_output=True, text=True)
        self.assertEqual((0, ""), (done.returncode, done.stdout))


class WorkerTerminalSendTest(unittest.TestCase):
    HOOK = "block-worker-terminal-send.py"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.log = self.tmp / "orca.log"
        self.orca = self.tmp / "orca"
        self.fake('{"result": {"workers": [{"agentTerminalHandle": "term_worker-1"}]}}')

    def fake(self, output, code=0):
        self.orca.write_text(
            "#!/bin/sh\n"
            f'echo "$ORCA_TERMINAL_HANDLE|$*" >> "{self.log}"\n'
            f"cat <<'JSON'\n{output}\nJSON\nexit {code}\n")
        self.orca.chmod(0o755)

    def env(self):
        return dict(os.environ, ORCA=str(self.orca), ORCA_TERMINAL_HANDLE="term_coordinator")

    def test_send_to_worker_terminal_is_denied(self):
        for command in (
            'orca terminal send --terminal term_worker-1 --text "main 을 합쳐라" --enter',
            "orca terminal send --terminal=term_worker-1 --text x",
        ):
            with self.subTest(command=command):
                self.assertEqual("deny", decide(self.HOOK, command, env=self.env()))
        # Run 범위를 좁히지 않게 ORCA_TERMINAL_HANDLE 을 빼고 조회한다
        self.assertTrue(self.log.read_text().startswith("|orchestration worker-list"))

    def test_non_worker_variable_and_failed_lookup_pass(self):
        for command in (
            "orca terminal send --terminal term_dev-server --text 'npm run dev' --enter",
            'orca terminal send --terminal "$T" --text x',
            "orca terminal read --terminal term_worker-1",
            'python3 "$SKILL_DIR/scripts/send-to-worker.py" --dispatch ctx_1 --body x',
            "orca terminal read --terminal term_worker-1 --lines 20 && orca terminal send --terminal term_dev --text hi",
            'orca terminal send --terminal term_dev --text "see --terminal term_worker-1"',
        ):
            with self.subTest(command=command):
                self.assertEqual("pass", decide(self.HOOK, command, env=self.env()))
        # 따옴표 안의 문구에는 orca 를 조회하지도 않는다
        self.log.unlink(missing_ok=True)
        self.assertEqual("pass", decide(self.HOOK, "git commit -m 'orca terminal send --terminal term_worker-1'",
                                        env=self.env()))
        self.assertFalse(self.log.exists())
        self.fake('{"result": {"workers": null}}')
        self.assertEqual("pass", decide(self.HOOK, "orca terminal send --terminal term_worker-1 --text x",
                                        env=self.env()))
        self.fake("not json", code=1)
        self.assertEqual("pass", decide(self.HOOK, "orca terminal send --terminal term_worker-1 --text x",
                                        env=self.env()))


class WorkerFirstScreenSendTest(unittest.TestCase):
    """첫 화면 승인(`--enter` 만 보냄)은 그 dispatch 가 첫 화면 대기일 때만 통과한다."""
    HOOK = "block-worker-terminal-send.py"
    ENTER = "orca terminal send --terminal term_worker-1 --enter"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.orca = self.tmp / "orca"

    def fake(self, show, show_code=0):
        listing = '{"result": {"workers": [{"agentTerminalHandle": "term_worker-1", "dispatchId": "ctx_1"}]}}'
        self.orca.write_text(
            "#!/bin/sh\n"
            'case "$2" in\n'
            f"worker-show) cat <<'JSON'\n{show}\nJSON\nexit {show_code};;\n"
            f"*) cat <<'JSON'\n{listing}\nJSON\n;;\n"
            "esac\n")
        self.orca.chmod(0o755)

    def decide(self, command):
        return decide(self.HOOK, command, env=dict(os.environ, ORCA=str(self.orca), ORCA_TERMINAL_HANDLE="term_c"))

    def test_enter_only_on_first_screen_passes(self):
        for show in (
            '{"result": {"observation": {"agentWait": {"reason": "agent-trust-workspace"}}}}',
            '{"result": {"projection": {"stage": {"detail": "agent-trust-workspace"}}}}',
        ):
            with self.subTest(show=show):
                self.fake(show)
                self.assertEqual("pass", self.decide(self.ENTER))
                self.assertEqual("pass", self.decide("orca terminal send --enter --terminal=term_worker-1"))

    def test_body_on_first_screen_is_denied(self):
        self.fake('{"result": {"observation": {"agentWait": {"reason": "agent-trust-workspace"}}}}')
        for command in (
            'orca terminal send --terminal term_worker-1 --text "1" --enter',
            "orca terminal send --terminal term_worker-1 --interrupt --enter",
            "orca terminal send --terminal term_worker-1 --enter && orca terminal send --terminal term_worker-1 --text x",
        ):
            with self.subTest(command=command):
                self.assertEqual("deny", self.decide(command))

    def test_enter_while_working_or_unreadable_is_denied(self):
        for show, code in (
            ('{"result": {"observation": {"agentWait": null}, "projection": {"stage": {"detail": "input_accepted"}}}}', 0),
            ('{"result": {"observation": {"status": "live"}}}', 0),
            ("not json", 1),
            ('{"result": null}', 0),
        ):
            with self.subTest(show=show):
                self.fake(show, code)
                self.assertEqual("deny", self.decide(self.ENTER))


class RequireSpecLineTest(unittest.TestCase):
    HOOK = "require-spec-line.py"
    LINE = "지시서 /repo/.orch/specs/spec-a.md 를 끝까지 읽고 수행한다. push 는 허락했다. 못 읽으면 escalation 으로 알린다."

    def test_raw_spec_values_are_denied(self):
        for command in (
            'orca orchestration worker-start --task t1 --spec "a.ts 를 고치고 PR 을 연다"',
            "orca orchestration worker-start --task t1 --spec /repo/.orch/specs/spec-a.md",
            "orca orchestration worker-start --task t1 --spec '지시서 /repo/spec-a.md 를 읽는다'",
        ):
            with self.subTest(command=command):
                self.assertEqual("deny", decide(self.HOOK, command))

    def test_spec_line_and_generated_values_pass(self):
        for command in (
            f'orca orchestration worker-start --task t1 --spec "{self.LINE}"',
            f"orca orchestration worker-start --task t1 --spec='{self.LINE}'",
            'orca orchestration worker-start --task t1 --spec "$LINE"',
            'orca orchestration worker-start --task t1 --spec "$(python3 "$SKILL_DIR/scripts/spec-line.py" "$SPEC")"',
            'bash "$SKILL_DIR/scripts/launch-worker.sh" --spec "$SPEC" --repo /repo --name a -- --task t1',
            'orca orchestration task-create --spec "본문"',
            "git commit -m 'orchestration worker-start --spec 본문 금지'",
            "git commit -F - <<'EOF'\norchestration worker-start --spec 값을 검사한다\nEOF",
            "rg -n 'orchestration worker-start' orch/ | grep -- '--spec x'",
        ):
            with self.subTest(command=command):
                self.assertEqual("pass", decide(self.HOOK, command))


class HooksRegisteredTest(unittest.TestCase):
    def test_hooks_json_runs_every_hook(self):
        config = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))
        commands = " ".join(h["command"] for entry in config["hooks"]["PreToolUse"] for h in entry["hooks"])
        for hook in ("block-git-after-cd.py", "block-worker-terminal-send.py", "require-spec-line.py"):
            with self.subTest(hook=hook):
                self.assertIn(f"orch/hooks/{hook}", commands)
                self.assertTrue((HOOKS / hook).is_file())


if __name__ == "__main__":
    unittest.main()
