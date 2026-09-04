#!/usr/bin/env python3
"""리뷰 회신 본문이 봇을 다시 부르거나 무관한 PR 을 참조하는지 본다.

사용법:
    check_reply_body.py <본문파일> [<본문파일>...]

종료 코드:
    0  걸린 것이 없다
    1  걸린 것이 있다
    2  파일을 읽지 못했다

코드 스팬 안은 검사하지 않는다. 백틱으로 감싼 것이 이 문제를 피하는 방법이라
감싼 것까지 걸면 고친 본문이 다시 걸린다.

재트리거 토큰
    봇 워크플로의 `if:` 조건이 본문을 부분 문자열로 맞춰 본다.
    실사례로 회신 본문이 `## /review 반영 완료` 로 시작해 issue_comment 트리거가 발동했다.

auto-link
    GitHub 이 `#숫자`, `GH-숫자`, `owner/repo#숫자` 를 자동으로 링크한다.
    리뷰 항목 번호를 그대로 쓰면 무관한 PR 의 timeline 에 알림이 간다.
"""

import re
import sys

TRIGGER = re.compile(r"(?:/review|@claude|@github-actions|@dependabot)\b")
AUTOLINK = re.compile(r"(?:[\w.-]+/[\w.-]+)?#\d+|\bGH-\d+\b")
CODE_SPAN = re.compile(r"`[^`\n]*`")
FENCE = re.compile(r"^\s*```")


def findings(path):
    """검사 대상 줄마다 (줄번호, 종류, 걸린 문자열) 을 낸다."""
    out = []
    in_fence = False
    with open(path, encoding="utf-8") as f:
        for lineno, raw in enumerate(f, 1):
            if FENCE.match(raw):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            line = CODE_SPAN.sub("", raw)
            for kind, pattern in (("재트리거 토큰", TRIGGER), ("auto-link", AUTOLINK)):
                for m in pattern.finditer(line):
                    out.append((lineno, kind, m.group(0)))
    return out


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    hit = False
    for path in argv[1:]:
        try:
            found = findings(path)
        except OSError as exc:
            print(f"읽지 못했다: {exc}", file=sys.stderr)
            return 2
        for lineno, kind, text in found:
            hit = True
            print(f"{path}:{lineno}: {kind} `{text}`")
    if hit:
        print()
        print("의도한 참조면 백틱으로 감싸고, 아니면 평문으로 바꾼다.")
        print("이미 등록한 댓글이면 gh api 로 body 를 PATCH 한다.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
