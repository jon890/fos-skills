#!/usr/bin/env python3
"""static_check.py 를 하위 프로세스로 돌리고 종료 코드와 판정을 표로 낸다.

파이프 뒤 `echo $?` 로 돌리면 종료 코드가 뒤 명령의 것이 되어 통과로 잘못 읽는다.
종료 코드의 뜻은 static_check.py 의 docstring 이 소유한다. 여기서는 그 뜻을 판정 낱말로만 옮긴다.

사용법 (검사 대상 저장소 루트에서 실행한다):
    run_static_check.py [ADR_DIR] [DOC_SCOPE]

인자는 static_check.py 에 그대로 넘긴다.

출력은 표가 먼저고, 이어 표준 출력과 표준 오류를 그대로 붙인다.
판정 낱말은 다음과 같다.
    통과        종료 코드 0 이고 WARN 줄이 없다
    통과 (경고 N줄)  종료 코드 0 이고 WARN 줄이 N 줄이다. 리포트의 Warning 후보로 올린다
    발견        종료 코드 1. 걸린 줄을 모두 발견으로 올리거나 유지 유형으로 분류해야 한다
    실행 실패   종료 코드 2 이거나 알 수 없는 코드. 통과가 아니다

종료 코드
    0  통과
    1  발견이 있다
    2  실행 실패
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

STATIC_CHECK = Path(__file__).resolve().parent / "static_check.py"


def verdict(code: int, out: str) -> str:
    if code == 1:
        return "발견"
    if code != 0:
        return "실행 실패"
    warns = sum(1 for line in out.splitlines() if ": WARN " in line)
    return f"통과 (경고 {warns}줄)" if warns else "통과"


def main(argv: list[str]) -> int:
    done = subprocess.run([sys.executable, str(STATIC_CHECK), *argv], capture_output=True, text=True)
    print("| 검사 | 종료 코드 | 판정 | 출력 줄 수 |")
    print("| --- | --- | --- | --- |")
    print(f"| static_check | {done.returncode} | {verdict(done.returncode, done.stdout)} | {len(done.stdout.splitlines())} |")
    print()
    print(done.stdout.rstrip() or "(표준 출력 없음)")
    if done.stderr.strip():
        print("\n표준 오류:")
        print(done.stderr.rstrip())
    return done.returncode if done.returncode in (0, 1) else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
