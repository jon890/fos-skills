#!/usr/bin/env python3
"""`SKILL.md` 를 고치고 그것이 위임한 참조 문서를 안 고친 경우를 찾는다.

사용법:
    check_rename_drift.py <대상 저장소> [<기준 커밋>] [--scope <저장소 안 경로>]

기준 커밋을 생략하면 `HEAD` 와 작업 트리를 비교한다.
`--scope` 를 주면 그 아래의 `SKILL.md` 만 본다.

종료 코드:
    0  드리프트 없음
    1  드리프트 검출
    2  사용법 오류이거나 검사 대상이 없음

이 저장소에서 네 번 반복된 실패가 대상이다.
`SKILL.md` 에서 절 이름, 개념, 주어를 바꾸고 그것을 소유한 `references/*.md` 를 안 고쳤다.
그러면 요약본과 소유자 문서가 서로 다른 것을 지시하게 된다.

검사 대상 수를 표준 오류로 알린다.
출력 0줄이 「깨끗함」 인지 「볼 것이 없었음」 인지 구분되지 않으면,
억제된 검사가 통과로 읽혀 회귀가 그대로 지나간다.
"""

import re
import subprocess
import sys
from pathlib import Path

from target_files import resolve_scope, take_scope

PRUNE = {".git", ".omx", "node_modules", "data", "private", "sources", "tasks"}

# diff 줄은 `-` 마커 뒤에 리스트 마커가 또 붙는다 (`-- **이름**...`).
# 마커를 먼저 벗겨야 헤딩과 굵은 라벨이 줄 머리에 온다.
LIST_MARKER = re.compile(r"^ *[-*] +")
LABEL = re.compile(r"^(?:#{2,4} (.+)|\*\*([^*]+)\*\*)")
PAREN_TAIL = re.compile(r" *\(.*\)$")


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)


def changed(repo, base, path):
    """그 경로가 기준 대비 바뀌었는가."""
    return git(repo, "diff", "--quiet", base, "--", str(path)).returncode != 0


def exists_in(repo, base, path):
    """기준 커밋에 그 파일이 있었는가."""
    return git(repo, "cat-file", "-e", f"{base}:{path}").returncode == 0


def removed_labels(repo, base, md):
    """`SKILL.md` 에서 사라진 헤딩과 굵은 라벨."""
    diff = git(repo, "diff", base, "--", str(md)).stdout
    found = set()
    for line in diff.splitlines():
        if not line.startswith("-") or line.startswith("---"):
            continue
        text = LIST_MARKER.sub("", line[1:])
        m = LABEL.match(text)
        if not m:
            continue
        found.add(PAREN_TAIL.sub("", m.group(1) or m.group(2)).strip())
    return sorted(found)


def skill_files(repo, scope=None):
    """가지치기할 디렉터리를 빼고 `SKILL.md` 를 모은다."""
    start = scope or repo
    if start.is_file():
        return [start] if start.name == "SKILL.md" else []
    out = []
    for path in sorted(start.rglob("SKILL.md")):
        if PRUNE & set(path.relative_to(repo).parts):
            continue
        out.append(path)
    return out


def main(argv):
    try:
        rest, scope_arg = take_scope(argv[1:])
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    if not rest:
        print(__doc__, file=sys.stderr)
        return 2
    repo = Path(rest[0])
    base = rest[1] if len(rest) > 1 else "HEAD"
    if not repo.is_dir():
        print(f"대상 저장소가 없다: {repo}", file=sys.stderr)
        return 2
    repo = repo.resolve()
    try:
        scope = resolve_scope(repo, scope_arg)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    scanned = 0
    findings = []
    for md in skill_files(repo, scope):
        refs = md.parent / "references"
        if not refs.is_dir():
            continue
        rel = md.relative_to(repo)
        if not changed(repo, base, rel):
            continue
        scanned += 1

        body = md.read_text(encoding="utf-8", errors="replace")
        for label in removed_labels(repo, base, rel):
            # 그 이름이 지금도 SKILL.md 에 있으면 이름을 바꾼 것이 아니라 옮긴 것이다.
            # diff 는 이동을 삭제와 추가로 보여주므로 이 가드가 없으면 절 이동마다 오탐이 난다.
            if label in body:
                continue

            owners = [p for p in sorted(refs.glob("*.md"))
                      if label in p.read_text(encoding="utf-8", errors="replace")]

            # 기준 커밋에 없던 참조 문서는 드리프트 대상이 아니다.
            # 절을 새 참조 파일로 옮기는 것이 이 스킬이 처방하는 정상 작업인데,
            # 새 파일은 `git diff` 에 변경으로 잡히지 않아 「안 고친 문서」 로 세어진다 (실측).
            # 그러면 분리 작업마다 종료 코드 1 이 나서 진짜 드리프트가 묻힌다.
            owners = [p for p in owners if exists_in(repo, base, p.relative_to(repo))]
            if not owners:
                continue

            # 그 라벨을 담은 문서가 하나라도 함께 바뀌었으면 반영된 것으로 본다.
            # 스킬 단위로 「참조가 하나라도 바뀌었나」 를 보면, 무관한 참조 파일 한 줄 수정이
            # 그 스킬의 드리프트를 전부 침묵시킨다. 라벨을 담은 파일만 따져야 한다.
            # 반대로 파일별로 따로 따지면, 라벨이 새 소유자로 옮겨 간 리팩토링에서
            # 그 단어를 우연히 담은 무관한 문서가 매번 오탐으로 걸린다.
            stale = [p for p in owners if not changed(repo, base, p.relative_to(repo))]
            if len(stale) == len(owners):
                paths = " ".join(f"./{p.relative_to(repo)}" for p in stale)
                findings.append(
                    f'DRIFT: ./{rel} 에서 "{label}" 을 바꿨는데 참조 문서가 그대로다 — {paths}')

    for line in findings:
        print(line)

    # 검사 대상이 없으면 통과가 아니라 검사가 돌지 못한 것이다.
    # 0 으로 끝내면 아무것도 보지 않은 실행이 통과로 기록된다 (실측).
    if scanned == 0:
        print(f"검사 대상 없음 — 기준 '{base}' 대비 변경된 SKILL.md 가 하나도 없다.", file=sys.stderr)
        print("기준을 바꾸거나 변경을 커밋한 뒤 다시 돌린다.", file=sys.stderr)
        return 2

    print(f"검사한 SKILL.md: {scanned}개, 드리프트: {len(findings)}건", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
