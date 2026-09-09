#!/usr/bin/env python3
"""한국어 표기 정책 검사 — 금지어와 인라인 `+` 연결을 찾는다.

금지어 목록의 단일 소스는 이 스킬의 `references/korean-style.md` 의 「외래어 매핑 표」다.
별도 데이터 파일을 두지 않는다. 검사기가 쓰는 정보는 그 표의 부분집합이라,
사본을 만들면 원본과 갈라지는 문제만 되돌아온다.
다른 위치의 표를 쓰려면 `KOREAN_STYLE_RULES` 로 경로를 준다.

사용법:
    korean-style-check.py <파일.md> [<파일.md>...]
    korean-style-check.py --hook          # PostToolUse 훅 모드 (stdin 으로 JSON)

위반 줄을 stdout 으로 출력한다. 출력이 0 줄이면 통과다.
검사에서 제외하는 것 — 렌더·표기 대상이 아니거나 이미 구조화된 형식이다.
YAML frontmatter, 코드 블록(```, 목록 안에 들여쓴 것 포함), 코드 스팬(`...`),
표 행, 제목, 링크 정의 줄, 링크 대상 URL, 자동 링크 URL 이 여기 해당한다.
산술식은 제외 목록에 없다. `GPU 수 × (A + B)` 처럼 코드 스팬으로 감싸면 빠진다.

종료 코드 — CI 와 스크립트가 실패로 잡을 수 있게 결과를 코드로도 낸다.

    0  통과 (--hook 모드는 위반이 있어도 늘 0 이다. 훅은 작업을 막지 않는다)
    1  위반 발견
    2  검사기가 돌지 못함. 매핑 표 파일이 없거나, 표에서 금지어를 추출하지 못한 경우다

편집 직후 자동 검사 (settings.json 은 머신 로컬이라 추적하지 않으므로 여기 남긴다).
하네스 설정의 PostToolUse 훅에 `<이 파일 경로> --hook` 을 걸면 .md 를 쓸 때마다 검사한다.
Claude Code 의 예시는 SKILL.md 의 「훅에 걸기」가 소유한다.
"""

import json
import os
import re
import sys
from pathlib import Path

# 금지어를 부분 문자열로 품고 있지만 그 자체로는 정당한 합성어.
# 한국어 금지어는 조사가 붙어 「게이트를」 처럼 쓰이므로 부분 문자열로 찾아야 한다.
# 그래서 「게이트웨이」(gateway) 처럼 다른 낱말인 경우도 같이 걸린다.
# 뒤 글자가 한글인지로는 조사와 합성어를 가를 수 없어, 예외는 여기에 명시한다.
# 검사 전에 이 낱말들을 줄에서 지우므로, 같은 줄에 맨 「게이트」가 따로 있으면 그건 여전히 잡힌다.
COMPOUND_ALLOW = ["게이트웨이"]

TABLE_HEADING = "## 외래어 매핑 표"
SECTION_HEADING = re.compile(r"^## ")
TABLE_ROW = re.compile(r"^\| ")
TABLE_RULE_ROW = re.compile(r"^\|\s*-")
TABLE_HEADER_ROW = re.compile(r"^\| 금지 ")

# 매핑 표 첫 열의 괄호와, 괄호 안이 영어 원어인 경우.
PARENTHESIZED = re.compile(r"\(([^)]*)\)")
ENGLISH_ORIGIN = re.compile(r"[A-Za-z][A-Za-z -]*")

# 영문 용어는 단어 경계로 찾는다. 그 판정에 쓰는 형태다.
ENGLISH_TERM = re.compile(r"[A-Za-z-]+")

# 본문에서 검사 전에 지울 것.
AUTO_LINK = re.compile(r"<https?://[^>]*>")
CODE_SPAN = re.compile(r"`[^`]*`")

# 줄 자체를 건너뛰는 형태.
FRONT_MATTER_MARK = re.compile(r"^---[ \t]*$")
FENCE = re.compile(r"^[ \t]*```")
HEADING = re.compile(r"^ {0,3}#+[ \t]")
TABLE_LINE = re.compile(r"^[ \t]*\|")
LINK_DEFINITION = re.compile(r"^[ \t]*\[[^\]]+\]:")

INLINE_PLUS = re.compile(r" \+ ")


def rules_path():
    """매핑 표의 경로를 정한다.

    기본값은 이 스크립트 옆의 `../references/korean-style.md` 다.
    절대경로를 박으면 스킬을 받은 팀원 환경에서 그 경로가 없어 검사가 통째로 건너뛰어진다.
    심링크로 걸어 두고 부르는 것이 기본 사용법이라 실체까지 따라간 뒤 계산한다.
    심링크가 놓인 디렉터리를 기준으로 삼으면 스킬 디렉터리를 착각한다.
    """
    override = os.environ.get("KOREAN_STYLE_RULES")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "references" / "korean-style.md"


def load_terms(rules):
    """매핑 표 첫 열에서 금지어를 뽑는다.

        "클램프 / clamp"     → 클램프, clamp   (슬래시는 동의어 구분)
        "게이트 (gate)"      → 게이트, gate    (괄호 안 영어 원어도 금지어)
        "폭주 (CPU 폭주 등)" → 폭주            (괄호 안이 한국어면 용례 설명이라 제외)
        "ephemeral (instance / runner)" → ephemeral  (괄호 안 슬래시는 한정 설명이라 제외)

    괄호 안 영어를 등록하지 않으면 「외부 상태 gate」처럼 원어를 그대로 쓴 문장이 통과한다.
    """
    terms = set()
    in_table = False

    for line in rules.read_text(encoding="utf-8").splitlines():
        if line.startswith(TABLE_HEADING):
            in_table = True
            continue
        if not in_table:
            continue
        if SECTION_HEADING.match(line):
            break
        if not TABLE_ROW.match(line):
            continue
        if TABLE_RULE_ROW.match(line) or TABLE_HEADER_ROW.match(line):
            continue

        column = line.split("|")[1]
        # 괄호를 하나씩 걷어내며 안쪽이 영어 원어면 금지어로 등록한다.
        while (paren := PARENTHESIZED.search(column)) is not None:
            inner = paren.group(1)
            column = column[: paren.start()] + " " + column[paren.end() :]
            if ENGLISH_ORIGIN.fullmatch(inner):
                terms.add(inner.strip())
        for part in column.split("/"):
            if part.strip():
                terms.add(part.strip())

    return sorted(terms)


def load_terms_or_complain(rules):
    """금지어를 뽑고, 표 형태가 바뀌어 결과가 비면 stderr 로 알린다.

    비었을 때 조용히 통과시키지 않는다.
    검사기가 안 도는데 통과로 보이는 상황이 가장 위험하다.
    """
    terms = load_terms(rules)
    if not terms:
        print(
            f"korean-style-check: {rules} 에서 금지어를 추출하지 못했다 — 매핑 표 형식 확인 필요",
            file=sys.stderr,
        )
    return terms


def build_matchers(terms):
    """금지어마다 줄에서 찾는 방법을 정한다.

    영문 용어는 단어 경계로 찾는다. 부분 문자열로 찾으면 다른 낱말 안에서도 걸린다.
    한국어는 조사가 붙어 「게이트를」 처럼 쓰이므로 부분 문자열로 찾는다.
    """
    matchers = []
    for term in terms:
        if ENGLISH_TERM.fullmatch(term):
            boundary = re.compile(
                r"(?:^|[^A-Za-z-])" + re.escape(term) + r"(?:[^A-Za-z-]|$)"
            )
            matchers.append((term, boundary.search))
        else:
            matchers.append((term, lambda line, t=term: t in line))
    return matchers


def find_target_end(target):
    """링크 대상의 닫는 `)` 위치를 돌려준다. 짝이 맞지 않으면 None 이다.

    `<...>` 로 감싼 URL 안의 괄호는 세지 않는다. 역슬래시로 이스케이프한 문자도 세지 않는다.
    """
    depth = 1
    escaped = False
    in_angle = target.startswith("<")

    for i, ch in enumerate(target):
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif in_angle:
            in_angle = ch != ">"
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
    return None


def strip_link_targets(line):
    """마크다운 링크의 URL 만 지우고 문구는 남긴다.

    `](` 부터 짝이 맞는 `)` 까지를 잘라낸다.
    정규식으로 `\\([^)]*\\)` 를 쓰면 `(경로(주석))` 처럼 괄호가 중첩된 URL 에서 먼저 끊긴다.
    짝이 맞는 괄호를 찾지 못하면 남은 부분을 손대지 않고 그대로 둔다.
    """
    kept = ""
    while (mark := line.find("](")) >= 0:
        kept += line[: mark + 1]  # 문구와 닫는 `]` 까지 남긴다
        target = line[mark + 2 :]
        end = find_target_end(target)
        if end is None:
            return kept + line[mark + 1 :]
        line = target[end + 1 :]
    return kept + line


def scan(path, matchers):
    """한 파일을 검사해 위반 줄 목록을 반환한다."""
    found = []
    in_front = False
    in_fence = False

    lines = Path(path).read_text(encoding="utf-8").splitlines()

    for n, raw in enumerate(lines, 1):
        # YAML frontmatter 는 건너뛴다. description 은 트리거 예시를 담고,
        # triggers 는 검색 식별자라 금지어 자체가 값으로 들어가야 한다.
        if n == 1 and FRONT_MATTER_MARK.match(raw):
            in_front = True
            continue
        if in_front:
            if FRONT_MATTER_MARK.match(raw):
                in_front = False
            continue

        # 코드 블록 펜스. 목록 안에 들여쓴 펜스도 토글해야 한다 —
        # 1열에 고정하면 들여쓴 블록의 내용이 본문으로 검사된다.
        if FENCE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        if HEADING.match(raw) or TABLE_LINE.match(raw) or LINK_DEFINITION.match(raw):
            continue

        line = strip_link_targets(raw)  # 링크 문구는 남기고 URL 제외
        line = AUTO_LINK.sub("", line)  # 자동 링크 URL 제외
        line = CODE_SPAN.sub("", line)  # 코드 스팬 제외
        for compound in COMPOUND_ALLOW:  # 정당한 합성어 제외
            line = line.replace(compound, "")

        for term, matches in matchers:
            if matches(line):
                found.append(
                    f'{path}:{n}: 금지어 "{term}" — korean-style 매핑 표의 권장 표현으로'
                )
        if INLINE_PLUS.search(line):
            found.append(f"{path}:{n}: 인라인 + 연결 — 쉼표·와/과 또는 목록으로")

    return found


def check(paths, rules, matchers):
    """대상 파일들을 검사해 위반 줄을 출력하고 종료 코드를 반환한다.

    검사는 끝까지 돌린다. 첫 파일에서 멈추면 나머지 위반이 안 보인다.
    """
    status = 0
    for path in paths:
        if not path.endswith(".md") or not os.path.isfile(path):
            continue
        # 규칙 파일 자신은 건너뛴다 — 매핑 표가 곧 금지어 목록이라 전부 위반으로 잡힌다.
        if rules.is_file() and os.path.samefile(path, rules):
            continue

        found = scan(path, matchers)
        if found:
            print("\n".join(found))
            status = 1
    return status


def run_hook(rules, matchers):
    """PostToolUse 훅 모드.

    stdin 의 tool 입력 JSON 에서 편집된 파일 하나를 뽑아 검사하고,
    위반이 있을 때만 모델 컨텍스트로 되돌릴 JSON 을 낸다. 작업을 막지 않는다.
    """
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    if not isinstance(payload, dict):
        return 0

    def field(section, key):
        value = payload.get(section)
        return value.get(key) if isinstance(value, dict) else None

    target = field("tool_input", "file_path") or field("tool_response", "filePath")
    if not target or not target.endswith(".md") or not os.path.isfile(target):
        return 0
    if rules.is_file() and os.path.samefile(target, rules):
        return 0

    found = scan(target, matchers)
    if not found:
        return 0

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": (
                        "한국어 표기 정책 위반 — 방금 편집한 파일에서 발견했다. 지금 고쳐라.\n"
                        + "\n".join(found)
                    ),
                }
            },
            ensure_ascii=False,
        )
    )
    return 0


def main():
    rules = rules_path()
    if not rules.is_file():
        print(f"korean-style-check: 매핑 표를 찾지 못했다: {rules}", file=sys.stderr)
        return 2

    args = sys.argv[1:]

    if args[:1] == ["--hook"]:
        # 훅 모드는 늘 0 으로 끝난다. 편집을 막지 않고 결과만 알린다.
        # 금지어를 뽑지 못한 것도 stderr 로만 알리고 0 으로 끝낸다.
        terms = load_terms_or_complain(rules)
        return run_hook(rules, build_matchers(terms)) if terms else 0

    if not args:
        return 0

    terms = load_terms_or_complain(rules)
    if not terms:
        return 2
    return check(args, rules, build_matchers(terms))


if __name__ == "__main__":
    sys.exit(main())
