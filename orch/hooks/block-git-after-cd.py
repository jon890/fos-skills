#!/usr/bin/env python3
"""PreToolUse(Bash) hook: `cd X;` 나 줄바꿈 뒤에 오는 git 쓰기 명령을 거부하고 `&&` 나 `git -C` 를 요구한다.

`cd` 가 실패해도 `;` 와 줄바꿈 뒤 명령은 돈다. 그러면 git 쓰기가 엉뚱한 체크아웃에서 돈다.
워크트리 만들기가 실패해 `cd` 가 실패했는데, 다음 줄의 `git merge` 가 메인 체크아웃에서 돈 일이 있었다(2026-10-21).

판정:
    git 쓰기 명령은 `git [-c 키=값 ...] merge|commit|push|reset|rebase` 다. `git -C 경로 ...` 는 cd 와 무관해 통과한다.
    명령을 `;`, 줄바꿈, `&&`, `||`, `|`, `&` 로 나눠 차례로 본다. `cd` 를 만난 뒤 git 쓰기까지 사이의 연결이 모두 `&&` 면 통과한다.
    사이에 `;`, 줄바꿈, `||`, `&` 가 하나라도 있으면 거부한다.

오탐을 피하는 기준:
    - 따옴표 안과 heredoc 본문은 지우고 본다. 커밋 메시지에 든 `cd x;` 나 `git push` 문구는 명령이 아니다
    - `cd X || exit` 와 `cd X || return` 은 실패하면 멈추므로 안전한 cd 로 본다
    - 명령 앞쪽에 `set -e` 가 있으면 cd 실패에서 멈추므로 통과한다
    - 괄호 subshell `(cd X && git commit)` 은 `&&` 로 이어져 통과한다
    - cd 없이 쓰는 git 쓰기는 Bash 도구의 cwd 에서 돈다. 이 hook 은 보지 않는다

입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.
"""

from __future__ import annotations

import json
import re
import sys

from shell_text import QUOTED, strip_heredocs

GIT_WRITE = re.compile(r"(?:^|[\s(])git\s+(?:-c\s+\S+\s+)*(?:merge|commit|push|reset|rebase)\b")
CD = re.compile(r"^[\s(]*cd(?:\s|$)")
GUARD = re.compile(r"^\s*(?:exit|return)\b")
SET_E = re.compile(r"(?:^|[\s;])set\s+-[a-zA-Z]*e")
SPLIT = re.compile(r"(&&|\|\||;|\n|\|&|\||&)")

REASON = (
    "orch: `cd X;` 나 줄바꿈 뒤에 git 쓰기 명령(merge, commit, push, reset, rebase)을 두지 않는다. "
    "cd 가 실패해도 다음 명령이 돌아 다른 체크아웃에 쓴다. "
    "`cd X && git ...` 로 잇거나 `git -C X ...` 로 쓴다."
)


def unsafe_git_after_cd(command: str) -> bool:
    text = strip_heredocs(command.replace("\\\n", " "))
    text = QUOTED.sub("''", text)
    if SET_E.search(text):
        return False
    parts = SPLIT.split(text)
    segments, joins = parts[0::2], parts[1::2]
    after_cd, unsafe = False, False
    for i, segment in enumerate(segments):
        join = joins[i - 1] if i > 0 else None
        if after_cd and join == "||" and GUARD.match(segment) and not unsafe:
            # `cd X || exit` 뒤에는 cd 가 성공했거나 이미 멈췄다
            after_cd = False
            continue
        if after_cd and join is not None and join != "&&":
            unsafe = True
        if CD.match(segment):
            after_cd, unsafe = True, False
            continue
        if after_cd and unsafe and GIT_WRITE.search(segment):
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
    if unsafe_git_after_cd(command):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON,
        }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
