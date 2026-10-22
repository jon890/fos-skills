"""check --wait 를 셸의 & 나 nohup 으로 띄우는 Bash 호출을 hook 이 거부하는지 본다."""

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "block-background-wait.py"
HOOKS_JSON = ROOT / "hooks" / "hooks.json"
PLUGIN = ROOT.parent / ".claude-plugin" / "plugin.json"


def decide(command, tool="Bash"):
    payload = json.dumps({"tool_name": tool, "tool_input": {"command": command}})
    done = subprocess.run(["python3", str(HOOK)], input=payload, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    if not done.stdout.strip():
        return "pass"
    return json.loads(done.stdout)["hookSpecificOutput"]["permissionDecision"]


class BlockBackgroundWaitTest(unittest.TestCase):
    def test_backgrounded_waits_are_denied(self):
        for command in (
            'orca orchestration check --run "$RUN_ID" --wait --timeout-ms 7000000 --json 2>&1 | grep -v _keepalive &',
            "nohup orca orchestration check --wait --json > /tmp/w.log 2>&1",
            "(orca orchestration check --wait --json > out.json) &",
            "orca orchestration check \\\n  --wait --json &",
            "orca orchestration check --wait --json & disown",
            'python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID" > /tmp/w.out 2>&1 &',
            'nohup python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID"',
        ):
            with self.subTest(command=command):
                self.assertEqual("deny", decide(command))

    def test_foreground_and_harness_background_waits_pass(self):
        for command in (
            'orca orchestration check --run "$RUN_ID" --ack "$D" --wait --types "worker_done" --timeout-ms 7000000 --json 2>&1 | grep -v _keepalive',
            "orca orchestration check --wait --json >/tmp/x 2>&1 && echo done",
            "orca orchestration check --terminal T --json &",
            'echo "orchestration check --wait &"',
            "sleep 5 &",
            'python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID" --ack "$DELIVERY_ID"',
            'python3 "$SKILL_DIR/scripts/wait-important.py" --run "$RUN_ID" 2>/dev/null && echo woke',
            # heredoc 본문은 명령이 아니다. 문서를 고치는 스크립트에 이 문구가 든 일이 있었다
            "python3 - <<'EOF'\ntext = 'check --wait 를 셸의 & 나 nohup 으로 띄우는 호출'\norchestration check --wait &\nEOF",
        ):
            with self.subTest(command=command):
                self.assertEqual("pass", decide(command))

    def test_other_tools_and_bad_input_pass(self):
        self.assertEqual("pass", decide("orca orchestration check --wait &", tool="Write"))
        done = subprocess.run(["python3", str(HOOK)], input="not json", capture_output=True, text=True)
        self.assertEqual((done.returncode, done.stdout), (0, ""))

    def test_plugin_manifest_points_to_the_hook(self):
        manifest = json.loads(PLUGIN.read_text())
        self.assertIn("./orch/hooks/hooks.json", manifest["hooks"])
        hooks = json.loads(HOOKS_JSON.read_text())["hooks"]["PreToolUse"]
        commands = [h["command"] for entry in hooks if entry["matcher"] == "Bash" for h in entry["hooks"]]
        self.assertTrue(any("${CLAUDE_PLUGIN_ROOT}/orch/hooks/block-background-wait.py" in c for c in commands))


if __name__ == "__main__":
    unittest.main()
