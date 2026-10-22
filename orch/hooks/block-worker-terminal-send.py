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
    - 첫 화면 승인은 통과한다. 본문 없이 `--enter` 만 보내는 명령이고, 그 worker 의 `worker-show --dispatch` 가
      `agent-trust-workspace` 같은 첫 화면 대기(`observation.agentWait`, `projection.stage.detail`)를 보이면 거부하지 않는다.
      `launch.md` 「첫 화면에서 멈춤」 이 사용자 승인 뒤 이 명령으로 첫 선택지를 고르라고 한다.
      단계를 읽지 못하면 거부한다
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
BODY_FLAG = re.compile(r"--(?:text|interrupt)\b")
ENTER_FLAG = re.compile(r"--enter\b")
# Orca 가 첫 화면에서 사람을 기다린다고 알리는 이름. 사용자가 답할 화면이라 키 입력만 허용한다
FIRST_SCREEN = re.compile(r"agent-(?:trust-workspace|update-prompt|cwd-prompt|hooks-review-prompt)")

REASON = (
    "orch: worker 터미널({handle})에 `orca terminal send` 로 직접 쓰지 않는다. "
    "작업 중이면 입력이 섞이고, 끝난 dispatch 면 지시가 어느 Task 에도 묶이지 않는다. "
    "`python3 \"$SKILL_DIR/scripts/send-to-worker.py\" --dispatch <id> --body ...` 로 보낸다. "
    "깨우기만 하려면 `nudge-worker.py` 를 쓴다."
)


def orca_json(*args: str) -> dict | None:
    env = {k: v for k, v in os.environ.items() if k != "ORCA_TERMINAL_HANDLE"}
    orca = os.environ.get("ORCA", "orca")
    try:
        done = subprocess.run([orca, "orchestration", *args, "--json"], capture_output=True, text=True, env=env, timeout=8)
        data = json.loads(done.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
        return None
    if done.returncode != 0 or not isinstance(data, dict):
        return None
    result = data.get("result", data)
    return result if isinstance(result, dict) else {"workers": result}


def active_workers() -> dict[str, str | None]:
    """active 터미널의 worker. {터미널 handle: dispatch id}"""
    result = orca_json("worker-list", "--terminal-state", "active", "--limit", "100") or {}
    rows = result.get("workers") or []
    return {w["agentTerminalHandle"]: w.get("dispatchId") for w in rows
            if isinstance(w, dict) and w.get("agentTerminalHandle")}


def on_first_screen(dispatch: str | None) -> bool:
    """그 dispatch 가 첫 화면(신뢰, 업데이트 안내 같은)에서 사람을 기다리는가. 읽지 못하면 False"""
    if not dispatch:
        return False
    shown = orca_json("worker-show", "--dispatch", dispatch) or {}
    wait = (shown.get("observation") or {}).get("agentWait")
    detail = ((shown.get("projection") or {}).get("stage") or {}).get("detail")
    return bool(FIRST_SCREEN.search(json.dumps([wait, detail], ensure_ascii=False)))


def send_targets(command: str) -> dict[str, bool]:
    """`orca terminal send` 조각의 --terminal 값. {handle: 키만 보내는가}.
    가린 글에서 자리를 찾고 원문에서 값을 읽는다. 같은 handle 이 여러 조각이면 본문을 보내는 쪽이 이긴다."""
    text = strip_heredocs(command)
    masked = mask(text)
    targets: dict[str, bool] = {}
    for _, start, end in pieces(masked):
        piece = masked[start:end]
        if not SEND.search(piece):
            continue
        key_only = bool(ENTER_FLAG.search(piece)) and not BODY_FLAG.search(piece)
        for flag in TARGET_FLAG.finditer(masked, start, end):
            m = TARGET_VALUE.match(text, flag.end())
            if m:
                targets[m.group(1)] = targets.get(m.group(1), True) and key_only
    return targets


def target_worker(command: str) -> str | None:
    targets = send_targets(command)
    if not targets:
        return None
    workers = active_workers()
    for handle in sorted(set(targets) & set(workers)):
        if targets[handle] and on_first_screen(workers[handle]):
            continue
        return handle
    return None


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
