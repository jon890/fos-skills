#!/usr/bin/env python3
"""PreToolUse(Bash) hook: `worker-start --spec` 값이 `spec-line.py` 가 만드는 한 줄 꼴이 아니면 거부한다.

`--spec` 에 지시 본문을 직접 넣으면 길이 제한과 따옴표에서 잘리고, 지시서의 `허락:` 줄이 빠져
Codex worker 가 push 와 PR 생성을 사용자의 허락으로 보지 않고 멈춘다.
`spec-line.py` 는 `지시서 <경로> 를 끝까지 읽고 수행한다. <허락 문구> 못 읽으면 escalation 으로 알린다.` 를 낸다.

판정:
    명령에 `orchestration worker-start` 가 있고 `--spec` 값이 따옴표로 감싼 글자 그대로면,
    그 값이 `지시서 /<경로>.md 를 끝까지 읽고 수행한다.` 로 시작하고 `못 읽으면 escalation 으로 알린다.` 로 끝나야 한다.

오탐을 피하는 기준:
    - 따옴표 안, heredoc 본문, 주석에 든 `worker-start --spec` 문구는 명령이 아니라 보지 않는다(커밋 메시지, 문서 쓰기)
    - `--spec` 은 `worker-start` 와 같은 명령 조각(`;`, `&&`, `|`, 줄바꿈으로 나눈 단위)에 있는 것만 본다
    - 값에 `$` 가 들면(`"$LINE"`, `"$(python3 .../spec-line.py ...)"`) 실행해야 알 수 있어 통과한다
    - `launch-worker.py` 와 `send-to-worker.py` 는 스크립트 안에서 worker-start 를 부르므로 이 hook 을 거치지 않는다
    - `worker-start` 가 아닌 명령의 `--spec` 은 보지 않는다

입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.
"""

from __future__ import annotations

import json
import os
import re
import sys

# PYTHONSAFEPATH 가 켜져 있어도 같은 폴더의 shell_text 를 찾게 한다
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shell_text import mask, pieces, strip_heredocs  # noqa: E402

WORKER_START = re.compile(r"\borchestration\s+worker-start\b")
SPEC_FLAG = re.compile(r"--spec(?:\s+|=)")
SPEC_VALUE = re.compile(r"'([^']*)'|\"((?:\\.|[^\"\\])*)\"|([^\s'\"]+)")
SPEC_LINE = re.compile(r"^지시서 /\S.*?\.md 를 끝까지 읽고 수행한다\..*못 읽으면 escalation 으로 알린다\.$", re.S)

REASON = (
    "orch: `worker-start --spec` 에는 `spec-line.py` 가 만든 한 줄만 준다. "
    "본문을 직접 넣으면 잘리거나 `허락:` 줄이 빠진다. "
    "`launch-worker.py` 로 띄우거나, `--spec \"$(python3 \"$SKILL_DIR/scripts/spec-line.py\" \"$SPEC\" --require-permission)\"` 로 넘긴다."
)


def spec_values(command: str):
    """worker-start 조각의 --spec 값. 가린 글에서 자리를 찾고 원문에서 값을 읽는다."""
    text = strip_heredocs(command)
    masked = mask(text)
    for _, start, end in pieces(masked):
        if not WORKER_START.search(masked[start:end]):
            continue
        for flag in SPEC_FLAG.finditer(masked, start, end):
            m = SPEC_VALUE.match(text, flag.end())
            if m:
                yield m.groups()


def raw_spec(command: str) -> bool:
    for single, double, bare in spec_values(command):
        value = single if single is not None else double if double is not None else bare
        if single is None and "$" in value:
            continue
        if not SPEC_LINE.match(value.strip()):
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
    if raw_spec(command):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON,
        }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
