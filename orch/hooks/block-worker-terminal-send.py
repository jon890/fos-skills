#!/usr/bin/env python3
"""PreToolUse(Bash) hook: worker 터미널에 직접 `orca terminal send` 하는 Bash 호출을 거부한다.

worker 가 일하는 중에 터미널에 직접 쓰면 입력이 섞이고, dispatch 가 끝났으면 그 지시는 어느 Task 에도 묶이지 않는다.
`send-to-worker.py` 가 dispatch 상태를 보고 reply 와 `nudge-worker.py`, 또는 후속 지시서로 나눠 보낸다.

판정:
    명령에 `orca terminal send` 가 있고 `--terminal` 값이 `term_` 로 시작하는 낱말이면,
    `orca orchestration worker-list --terminal-state active` 의 `agentTerminalHandle` 에 그 값이 있을 때 거부한다.

오탐을 피하는 기준:
    - 따옴표 안, heredoc 본문, 주석에 든 `orca terminal send` 문구는 보지 않는다. 그런 명령에는 orca 를 조회하지 않는다
    - `--terminal` 은 `orca terminal send` 와 같은 명령 조각에 있는 것만 본다(`terminal read --terminal` 은 아니다)
    - worker 가 아닌 터미널(코디네이터 자신의 셸, 개발 서버)은 worker-list 에 없어 통과한다
    - `--terminal "$T"` 처럼 값이 변수면 정적으로 알 수 없어 통과한다
    - orca 조회가 실패하거나 시간을 넘기면 통과한다. 이 hook 때문에 다른 명령이 막히지 않게 한다
    - `send-to-worker.py`, `nudge-worker.py` 는 스크립트 안에서 orca 를 부르므로 이 hook 을 거치지 않는다
    - worker-list 는 부른 터미널에 묶인 Run 으로 범위를 좁히므로 ORCA_TERMINAL_HANDLE 을 빼고 부른다

입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

# PYTHONSAFEPATH 가 켜져 있어도 같은 폴더의 shell_text 를 찾게 한다
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shell_text import mask, pieces, strip_heredocs  # noqa: E402

SEND = re.compile(r"\borca\s+terminal\s+send\b")
TARGET_FLAG = re.compile(r"--terminal(?:\s+|=)")
TARGET_VALUE = re.compile(r"['\"]?(term_[\w-]+)")

REASON = (
    "orch: worker 터미널({handle})에 `orca terminal send` 로 직접 쓰지 않는다. "
    "작업 중이면 입력이 섞이고, 끝난 dispatch 면 지시가 어느 Task 에도 묶이지 않는다. "
    "`python3 \"$SKILL_DIR/scripts/send-to-worker.py\" --dispatch <id> --body ...` 로 보낸다. "
    "깨우기만 하려면 `nudge-worker.py` 를 쓴다."
)


def worker_handles() -> set[str]:
    env = {k: v for k, v in os.environ.items() if k != "ORCA_TERMINAL_HANDLE"}
    orca = os.environ.get("ORCA", "orca")
    try:
        done = subprocess.run([orca, "orchestration", "worker-list", "--terminal-state", "active",
                               "--limit", "100", "--json"], capture_output=True, text=True, env=env, timeout=8)
        data = json.loads(done.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
        return set()
    if done.returncode != 0:
        return set()
    result = data.get("result", data) if isinstance(data, dict) else {}
    rows = (result.get("workers") if isinstance(result, dict) else result) or []
    return {w.get("agentTerminalHandle") for w in rows if isinstance(w, dict) and w.get("agentTerminalHandle")}


def send_targets(command: str) -> set[str]:
    """`orca terminal send` 조각의 --terminal 값. 가린 글에서 자리를 찾고 원문에서 값을 읽는다."""
    text = strip_heredocs(command)
    masked = mask(text)
    targets = set()
    for _, start, end in pieces(masked):
        if not SEND.search(masked[start:end]):
            continue
        for flag in TARGET_FLAG.finditer(masked, start, end):
            m = TARGET_VALUE.match(text, flag.end())
            if m:
                targets.add(m.group(1))
    return targets


def target_worker(command: str) -> str | None:
    targets = send_targets(command)
    if not targets:
        return None
    hits = targets & worker_handles()
    return sorted(hits)[0] if hits else None


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    command = (data.get("tool_input") or {}).get("command") or ""
    handle = target_worker(command)
    if handle:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON.format(handle=handle),
        }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
