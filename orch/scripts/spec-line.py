#!/usr/bin/env python3
"""`worker-start --spec` 에 넘길 첫 지시 줄을 지시서에서 만든다.

`--spec` 에는 지시서 경로를 담은 한 줄만 준다. 사용자가 허락한 외부 동작(push, PR 열기)이 지시서 파일 안에만 있으면
Codex worker 가 그 허락을 사용자의 직접 요청으로 볼지 실행마다 달라, 일부는 GitHub 게시가 금지됐다며 멈춘다.
지시서의 `허락:` 줄을 첫 지시 줄에 그대로 붙여, 허락이 띄울 때 받는 지시 안에 들어가게 한다.

지시서에는 이렇게 적는다. 같은 줄의 `허락:` 뒤가 붙는 문구다. 여러 줄이면 차례로 붙인다.

    허락: push 와 draft PR 생성(base main)은 사용자가 허락했다.

사용법:
    spec-line.py SPEC_FILE [--require-permission]

    --require-permission  `허락:` 줄이 없으면 종료 코드 1 로 끝난다. PR 을 열게 하는 지시서에 쓴다

출력:
    `지시서 <경로> 를 끝까지 읽고 수행한다. <허락 문구> 못 읽으면 escalation 으로 알린다.` 한 줄

종료 코드:
    0  만들었다
    1  --require-permission 인데 `허락:` 줄이 없다
    2  사용법 오류, 지시서를 읽지 못했다
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 목록 기호와 굵은 글씨는 벗긴다. `- **허락:** ...` 도 같은 줄로 본다
PERMISSION = re.compile(r"^\s*(?:[-*]\s+)?(?:\*\*)?허락\s*:\s*(?:\*\*)?\s*(.+?)\s*$")


def permissions(text):
    found = []
    for line in text.splitlines():
        m = PERMISSION.match(line)
        if m:
            phrase = m.group(1).strip()
            found.append(phrase if phrase.endswith(".") else phrase + ".")
    return found


def spec_line(path, phrases):
    parts = [f"지시서 {path} 를 끝까지 읽고 수행한다.", *phrases, "못 읽으면 escalation 으로 알린다."]
    return " ".join(parts)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("spec")
    parser.add_argument("--require-permission", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    path = Path(args.spec)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"spec-line: 지시서를 읽지 못했다: {exc}", file=sys.stderr)
        return 2
    phrases = permissions(text)
    if args.require_permission and not phrases:
        print(f"spec-line: 지시서에 `허락:` 줄이 없다: {path}", file=sys.stderr)
        return 1
    print(spec_line(path.resolve(), phrases))
    return 0


if __name__ == "__main__":
    sys.exit(main())
