#!/usr/bin/env python3
"""스킬 문서에서 모델 교체 축의 후보를 고를 신호를 센다.

사용법:
    model_fit_signals.py SKILLS_ROOT [SKILLS_ROOT ...]

SKILLS_ROOT 바로 아래에서 `SKILL.md` 가 있는 폴더를 스킬로 보고, 그 안의 Markdown 을 센다.
`README.md`, `CHANGELOG.md`, `tests/`, `node_modules/` 는 세지 않는다.

신호는 굵은 강조, 실측 사례, 검증 지시, 위임 지시, 금지문, 날짜 표기의 출현 수다.
1000줄당 강조와 사례 수가 다른 스킬보다 크게 높으면 `references/audit-axes.md` 의 「모델 교체」 축으로 읽을 후보다.
**수치는 읽을 순서를 정하는 데만 쓴다.** 판정은 문장을 읽고 시스템 프롬프트와 대조한 결과로 한다.

종료 코드
    0  표를 냈다
    2  인자 오류, 폴더가 없음
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

SIGNALS = {
    "굵은강조": re.compile(r"\*\*[^*]+\*\*"),
    "실측사례": re.compile(r"실측(으로| 사례|했|한 )"),
    "검증지시": re.compile(r"(검증|확인|재검증|다시 돌|verifier|code-reviewer|critic|리뷰어)"),
    "위임지시": re.compile(r"(하위 에이전트|subagent|에이전트에게 맡|위임|Agent 도구|spawn|스폰)"),
    "금지문": re.compile(r"(않는다|하지 않|말 것|금지|NEVER|MUST)"),
    "날짜": re.compile(r"20\d\d-\d\d-\d\d"),
}
SKIP_FILES = {"README.md", "CHANGELOG.md"}
SKIP_DIRS = {"tests", "node_modules"}
DESCRIPTION = re.compile(r"^description:\s*\|?\s*\n?(.*?)\n(?:metadata|---|\w+:)", re.S | re.M)


def description_length(skill_md: Path) -> int:
    match = DESCRIPTION.search(skill_md.read_text(errors="replace"))
    return len(match.group(1).strip()) if match else 0


def count(skill_dir: Path) -> tuple[int, dict[str, int]]:
    lines = 0
    counts = dict.fromkeys(SIGNALS, 0)
    for dirpath, dirnames, filenames in os.walk(skill_dir):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if not name.endswith(".md") or name in SKIP_FILES:
                continue
            for line in open(Path(dirpath) / name, errors="replace"):
                lines += 1
                for key, pattern in SIGNALS.items():
                    counts[key] += len(pattern.findall(line))
    return lines, counts


def main(argv: list[str]) -> int:
    roots = [Path(a) for a in argv]
    missing = [r for r in roots if not r.is_dir()]
    if not roots or missing:
        print(f"인자 오류: 스킬 폴더를 하나 이상 준다. 없는 폴더: {missing}", file=sys.stderr)
        return 2
    print("skill\t줄\tdesc자\t" + "\t".join(SIGNALS) + "\t강조/1000줄\t사례/1000줄")
    for root in roots:
        for skill_dir in sorted(p for p in root.iterdir() if (p / "SKILL.md").is_file()):
            lines, counts = count(skill_dir)
            rates = [counts[key] * 1000 // max(lines, 1) for key in ("굵은강조", "실측사례")]
            row = [skill_dir.name, lines, description_length(skill_dir / "SKILL.md"), *counts.values(), *rates]
            print("\t".join(str(v) for v in row))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
