#!/usr/bin/env python3
"""문서에 박힌 개수·목록 표기를 뽑아 검토 지점을 제시한다.

자동 판정이 아니다. 개수와 목록은 맥락을 봐야 맞는지 알 수 있으므로
"여기가 틀리기 쉽다" 를 모아 보여 준다.

Usage: python3 check_facts.py [repo-root] [--scope <저장소 안 경로>]
"""
import collections
import pathlib
import re
import sys

from target_files import iter_targets, resolve_scope, take_scope

try:
    ARGV, SCOPE_ARG = take_scope(sys.argv[1:])
    ROOT = pathlib.Path(ARGV[0] if ARGV else ".").resolve()
    SCOPE = resolve_scope(ROOT, SCOPE_ARG)
except ValueError as error:
    print(error, file=sys.stderr)
    sys.exit(2)

# "N개 명령", "N개 파일", "16개" 처럼 개수를 박은 표기
COUNT = re.compile(r"(\d+)\s*개(?:\s*(명령|파일|패턴|항목|축|단계|행))?")
# 고유어 수사로 쓴 개수. 관형사형(두·세·네)과 수사형(둘·셋·넷)이 다르고, 열은 '열다', '열' 과 겹쳐 단위가 붙을 때만 본다.
NATIVE_UNIT = (
    r"개|가지|항목|단계|축|행|명령|파일|패턴|줄|곳|종류|절|문장|칸|표|문서|스킬|검사|판정|조건|"
    r"역할|층|부분|갈래|군데|사례|옵션|스크립트|플래그"
)
NATIVE_DETERMINER = re.compile(
    rf"(?<![가-힣])(?:두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:{NATIVE_UNIT})(?![가-힣]*째)"
)
# 'X 는 둘이다', '스킬 넷' 처럼 단독으로 개수를 말하는 수사. 개수를 명사 앞에서 말할 때는 관형사(두·세·네)를 쓰므로,
# 수사가 공백 뒤 낱말로 이어지는 꼴('둘 다가', '둘 때', '둘 자리', '여섯 달') 은 개수 표기가 아니다.
# 서술격 어미, 보조사 '은/는/뿐', 문장부호, 줄 끝 앞에서만 잡는다. '둘째', '셋째' 도 '째' 가 이어져 빠진다.
NATIVE_NUMERAL = re.compile(
    r"(?<![가-힣])(?:둘|셋|넷|다섯|여섯|일곱|여덟|아홉)"
    r"(?=이다|이고|이며|입니다|이었|이라|은|는|뿐|[,.;:?!)]|\s*$)"
)
# 문서 안에 나열된 옵션 플래그
FLAG = re.compile(r"`(--[a-z][a-z0-9-]+)`")
# 코드 식별자로 보이는 백틱 조각 — 파일명 나열 여부 판단용
JSONFILE = re.compile(r"`([a-z][a-z0-9-]*\.json)`")


def targets():
    yield from (path for path in iter_targets(ROOT, include_readme=True, scope=SCOPE) if path.resolve().is_relative_to(ROOT))


def main():
    counts = []
    flags = collections.defaultdict(set)
    jsons = collections.defaultdict(set)

    for f in targets():
        rel = f.relative_to(ROOT)
        for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for m in COUNT.finditer(line):
                n, unit = m.group(1), m.group(2) or ""
                # 버전·날짜·TTL 등은 대상이 아니다
                if unit or int(n) > 2:
                    counts.append((rel, i, m.group(0).strip(), line.strip()[:70]))
            for pattern in (NATIVE_DETERMINER, NATIVE_NUMERAL):
                for m in pattern.finditer(line):
                    counts.append((rel, i, m.group(0).strip(), line.strip()[:70]))
            for fl in FLAG.findall(line):
                flags[fl].add(str(rel))
            for j in JSONFILE.findall(line):
                jsons[j].add(str(rel))

    print("## 개수 표기 — 늘거나 줄면 곧 틀린다")
    print("개수를 빼고 서술하는 것이 안전하다.\n")
    if counts:
        for rel, i, what, ctx in counts:
            print(f"  {rel}:{i}  \"{what}\"  — {ctx}")
    else:
        print("  없음")

    print("\n## 여러 문서에 흩어진 옵션 — 한 곳이 단일 소스여야 한다")
    multi = {k: v for k, v in flags.items() if len(v) >= 3}
    if multi:
        for k in sorted(multi, key=lambda x: -len(multi[x]))[:12]:
            print(f"  {k}: {len(multi[k])}개 문서 — {', '.join(sorted(multi[k])[:4])}")
    else:
        print("  없음")

    print("\n## 여러 문서에 나열된 캐시·설정 파일 — 목록이 갈라지기 쉽다")
    multi_json = {k: v for k, v in jsons.items() if len(v) >= 2}
    if multi_json:
        for k in sorted(multi_json):
            print(f"  {k}: {', '.join(sorted(multi_json[k]))}")
    else:
        print("  없음")

    print("\n## 직접 확인할 것")
    print("  - 위 개수가 실제와 맞는지 세어 본다 (`ls`, `--help`, `grep -c`)")
    print("  - 옵션이 실제로 있는지 `--help` 로 대조한다")
    print("  - 파일 목록은 코드(예: 캐시 경로 상수)와 대조한다")
    return 0


if __name__ == "__main__":
    sys.exit(main())
