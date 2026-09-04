#!/usr/bin/env python3
"""문서 안의 `#앵커` 링크가 실제 헤딩을 가리키는지 본다.

사용법:
    md_files | check_anchors.py

종료 코드:
    0  걸린 것이 없다
    1  걸린 것이 있다

`static-check.sh` 의 깨진 링크 검사는 `#` 로 시작하는 대상을 건너뛴다.
그래서 목차가 헤딩과 어긋나도 검출되지 않았다.
실측으로 이 저장소의 `references/six-axis.md` 목차 일곱 항목 중 둘이 그렇게 어긋나 있었다.

슬러그는 GitHub 규칙을 따른다.
소문자로 바꾸고, 영숫자와 공백과 `-` 와 `_` 만 남기고, 공백을 `-` 로 바꾼다.
같은 슬러그가 겹치면 뒤엣것에 `-1`, `-2` 를 붙인다.
"""

import re
import sys
from pathlib import Path

FENCE = re.compile(r"^\s*```")
HEADING = re.compile(r"^(#+)\s+(.*)$")
CODE_SPAN = re.compile(r"`[^`\n]*`")
LINK = re.compile(r"\]\(([^)\s]+)\)")


def slug(text):
    text = CODE_SPAN.sub(lambda m: m.group(0).strip("`"), text).strip()
    kept = "".join(c for c in text.lower() if c.isalnum() or c in " -_")
    return kept.replace(" ", "-")


def anchors_of(path):
    """그 파일이 제공하는 앵커 집합. 중복 헤딩은 GitHub 처럼 번호를 붙인다."""
    found = set()
    counts = {}
    in_fence = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING.match(line)
        if not m:
            continue
        base = slug(m.group(2))
        n = counts.get(base, 0)
        counts[base] = n + 1
        found.add(base if n == 0 else f"{base}-{n}")
    return found


def links_of(path):
    """그 파일이 거는 (줄번호, 대상) 목록. 코드 블록과 코드 스팬은 뺀다."""
    out = []
    in_fence = False
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in LINK.finditer(CODE_SPAN.sub("", line)):
            out.append((lineno, m.group(1)))
    return out


def main():
    paths = [Path(p) for p in sys.stdin.read().split("\n") if p.strip()]
    cache = {}
    hit = False
    for path in paths:
        if not path.is_file():
            continue
        for lineno, target in links_of(path):
            if "#" not in target:
                continue
            filepart, _, anchor = target.partition("#")
            if not anchor or "://" in target or target.startswith("/"):
                continue
            owner = path if not filepart else path.parent / filepart
            if not owner.is_file():
                continue  # 파일 자체의 존재는 static-check.sh 가 본다
            if owner not in cache:
                cache[owner] = anchors_of(owner)
            if anchor not in cache[owner]:
                hit = True
                print(f"{path}:{lineno}: 없는 앵커 → {target}")
    return 1 if hit else 0


if __name__ == "__main__":
    sys.exit(main())
