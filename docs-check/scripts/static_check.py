#!/usr/bin/env python3
"""결정적으로 판정되는 문서 위반만 검출한다.

사용법:
    static_check.py [ADR_DIR] [DOC_SCOPE]

`ADR_DIR` 을 생략하면 ADR Index 동기화 검사를 건너뛴다.
`DOC_SCOPE` 는 검사할 파일이나 디렉터리이고 기본값은 저장소 전체다.
검사 대상 저장소 루트에서 실행한다.

종료 코드:
    0  위반 없음
    1  위반 있음. 위반 라인을 표준 출력으로 낸다
    2  검사가 돌지 못함

검사 파일 수를 표준 오류로 낸다. 0 이면 통과가 아니라 종료 코드 2 다.
"""

import re
import subprocess
import sys
from pathlib import Path

FENCE = re.compile(r"^\s*```")
HEADING = re.compile(r"^(#+)\s+(.*)$")
CODE_SPAN = re.compile(r"`[^`\n]*`")
LINK = re.compile(r"\]\(([^)\s]+)\)")
TABLE_SEP = re.compile(r"^\s*\|\s*:?-")
TABLE_ROW = re.compile(r"^\s*\|")

# 본문 ADR 번호는 헤딩만 센다.
#   아무 곳의 ADR-NNN 을 다 세면 "향후 ADR은 ADR-009부터 추가" 같은 안내 문장이
#   실재하지 않는 ADR 로 잡혀 항상 불일치가 난다. 실측으로 그 문장이 있는 저장소가 있었다.
ADR_BODY = re.compile(r"^#+\s+.*?(ADR-\d+)")
# INDEX 번호는 등재 항목만 센다. 목록형과 표형을 모두 받는다.
#   표만 읽으면 목록형 저장소에서 0 개를 뽑아 본문 번호 전체를 "누락" 으로 보고한다.
#   실측으로 목록형이 다수였다.
ADR_INDEX = re.compile(r"^\s*(?:[-*]\s+\[?|\|\s*)(ADR-\d+)")


def git(*args):
    """git 을 돌려 표준 출력을 낸다. 실패하면 None 이다."""
    try:
        done = subprocess.run(
            ["git", *args], capture_output=True, check=False, text=False
        )
    except OSError:
        return None
    return done.stdout if done.returncode == 0 else None


def md_files(scope):
    """검사 대상 Markdown. 추적 파일과 미추적 신규 파일을 모두 본다.

    `git ls-files` 만 쓰면 방금 만든 문서를 통째로 건너뛴 채 0 줄을 내, 거짓 통과가 된다.
    docs-check 를 부르는 시점이 대개 문서를 새로 쓴 직후라 그 파일이 가장 중요한 검사 대상이다.

    `-z` 로 받는 이유는 두 가지다. 공백이 든 경로가 쪼개지지 않고,
    비ASCII 경로가 `"\\354\\235\\264..."` 로 이스케이프되지 않는다.
    실측으로 이스케이프된 경로는 존재하지 않는 파일이 되어 한글 이름 문서가 통째로 빠졌다.
    """
    args = ["ls-files", "-co", "-z", "--exclude-standard"]
    args += ["--", scope] if scope != "." else ["--", "*.md"]
    out = git(*args)
    if out is None:
        return []
    names = [n for n in out.decode("utf-8", "surrogateescape").split("\0") if n]
    return [Path(n) for n in names if n.endswith(".md")]


def read_lines(path):
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def outside_fence(lines):
    """코드 블록 밖의 (줄번호, 줄) 만 낸다."""
    in_fence = False
    for lineno, line in enumerate(lines, 1):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            yield lineno, line


def check_index(adr_dir):
    """본문 ADR 번호 집합과 INDEX.md 의 등재 번호 집합이 같은가.

    INDEX.md 가 없는 구조(단일 파일 ADR 등)에서는 건너뛴다.
    없는 파일을 빈 Index 로 취급하면 본문 번호 전체가 누락으로 잡혀 항상 불일치가 난다.
    """
    index = adr_dir / "INDEX.md"
    if not index.is_file():
        return []

    body = set()
    for path in sorted(adr_dir.glob("*.md")):
        for line in read_lines(path):
            m = ADR_BODY.match(line)
            if m:
                body.add(m.group(1))

    listed = set()
    for line in read_lines(index):
        m = ADR_INDEX.match(line)
        if m:
            listed.add(m.group(1))

    if body == listed:
        return []
    out = [f"INDEX_DESYNC: {adr_dir} — 본문과 INDEX.md 의 ADR 번호 집합이 다르다"]
    for num in sorted(body - listed):
        out.append(f"  본문에만 있다: {num}")
    for num in sorted(listed - body):
        out.append(f"  INDEX.md 에만 있다: {num}")
    return out


def check_markdown(path, lines):
    """렌더가 어긋나는 결정적 오류만 본다."""
    out = []
    cols = None
    prev_level = 0
    fences = sum(1 for line in lines if FENCE.match(line))

    for lineno, line in outside_fence(lines):
        if TABLE_SEP.match(line):
            continue  # 구분선은 열 수 비교 대상이 아니지만 표를 끊지도 않는다
        if TABLE_ROW.match(line):
            n = line.count("|")
            if cols is None:
                cols = n
            elif n != cols:
                out.append(
                    f"{path}:{lineno}: 표 열 수 불일치 "
                    f"(헤더 {cols - 1}칸, 이 행 {n - 1}칸)"
                )
            continue
        cols = None

        m = HEADING.match(line)
        if m:
            level = len(m.group(1))
            if prev_level and level > prev_level + 1:
                out.append(
                    f"{path}:{lineno}: 헤딩 레벨 건너뜀 (h{prev_level} → h{level})"
                )
            prev_level = level

    if fences % 2:
        out.append(f"{path}: 코드 펜스 짝이 안 맞음 (``` {fences}개)")
    return out


def links_of(lines):
    """코드 블록과 코드 스팬 밖의 (줄번호, 대상) 목록."""
    for lineno, line in outside_fence(lines):
        for m in LINK.finditer(CODE_SPAN.sub("", line)):
            yield lineno, m.group(1)


def is_local(target):
    """로컬 파일을 가리키는 링크인가.

    URL 스킴은 로컬 파일이 아니다. http 와 mailto 만 예외 처리하면
    `dooray://` 같은 앱 스킴을 상대 경로로 취급해 정상 링크를 전부 깨진 링크로 보고한다.
    `/` 로 시작하는 경로는 발행 사이트의 루트 기준 URL 관례라 로컬 파일이 아니다.
    """
    if not target or "://" in target or target.startswith(("/", "mailto:", "#")):
        return False
    return True


def slug(text):
    """GitHub 의 헤딩 앵커 규칙."""
    text = CODE_SPAN.sub(lambda m: m.group(0).strip("`"), text).strip()
    kept = "".join(c for c in text.lower() if c.isalnum() or c in " -_")
    return kept.replace(" ", "-")


def anchors_of(lines):
    """그 파일이 제공하는 앵커. 중복 헤딩은 GitHub 처럼 번호를 붙인다."""
    found = set()
    counts = {}
    for _, line in outside_fence(lines):
        m = HEADING.match(line)
        if not m:
            continue
        base = slug(m.group(2))
        n = counts.get(base, 0)
        counts[base] = n + 1
        found.add(base if n == 0 else f"{base}-{n}")
    return found


def check_links(path, lines, cache):
    """상대 링크가 실제 파일을 가리키는가. `#앵커` 가 실제 헤딩을 가리키는가."""
    out = []
    for lineno, target in links_of(lines):
        filepart, _, anchor = target.partition("#")

        if filepart and is_local(filepart):
            owner = path.parent / filepart
            if not owner.exists():
                out.append(f"{path}: 깨진 링크 → {target}")
                continue
        elif filepart:
            continue  # 외부 URL 과 사이트 루트 경로
        else:
            owner = path  # 같은 파일 안의 앵커

        if not anchor:
            continue
        owner = owner.resolve()
        if not owner.is_file():
            continue
        if owner not in cache:
            cache[owner] = anchors_of(read_lines(owner))
        if anchor not in cache[owner]:
            out.append(f"{path}:{lineno}: 없는 앵커 → {target}")
    return out


def main(argv):
    adr_dir = argv[1] if len(argv) > 1 else ""
    scope = argv[2] if len(argv) > 2 else "."

    if git("rev-parse", "--show-toplevel") is None:
        print("사용법 오류: Git 저장소 루트에서 실행해야 한다.", file=sys.stderr)
        return 2
    if adr_dir and not Path(adr_dir).is_dir():
        print(f"사용법 오류: ADR 디렉터리를 찾을 수 없다: {adr_dir}", file=sys.stderr)
        return 2
    if not Path(scope).exists():
        print(f"사용법 오류: 문서 범위를 찾을 수 없다: {scope}", file=sys.stderr)
        return 2

    results = []
    if adr_dir:
        results += check_index(Path(adr_dir))

    cache = {}
    checked = 0
    for path in md_files(scope):
        if not path.is_file():
            continue
        checked += 1
        lines = read_lines(path)
        results += check_markdown(path, lines)
        results += check_links(path, lines, cache)

    print(f"검사한 Markdown: {checked}개 (scope: {scope})", file=sys.stderr)
    if checked == 0:
        print("검사 오류: 범위 안에서 Markdown 파일을 찾지 못했다.", file=sys.stderr)
        return 2

    for line in results:
        print(line)
    return 1 if results else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
