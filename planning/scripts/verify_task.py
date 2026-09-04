#!/usr/bin/env python3
"""task 생성 직후 자동 검증.

기계적으로 판정되는 task 위생 일곱 가지를 검출한다.
  index.json 스키마 / 범위 불명확 / cwd 누락 / 사람 의존 검증
  필수 섹션 누락 / 완료 마킹 누락 / BSD sed 미지원

사용법:
    python3 scripts/verify_task.py plan{N}-{slug}

cwd 는 tasks/ 를 가진 타깃 레포 root 여야 한다.
경로는 이 스킬 번들 기준 상대경로다. 하네스가 알려주는 base 디렉터리에 붙여 쓴다.

종료 코드
    0  위반 없음
    1  위반 발견 (내용은 stdout 으로 출력)
    2  검사를 돌리지 못함 (인자 오류, 디렉터리 없음, JSON 파싱 실패)
"""

import json
import re
import sys
from pathlib import Path

# build-with-teams 의 executor_routing_gate.py 와 같은 목록을 본다.
# 두 검사가 다른 기준을 쓰면 planning 통과 후 구현 착수 직전에 막힌다 (실제 발생).
# 목록 단일 소스는 그 스크립트의 REQUIRED_SECTIONS 다.
REQUIRED_SECTIONS = [
    "## 목표",
    "**범위 외**",
    "## 작업 항목",
    "## Critical Files",
    "## 검증",
]

PROFILES = {"fast", "standard", "deep"}
MODELS = {"haiku", "sonnet", "opus"}

VAGUE_SCOPE = re.compile(r"전체\s*(수정|변경|적용|교체|리팩토링|삭제)")
HUMAN_CHECK = re.compile(r"수동 검토|눈으로 확인|직접 확인|육안")
BSD_SED = re.compile(r"sed\s.*\\b")


def check_index(path: Path, out: list) -> None:
    """execution_profile 과 model 은 하나만 있어야 한다.

    신규 필드는 provider 중립인 execution_profile 이고, model 은 읽기 호환용이다.
    둘 다 있으면 어느 쪽이 이기는지 정해져 있지 않아 실행 등급이 갈린다.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        out.append(f"{path} — 읽지 못했다: {e}")
        return

    for i, phase in enumerate(data.get("phases", [])):
        has_profile = phase.get("execution_profile") in PROFILES
        has_model = phase.get("model") in MODELS
        both = "execution_profile" in phase and "model" in phase
        if both or not (has_profile or has_model):
            out.append(f"{path} — phases[{i}] execution_profile/model schema 오류")


def check_bash_cwd(path: Path, text: str, out: list) -> None:
    """Bash 블록에 실행 위치가 없으면 worktree 대신 main repo 를 고칠 수 있다."""
    in_block = False
    start = 0
    body: list = []
    for n, line in enumerate(text.splitlines(), 1):
        if not in_block and line.startswith("```bash"):
            in_block, start, body = True, n, []
        elif in_block and line.startswith("```"):
            if not any("# cwd:" in b for b in body):
                out.append(f"{path}:{start} — Bash 블록 cwd 주석 누락")
            in_block = False
        elif in_block:
            body.append(line)


def iter_prose(text: str):
    """코드 블록 밖의 산문만 낸다. 「의도 메모」 절과 첫 절 이전의 머리말은 뺀다.

    의도 메모를 빼는 이유는 설계 근거를 적는 절이라 「직접 확인」 같은 표현이
    자연스럽게 나오기 때문이다. 그것까지 잡으면 글을 규칙에 맞춰 비틀게 되고,
    정작 검증 기준의 결함은 그대로 남는다.

    뺄 절을 하나만 지정한다. 볼 절을 열거하면 작업 항목처럼 자동 실행이 실제로
    끊기는 자리를 놓친다. 사람 의존 지시는 검증 절보다 작업 항목에 더 자주 들어간다.
    """
    in_code = False
    skip = True  # 첫 "## " 이전은 phase 를 소개하는 문장이라 뺀다
    for n, line in enumerate(text.splitlines(), 1):
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if line.startswith("## "):
            skip = "의도 메모" in line
            continue
        if not skip:
            yield n, line


def main(argv: list) -> int:
    if len(argv) != 2:
        print("사용법: verify_task.py <plan 디렉터리명>   (예: plan053-foo)")
        return 2

    plan_dir = Path("tasks") / argv[1]
    if not plan_dir.is_dir():
        print(f"디렉터리 없음: {plan_dir}")
        return 2

    phases = sorted(plan_dir.glob("phase-*.md"))
    if not phases:
        print(f"phase 파일 없음: {plan_dir}")
        return 2

    out: list = []
    check_index(plan_dir / "index.json", out)

    for path in phases:
        text = path.read_text(encoding="utf-8")

        for n, line in enumerate(text.splitlines(), 1):
            if VAGUE_SCOPE.search(line):
                out.append(f"{path}:{n}:{line}")

        check_bash_cwd(path, text, out)

        for n, line in iter_prose(text):
            if HUMAN_CHECK.search(line):
                out.append(f"{path}:{n}: {line}")

        for marker in REQUIRED_SECTIONS:
            if marker not in text:
                out.append(f"{path} — 필수 섹션 누락: {marker}")

        in_code = False
        for n, line in enumerate(text.splitlines(), 1):
            if line.startswith("```"):
                in_code = not in_code
                continue
            if not in_code and BSD_SED.search(line):
                out.append(f"{path}:{n}: {line}")

    # 완료 마킹 누락: plan 이 끝나도 상태가 안 바뀌어 재실행 사고로 이어진다
    last = phases[-1]
    if not re.search(r"index\.json.*completed|status.*completed", last.read_text(encoding="utf-8")):
        out.append(f"{last} — index.json completed 마킹 지시 누락")

    for line in out:
        print(line)
    return 1 if out else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
