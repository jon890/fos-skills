#!/usr/bin/env python3
"""worker-ask.py 가 orca 의 JSON 출력에서 값을 꺼낸다. stdin 으로 JSON 을 받는다.

사용법:
    ask-json.py answer                      ask 결과에서 답 본문. 없으면 빈 줄
    ask-json.py message-id                  ask 결과에서 질문 메시지 ID
    ask-json.py run-id                      check 결과에서 runId
    ask-json.py unread --from HANDLE [--seen FILE]
                                            check --peek 결과에서 자기가 보내지 않은 메시지를 사람이 읽는 형태로.
                                            --seen 파일에 든 메시지 ID 는 건너뛰고, 낸 메시지 ID 를 그 파일에 더한다.
                                            worker 가 `check` 로 읽어도 ack 하지 않으면 --peek 에 계속 남아(실측),
                                            한 번 보여 준 메시지로 다시 막지 않으려는 것이다
    ask-json.py reply --from HANDLE --question ID
                                            check --peek 결과에서 그 질문에 답한 status 본문.
                                            스레드가 그 질문이거나, 받는 곳이 이 dispatch 인 것을 찾는다

stdin 이 JSON 이 아니면 아무것도 내지 않고 종료 코드 0 이다. 셸은 빈 출력을 「없음」 으로 읽는다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SKIP_TYPES = {"heartbeat"}


def load():
    text = sys.stdin.read()
    # `--json` 출력 앞뒤에 다른 줄이 섞여도 마지막 JSON 객체를 읽는다
    for line in [text, *reversed(text.splitlines())]:
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data.get("result", data) or {}
    return {}


def body_of(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("answer", "body", "text"):
            if isinstance(value.get(key), str):
                return value[key]
    return ""


def messages(result):
    return [m for m in result.get("messages") or [] if isinstance(m, dict) and m.get("type") not in SKIP_TYPES]


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("what", choices=["answer", "message-id", "run-id", "unread", "reply"])
    parser.add_argument("--from", dest="sender", default="")
    parser.add_argument("--question", default="")
    parser.add_argument("--seen")
    args = parser.parse_args(argv)
    result = load()

    if args.what == "answer":
        for key in ("answer", "reply", "response"):
            text = body_of(result.get(key))
            if text:
                print(text)
                break
    elif args.what == "message-id":
        print(result.get("messageId") or result.get("id") or "")
    elif args.what == "run-id":
        print(result.get("runId") or "")
    elif args.what == "unread":
        seen_file = Path(args.seen) if args.seen else None
        seen = set(seen_file.read_text().split()) if seen_file and seen_file.is_file() else set()
        shown = []
        for m in messages(result):
            if m.get("from_handle") == args.sender or m.get("id") in seen:
                continue
            print(f"[{m.get('type')}] {m.get('subject') or ''} ({m.get('id')}, {m.get('created_at') or ''})")
            print(m.get("body") or "")
            shown.append(str(m.get("id")))
        if seen_file and shown:
            with seen_file.open("a") as f:
                f.write("".join(f"{i}\n" for i in shown))
    elif args.what == "reply":
        dispatch = result.get("dispatchId")
        for m in messages(result):
            if m.get("from_handle") == args.sender or m.get("type") != "status":
                continue
            to_me = dispatch and m.get("to_handle") == f"dispatch:{dispatch}"
            if (args.question and m.get("thread_id") == args.question) or to_me:
                print(m.get("body") or "")
                break
    return 0


if __name__ == "__main__":
    sys.exit(main())
