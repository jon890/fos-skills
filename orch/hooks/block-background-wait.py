#!/usr/bin/env python3
"""PreToolUse(Bash) hook: `orca orchestration check --wait` 나 `wait-important.py` 를 셸의 `&` 나 `nohup` 으로 띄우면 거부한다.

셸의 `&` 로 띄운 대기는 끝나도 하네스가 완료 알림을 주지 않아 코디네이터가 깨어나지 못하고, 고아 프로세스로 남는다.
둘째 대기는 `waiter_exists` 로 바로 끝나 그 뒤의 대기까지 망가진다(코디네이터 2회).
`references/waiting.md` 의 산문만으로는 같은 실수가 되풀이돼 명령 단계에서 막는다.

판정:
    한 줄(역슬래시 줄 잇기는 한 줄로 본다)에 `orchestration check` 와 `--wait` 가 함께 있거나 `wait-important` 가 있고,
    그 줄에 `nohup`, `setsid`, `disown` 이 있거나 리다이렉션과 `&&` 가 아닌 `&` 가 있으면 거부한다.
    `run_in_background` 로 돌리는 명령과 앞에서 기다리는 명령은 통과한다.

입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.
"""

from __future__ import annotations

import json
import os
import re
import sys

# PYTHONSAFEPATH 가 켜져 있어도 같은 폴더의 shell_text 를 찾게 한다
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shell_text import QUOTED, strip_heredocs  # noqa: E402

# wait-important.py 는 안에서 check --wait 를 부르므로 같은 규칙으로 막는다
CHECK_WAIT = re.compile(r"\borchestration\s+check\b.*\s--wait\b|\bwait-important\b")
DETACH = re.compile(r"(^|[\s;|&(])(nohup|setsid|disown)\b")
# 리다이렉션(`2>&1`, `>&2`, `&>`, `&>>`)과 `&&` 를 지운 뒤 남은 `&` 가 백그라운드 실행이다
NOT_BACKGROUND = re.compile(r"\d*>&\d*-?|&>>?|&&|\|&")

REASON = (
    "orch: `orca orchestration check --wait` 와 `wait-important.py` 를 셸의 `&` 나 nohup 으로 띄우지 않는다. "
    "끝나도 완료 알림이 오지 않고 고아 프로세스가 남는다. "
    "Bash 도구의 run_in_background 로 `&` 없이 돌린다. 근거와 명령은 orch 스킬의 references/waiting.md 에 있다."
)


def backgrounded_wait(command: str) -> bool:
    # heredoc 본문은 명령이 아니라 입력이라 보지 않는다
    for line in strip_heredocs(command.replace("\\\n", " ")).splitlines():
        if not CHECK_WAIT.search(line):
            continue
        # 따옴표 안의 `&` 는 인자라 백그라운드 실행이 아니다
        bare = QUOTED.sub("''", line)
        if DETACH.search(bare) or "&" in NOT_BACKGROUND.sub(" ", bare):
            return True
    return False


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    command = (data.get("tool_input") or {}).get("command") or ""
    if backgrounded_wait(command):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON,
        }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
