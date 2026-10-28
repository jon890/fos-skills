#!/usr/bin/env python3
"""harness-cleanup 2단계의 정적 검사를 모두 따로 돌리고 스크립트별 종료 코드와 판정을 표로 낸다.

파이프 뒤 `echo $?` 로 돌리면 종료 코드가 뒤 명령의 것이 되어 통과로 잘못 읽는다.
이 스크립트는 각 검사를 하위 프로세스로 따로 돌려 종료 코드를 그대로 읽는다.
종료 코드의 뜻은 각 검사 스크립트의 docstring 이 소유한다. 여기서는 그 뜻을 판정 낱말로만 옮긴다.

사용법:
    run_checks.py ROOT [--scope PATH] [--base COMMIT] [--min-run N]

ROOT 는 감사 대상 저장소 루트다.
collect_targets, check_references, check_facts, check_duplication, check_rename_drift 를 돌린다.
--min-run 은 check_duplication 의 최소 연속 줄 수(기본 5)다.
--base 가 없으면 check_rename_drift 는 HEAD 와 작업 트리를 비교한다.
docs-check 2단계는 그 스킬의 `scripts/run_static_check.py` 가 같은 방식으로 맡는다. 두 스킬의 배포 경로가 달라 스크립트를 나눴다.

출력은 표가 먼저고, 이어 검사마다 표준 출력과 표준 오류를 그대로 붙인다.
판정 낱말은 다음과 같다.
    통과        종료 코드 0 이고 출력으로 따로 가를 것이 없다
    출력 판정   종료 코드가 판정을 말하지 않는다. 출력을 읽고 판정한다 (check_facts)
    발견        종료 코드 1. 출력의 걸린 자리를 모두 처리해야 한다
    해당 없음   검사가 볼 대상이 없어 돌지 않았다 (check_rename_drift 의 2)
    실행 실패   종료 코드 2 이거나 알 수 없는 코드. 통과가 아니다. 대상 파일이 0 인 경우도 여기다

종료 코드
    0  실행 실패와 발견이 하나도 없다
    1  발견이 있다
    2  실행 실패가 있다. 인자 오류도 여기다
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# 검사 이름 → 종료 코드 → 판정. 뜻의 출처는 각 스크립트 docstring 의 「종료 코드」다.
VERDICTS = {
    "collect_targets": {0: "통과"},
    "check_references": {0: "통과", 1: "발견"},
    "check_facts": {0: "출력 판정"},
    "check_duplication": {0: "통과", 1: "발견"},
    "check_rename_drift": {0: "통과", 1: "발견", 2: "해당 없음"},
}


def verdict(name: str, code: int) -> str:
    return VERDICTS[name].get(code, "실행 실패")


def commands(args: argparse.Namespace) -> list[tuple[str, list[str]]]:
    scope = ["--scope", args.scope] if args.scope else []
    root = str(Path(args.root))
    drift = [root, *([args.base] if args.base else []), *scope]
    return [
        ("collect_targets", [str(HERE / "collect_targets.py"), root, *scope]),
        ("check_references", [str(HERE / "check_references.py"), root, *scope]),
        ("check_facts", [str(HERE / "check_facts.py"), root, *scope]),
        ("check_duplication", [str(HERE / "check_duplication.py"), root, str(args.min_run), *scope]),
        ("check_rename_drift", [str(HERE / "check_rename_drift.py"), *drift]),
    ]


def run(commands: list[tuple[str, list[str]]]) -> list[tuple[str, int, str, str]]:
    results = []
    for name, argv in commands:
        done = subprocess.run([sys.executable, *argv], capture_output=True, text=True)
        results.append((name, done.returncode, done.stdout, done.stderr))
    return results


def render(results: list[tuple[str, int, str, str]]) -> str:
    lines = ["| 검사 | 종료 코드 | 판정 | 출력 줄 수 |", "| --- | --- | --- | --- |"]
    for name, code, out, _ in results:
        lines.append(f"| {name} | {code} | {verdict(name, code)} | {len(out.splitlines())} |")
    for name, code, out, err in results:
        lines += ["", f"### {name} (종료 코드 {code})", ""]
        lines.append(out.rstrip() or "(표준 출력 없음)")
        if err.strip():
            lines += ["", "표준 오류:", err.rstrip()]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root")
    parser.add_argument("--scope")
    parser.add_argument("--base")
    parser.add_argument("--min-run", type=int, default=5)
    args = parser.parse_args(argv)

    results = run(commands(args))
    print(render(results))

    verdicts = [verdict(name, code) for name, code, _, _ in results]
    if "실행 실패" in verdicts:
        return 2
    return 1 if "발견" in verdicts else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
