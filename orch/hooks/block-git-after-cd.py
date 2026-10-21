#!/usr/bin/env python3
"""PreToolUse(Bash) hook: `cd X;` 나 줄바꿈 뒤에 오는 git 쓰기 명령을 거부하고 `&&` 나 `git -C` 를 요구한다.

`cd` 가 실패해도 `;` 와 줄바꿈 뒤 명령은 돈다. 그러면 git 쓰기가 엉뚱한 체크아웃에서 돈다.
워크트리 만들기가 실패해 `cd` 가 실패했는데, 다음 줄의 `git merge` 가 메인 체크아웃에서 돈 일이 있었다(2026-10-21).

판정:
    git 쓰기 명령은 `git [-c 키=값 ...] merge|commit|push|reset|rebase` 다(`merge-base` 같은 읽기 명령은 아니다).
    `git -C 경로 ...` 는 cd 와 무관해 통과한다.
    명령을 `;`, 줄바꿈, `&&`, `||`, `|`, `&` 로 나눠 차례로 본다. `cd`(또는 `pushd`)를 만난 뒤 git 쓰기까지 사이의 연결이 모두 `&&` 면 통과한다.
    사이에 `;`, 줄바꿈, `||`, `&` 가 하나라도 있으면 거부한다.

오탐을 피하는 기준:
    - 따옴표 안, heredoc 본문, 주석은 보지 않는다. 커밋 메시지에 든 `cd x;` 나 `git push` 문구는 명령이 아니다
    - `2>&1`, `&>`, `>&2` 의 `&` 는 리다이렉션이라 연결자가 아니다
    - `&&`, `||`, `|` 뒤 줄바꿈은 이어 쓰기라 같은 명령으로 본다
    - `cd X || exit`, `cd X || return`, `cd X || { ...; exit 1; }` 는 실패하면 멈추므로 안전한 cd 로 본다
    - cd 앞에 `set -e` 나 `set -o errexit` 가 있으면 cd 실패에서 멈추므로 그 뒤 cd 는 안전하다
    - 괄호 subshell 과 `$(...)` 안의 cd 는 바깥 cwd 를 바꾸지 않는다. 그 안은 따로 판정하고 바깥에서는 지운다
    - cd 없이 쓰는 git 쓰기는 Bash 도구의 cwd 에서 돈다. 이 hook 은 보지 않는다

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

GIT_WRITE = re.compile(r"(?:^|[\s(])git\s+(?:-c\s+\S+\s+)*(?:merge|commit|push|reset|rebase)(?![\w-])")
CD = re.compile(r"^\s*(?:(?:do|then|else)\s+)?(?:cd|pushd)(?:\s|$)")
GUARD = re.compile(r"^\s*(?:exit|return)\b")
ERREXIT = re.compile(r"^\s*set\s+(?:-[a-zA-Z]*e[a-zA-Z]*|-o\s+errexit)\b")
# `|| { echo 실패; exit 1; }` 는 `|| exit` 와 같다
BRACE_GUARD = re.compile(r"\|\|\s*\{[^{}]*\b(?:exit|return)\b[^{}]*\}")
SUBSHELL = re.compile(r"\$?\(([^()]*)\)")

REASON = (
    "orch: `cd X;` 나 줄바꿈 뒤에 git 쓰기 명령(merge, commit, push, reset, rebase)을 두지 않는다. "
    "cd 가 실패해도 다음 명령이 돌아 다른 체크아웃에 쓴다. "
    "`cd X && git ...` 로 잇거나 `git -C X ...` 로 쓴다."
)


def unsafe_flat(text: str) -> bool:
    """괄호가 없는 가린 글 한 덩어리를 판정한다."""
    text = BRACE_GUARD.sub("|| exit", text)
    after_cd, unsafe, errexit = False, False, False
    for join, start, end in pieces(text):
        segment = text[start:end]
        if after_cd and join == "||" and GUARD.match(segment) and not unsafe:
            # `cd X || exit` 뒤에는 cd 가 성공했거나 이미 멈췄다
            after_cd = False
            continue
        if after_cd and join is not None and join != "&&":
            unsafe = True
        if ERREXIT.match(segment):
            errexit = True
        if CD.match(segment):
            after_cd, unsafe = not errexit, False
            continue
        if after_cd and unsafe and GIT_WRITE.search(segment):
            return True
    return False


def unsafe_git_after_cd(command: str) -> bool:
    text = mask(strip_heredocs(command))
    # 안쪽 괄호부터 따로 판정한다. 바깥에서는 그 안의 cd 를 지우고 git 쓰기가 있었다는 것만 남긴다
    while True:
        m = SUBSHELL.search(text)
        if not m:
            break
        if unsafe_flat(m.group(1)):
            return True
        stand_in = "git commit" if GIT_WRITE.search(" " + m.group(1)) else "true"
        text = text[:m.start()] + stand_in + text[m.end():]
    return unsafe_flat(text)


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
