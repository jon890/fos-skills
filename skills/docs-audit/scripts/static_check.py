#!/usr/bin/env python3
"""결정적으로 판정되는 문서 위반만 검출한다.

사용법:
    static_check.py [ADR_DIR] [DOC_SCOPE]

`ADR_DIR` 은 옛 호출을 깨지 않으려고 받기만 하고 쓰지 않는다. 주면 표준 오류에 안내 한 줄을 낸다.
깨진 링크·앵커, ADR 색인과 번호 검사는 plan 스킬의 `scripts/adr-docs.ts` 가 맡는다.
이 인자는 docs-audit 의 다음 major 에서 없앤다.
`DOC_SCOPE` 는 검사할 파일이나 디렉터리이고 기본값은 저장소 전체다.
검사 대상 저장소 루트에서 실행한다.

종료 코드:
    0  위반 없음. 경고만 있으면 0 이고 경고 라인을 표준 출력으로 낸다
    1  위반 있음. 위반 라인을 표준 출력으로 낸다
    2  검사가 돌지 못함

경고 라인은 `: WARN ` 을 담는다. 종료 코드를 바꾸지 않는다.

검사 파일 수를 표준 오류로 낸다. 0 이면 통과가 아니라 종료 코드 2 다.
"""

import re
import subprocess
import sys
from pathlib import Path

FENCE = re.compile(r"^\s*```")
HEADING = re.compile(r"^(#+)\s+(.*)$")
TABLE_SEP = re.compile(r"^\s*\|\s*:?-")
TABLE_ROW = re.compile(r"^\s*\|")
# 표의 열을 세기 전에 역슬래시 이스케이프를 지운다.
#   `\|` 는 셀 안의 문자이지 열 구분자가 아니다. 지우지 않으면 그 셀이 둘로 세어져
#   열 수가 실제보다 많아진다. `| `x` | 안의 `\|` 를 센다 |` 와
#   `` `[Ship\|Show\|Ask]` `` 같은 줄이 이 오탐으로 걸린다.
#   `\\|` 는 역슬래시 다음의 진짜 구분자다. 이 정규식이 `\\` 를 먼저 먹어 `|` 가 남는다.
#
#   코드 스팬은 지우지 않는다. GFM 은 인라인을 해석하기 전에 파이프로 셀을 가르므로,
#   백틱 안의 파이프도 구분자로 동작한다. 그래서 GFM 은 코드 스팬 안에서도 이스케이프를
#   요구한다. 코드 스팬을 지우면 백틱 안의 맨 파이프가 만드는 진짜 어긋남을 놓친다.
ESCAPE = re.compile(r"\\.")

# 문서가 `tasks/` 의 계획서를 번호로 가리키는 자리를 찾는다.
#   계획서는 구현이 끝나면 제거되므로, 번호로 가리킨 자리는 그때 깨진 참조가 된다.
#   앞에 단어 문자가 붙은 것은 제외한다. `test_plan032_error_classify.py` 처럼
#   식별자의 일부인 것은 참조가 아니라 이름이고, 바꾸면 그 이름을 부르는 쪽도 함께 깨진다.
#   자리 표시자(`plan{N}`, `plan###`)에는 숫자가 없어 걸리지 않는다.
PLAN_REF = re.compile(r"(?<![A-Za-z0-9_])plan[-_]?\d{2,}")
# 계획서 디렉터리 이름. 모노레포는 `fe-plan027-login` 처럼 하위 프로젝트 접두사를 붙인다.
PLAN_DIR = re.compile(r"(?:[A-Za-z0-9]+-)?plan[-_]?\d{2,}(?:-.*)?")

# `docs/code-architecture.md` 의 책임 설명에 괄호로 늘어놓은 목록을 찾는다.
#   설정 항목과 기능 목록은 설정 파일 주석이나 ADR 이 소유한다. 이 문서에 다시 쓰면
#   항목을 더하는 사람이 앞줄의 형식을 따라 덧붙여, 같은 사실이 두 곳 이상에 생긴다.
#   판정 기준은 plan 의 `references/examples/code-architecture.md` 「디렉터리 책임」 이 소유한다.
#   쉼표로 셋 이상일 때만 잡는다. `(기본값 3, 최대 10)` 같은 둘짜리 부연은 목록이 아니다.
#   처음에는 경고로 낸다. 오탐률을 실측한 뒤 위반으로 올릴지 정한다.
PAREN = re.compile(r"[(（]([^()（）]*)[)）]")
LIST_SEP = re.compile(r"[,，、]")
# 표의 셀 구분자. `\|` 는 셀 안의 문자다.
CELL_SEP = re.compile(r"(?<!\\)\|")
# 트리를 그리는 코드 블록. 언어를 붙인 블록은 코드라 함수 호출의 인자 목록을 잡게 된다.
TREE_FENCE_LANGS = {"", "text", "txt", "plain", "plaintext", "tree"}


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
    docs-audit 를 부르는 시점이 대개 문서를 새로 쓴 직후라 그 파일이 가장 중요한 검사 대상이다.

    `-z` 로 받는 이유는 두 가지다. 공백이 든 경로가 쪼개지지 않고,
    비ASCII 경로가 `"\\354\\235\\264..."` 로 이스케이프되지 않는다.
    이스케이프된 경로는 존재하지 않는 파일이 되어 한글 이름 문서가 통째로 빠진다.
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
            n = ESCAPE.sub("", line).count("|")
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


def in_plan_dir(path):
    """그 파일이 계획서 디렉터리 안에 있는가.

    계획서 안에서 자기 plan 번호를 부르는 것은 참조가 아니다. 파일과 함께 사라진다.
    """
    return any(PLAN_DIR.fullmatch(part) for part in path.parts)


def check_plan_ref(path, lines):
    """문서가 계획서를 번호로 가리키는가.

    코드 스팬은 제외하지 않는다. 계획서 경로는 대개 백틱 안에 적혀,
    제외하면 가장 흔한 형태를 놓친다. 코드 블록의 예시만 제외한다.
    """
    if in_plan_dir(path):
        return []
    out = []
    for lineno, line in outside_fence(lines):
        for m in PLAN_REF.finditer(line):
            out.append(f"{path}:{lineno}: PLAN_REF 계획서를 번호로 가리킨다 → {m.group(0)}")
    return out


def fence_lines(lines):
    """코드 블록 안의 (줄번호, 줄, 여는 펜스의 언어) 만 낸다."""
    lang = None
    for lineno, line in enumerate(lines, 1):
        if FENCE.match(line):
            lang = line.strip()[3:].strip().lower() if lang is None else None
            continue
        if lang is not None:
            yield lineno, line, lang


def listed_items(text):
    """괄호 안에 쉼표로 셋 이상 늘어놓은 첫 괄호. 없으면 None 이다."""
    for m in PAREN.finditer(text):
        items = [i for i in LIST_SEP.split(m.group(1)) if i.strip()]
        if len(items) >= 3:
            return m.group(0)
    return None


def is_code_architecture(path):
    """plan 이 관리하는 `docs/code-architecture.md` 인가.

    상위 디렉터리를 `docs` 로 한정한다. 모노레포의 `frontend/docs/` 도 여기 든다.
    한정하지 않으면 그 규칙을 설명하는 예시 문서가 나쁜 예를 담고 있어 걸린다.
    """
    return path.name == "code-architecture.md" and path.parent.name == "docs"


def check_listed_items(path, lines):
    """책임 설명에 목록을 늘어놓았는가. 표는 첫 열을 뺀 칸을, 트리는 줄 전체를 본다."""
    if not is_code_architecture(path):
        return []
    found = []
    for lineno, line in outside_fence(lines):
        if TABLE_ROW.match(line) and not TABLE_SEP.match(line):
            cells = CELL_SEP.split(line.strip())[1:-1]
            hit = listed_items("|".join(cells[1:]))
            if hit:
                found.append((lineno, hit))
    for lineno, line, lang in fence_lines(lines):
        if lang in TREE_FENCE_LANGS:
            hit = listed_items(line)
            if hit:
                found.append((lineno, hit))
    return [
        f"{path}:{lineno}: WARN LISTED_ITEMS 책임 설명에 목록을 늘어놓았다 → {hit}"
        for lineno, hit in sorted(found)
    ]


def main(argv):
    adr_dir = argv[1] if len(argv) > 1 else ""
    scope = argv[2] if len(argv) > 2 else "."

    if git("rev-parse", "--show-toplevel") is None:
        print("사용법 오류: Git 저장소 루트에서 실행해야 한다.", file=sys.stderr)
        return 2
    if not Path(scope).exists():
        print(f"사용법 오류: 문서 범위를 찾을 수 없다: {scope}", file=sys.stderr)
        return 2

    results = []
    warnings = []
    if adr_dir:
        print("안내: ADR 검사는 plan 의 adr-docs.ts 가 맡는다. ADR_DIR 인자는 쓰지 않는다.", file=sys.stderr)

    checked = 0
    for path in md_files(scope):
        if not path.is_file():
            continue
        checked += 1
        lines = read_lines(path)
        results += check_markdown(path, lines)
        results += check_plan_ref(path, lines)
        warnings += check_listed_items(path, lines)

    print(f"검사한 Markdown: {checked}개 (scope: {scope})", file=sys.stderr)
    if checked == 0:
        print("검사 오류: 범위 안에서 Markdown 파일을 찾지 못했다.", file=sys.stderr)
        return 2

    for line in results + warnings:
        print(line)
    return 1 if results else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
