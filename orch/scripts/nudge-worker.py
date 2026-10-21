#!/usr/bin/env python3
"""입력 대기로 쉬는 worker 에게 코디네이터 메시지를 읽으라고 터미널에 입력하고, 턴이 시작됐는지 확인한다.

worker 는 `orca orchestration send` 나 `reply` 로 보낸 메시지를 다음 턴에 `check` 를 부를 때 읽는다.
입력 대기로 멈춘 worker 에게는 다음 턴이 오지 않아 메시지가 읽히지 않는다.
이 스크립트는 메시지를 보낸 뒤에 부른다. 화면 마지막 줄들로 입력 대기인지 보고,
입력 대기일 때만 「코디네이터 메시지를 check 로 읽어라」 를 넣는다.
작업 중이면 그 worker 가 다음 `check` 에서 읽으므로 입력하지 않는다.

`terminal send --wait-submit` 이 턴 시작(`turn_started`)을 보지 못하면 Enter 가 삼켜졌을 수 있다.
그 receipt 의 request id 로 `--retry-request` 를 한 번 더 보낸다. 같은 id 는 같은 입력을 두 번 넣지 않고 receipt 를 다시 확인한다.

사용법:
    nudge-worker.py --terminal HANDLE --msg-id MSG_ID [--wait-submit 15]
    nudge-worker.py --terminal HANDLE --text TEXT [--wait-submit 15]
    nudge-worker.py --terminal HANDLE --state
    nudge-worker.py --classify < screen.txt

    --terminal     worker 의 터미널 handle
    --msg-id       방금 보낸 코디네이터 메시지 id. 입력 문구에 넣는다
    --text         메시지 대신 이 글을 그대로 넣는다. dispatch 가 닫혀 check 로 읽을 메시지가 없을 때 send-to-worker.py 가 쓴다.
                   작업 중이어도 넣는다. 에이전트는 작업 중 입력을 대기열에 두었다가 다음 턴에 읽는다
    --wait-submit  턴 시작을 기다릴 초. 기본 15
    --state        그 터미널 화면을 판정만 하고 상태 한 낱말을 낸다
    --classify     표준 입력의 화면 문자열을 판정만 하고 상태 한 낱말을 낸다

화면 상태:
    working     작업 중이다. Claude 의 「✳ Thinking… (」 줄, Codex 의 「• Working (」 줄, 「esc to interrupt」
    idle        입력란이 비어 있다. Claude 의 「❯」 만 있는 줄, Codex 의 「›」 줄이 비었거나 기본 안내 문구다
    draft       입력란에 누가 쓰다 만 글이 있다. 덧붙여 보내면 그 글과 섞인다
    permission  권한 확인 창에서 기다린다. 코디네이터가 대신 고르지 않는다
    unknown     어느 것도 아니다

ORCA 환경 변수로 orca 실행 파일을 바꾼다.

종료 코드:
    0  입력해서 턴이 시작됐거나, 작업 중이라 입력할 필요가 없다. 표준 출력 첫 낱말이 nudged 또는 working 이다.
       --text 로 작업 중인 터미널에 넣었으면 queued 다
    1  입력했지만 다시 확인해도 턴 시작을 보지 못했다. 화면을 직접 본다
    4  입력란에 글이 있거나 권한 확인 창이거나 화면을 판정하지 못해 입력하지 않았다
    5  orca 가 오류를 냈다. 그 출력을 그대로 낸다
    2  사용법 오류
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

ORCA = os.environ.get("ORCA", "orca")
# 상태 줄과 입력란은 화면 아래에 있다. 위쪽 대화 기록의 「›」 와 「❯」 는 보지 않는다
BOTTOM = 12

PERMISSION = re.compile(r"Do you want to (proceed|make this edit|create)|Would you like to (run|make|apply)|Allow command\?")
WORKING = re.compile(r"esc to interrupt|^\s*• Working \(|^\S\s+[A-Z][a-z]+…")
CLAUDE_INPUT = re.compile(r"^\s*❯(?:\s(.*))?$")
CODEX_INPUT = re.compile(r"^\s*›(?:\s(.*))?$")
# Codex 는 빈 입력란에 안내 문구를 흐리게 보여 준다. 화면 문자열로는 입력한 글과 구분되지 않아 알려진 문구만 빈 것으로 본다
CODEX_PLACEHOLDERS = (
    "Ask Codex to do anything", "Explain this codebase", "Summarize recent commits", "Implement {feature}",
    "Find and fix a bug in @filename", "Write tests for @filename", "Improve documentation in @filename",
    "Run /review on my current changes", "Use /skills to list available skills",
)


def classify(lines):
    tail = [line.rstrip() for line in lines if line.strip()][-BOTTOM:]
    if any(PERMISSION.search(line) for line in tail):
        return "permission"
    if any(WORKING.search(line) for line in tail):
        return "working"
    for line in reversed(tail):
        claude = CLAUDE_INPUT.match(line)
        if claude:
            text = (claude.group(1) or "").strip()
            # 선택 창의 「❯ 1. Yes」 는 위에서 권한 확인으로 판정했다. 남은 「❯ 글」 은 입력란의 글이다
            return "draft" if text else "idle"
        codex = CODEX_INPUT.match(line)
        if codex:
            text = (codex.group(1) or "").strip()
            return "idle" if not text or text in CODEX_PLACEHOLDERS else "draft"
    return "unknown"


def orca_json(*args):
    done = subprocess.run([ORCA, *args, "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        data = json.loads(done.stdout)
    except json.JSONDecodeError:
        data = None
    if not isinstance(data, dict) or not data.get("ok"):
        print((done.stdout + done.stderr).strip() or f"nudge-worker: orca {args[0]} {args[1]} 출력이 JSON 이 아니다")
        return None
    return data.get("result") or {}


def screen_lines(terminal):
    result = orca_json("terminal", "read", "--terminal", terminal, "--screen")
    if result is None:
        return None
    tail = (result.get("terminal") or {}).get("tail") or []
    return tail if isinstance(tail, list) else str(tail).splitlines()


def send(terminal, text, wait_submit, retry=None):
    args = ["terminal", "send", "--terminal", terminal, "--text", text, "--enter"]
    if wait_submit:
        args += ["--wait-submit", str(wait_submit)]
    if retry:
        args += ["--retry-request", retry]
    result = orca_json(*args)
    if result is None:
        return None
    return (result.get("send") or {}).get("prompt") or {}


def nudge(terminal, msg_id, wait_submit, text=None):
    lines = screen_lines(terminal)
    if lines is None:
        return 5
    state = classify(lines)
    if state == "working" and text is not None:
        # 작업 중에는 턴이 새로 시작하지 않으므로 턴 시작을 기다리지 않는다
        if send(terminal, text, None) is None:
            return 5
        print("queued: 작업 중인 터미널에 넣었다. 다음 턴에 읽는다")
        return 0
    if state == "working":
        print("working: 작업 중이라 다음 check 에서 읽는다. 입력하지 않았다")
        return 0
    if state != "idle":
        print(f"{state}: 입력하지 않았다. terminal read --screen 으로 화면을 직접 본다")
        return 4

    if text is None:
        text = f"코디네이터 메시지 {msg_id} 를 orca orchestration check 로 읽고 수행한다"
    prompt = send(terminal, text, wait_submit)
    if prompt is None:
        return 5
    for attempt in ("first", "retry"):
        if "turn_started" in (prompt.get("stages") or []):
            print(f"nudged: 턴이 시작됐다 ({prompt.get('requestId')})")
            return 0
        if prompt.get("observation") == "permission":
            print(f"permission: 권한 확인 창이 떠 입력이 확인되지 않았다 ({prompt.get('requestId')})")
            return 4
        request = prompt.get("requestId")
        if attempt == "retry" or not request or request == "unsupported-old-host":
            break
        prompt = send(terminal, text, wait_submit, retry=request)
        if prompt is None:
            return 5
    print(f"unobserved: 입력했지만 턴 시작을 보지 못했다 ({prompt.get('requestId')}). 화면을 직접 본다")
    return 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--terminal")
    parser.add_argument("--msg-id")
    parser.add_argument("--text")
    parser.add_argument("--wait-submit", type=int, default=15)
    parser.add_argument("--state", action="store_true")
    parser.add_argument("--classify", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if args.classify:
        print(classify(sys.stdin.read().splitlines()))
        return 0
    if args.state and args.terminal:
        lines = screen_lines(args.terminal)
        if lines is None:
            return 5
        print(classify(lines))
        return 0
    if not args.terminal or bool(args.msg_id) == bool(args.text) or args.wait_submit <= 0:
        print("nudge-worker: --terminal 과 --msg-id 나 --text 중 하나가 필요하고 --wait-submit 은 0 보다 커야 한다",
              file=sys.stderr)
        return 2
    return nudge(args.terminal, args.msg_id, args.wait_submit, args.text)


if __name__ == "__main__":
    sys.exit(main())
