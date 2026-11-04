#!/usr/bin/env python3
"""레포 설정의 「문서 검사 명령」 을 spec·technical-design 단계 관문에서 돌린다.

저장소 문서 검사(ADR 링크 규칙 같은 것)가 구현 phase 커밋에서야 걸리지 않게, 스펙과 설계를 쓴 단계에서 함께 돌린다.
값의 이름과 형식은 references/monorepo.md 의 「스크립트가 직접 읽는 값」 이 소유한다.

사용법:
    python3 scripts/run_doc_checks.py --skill spec docs/features/run-cancel/spec.md
    python3 scripts/run_doc_checks.py --skill technical-design SPEC DESIGN

cwd 는 대상 저장소 안이어야 한다. 경로는 저장소 루트 기준이며, 어느 하위 프로젝트의 오버레이를 읽을지 정하는 데만 쓴다.
`--skill` 의 오버레이를 먼저 찾고, 없으면 spec 오버레이에서 찾는다. 값 칸의 인라인 코드 하나가 명령 하나다.
명령은 저장소 루트에서 bash 로 실행하고 출력은 그대로 보인다.

종료 코드
    0  모든 명령이 통과했다. 오버레이에 명령이 없어도 0 이다
    1  실패한 명령이 있다
    2  실행하지 못했다. 저장소 밖이다
"""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
import sys
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location("overlay_values", Path(__file__).with_name("overlay_values.py"))
overlay_values = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(overlay_values)

NAME = "문서 검사 명령"


def commands(root: Path, skill: str, paths) -> list:
    """(명령, 찾은 파일) 목록이다. 같은 명령은 한 번만 낸다."""
    skills = [skill] if skill == "spec" else [skill, "spec"]
    found, seen = [], set()
    for sub in overlay_values.targets(root, paths):
        value, source = overlay_values.lookup(root, skills, NAME, sub)
        if value is None:
            continue
        for command in overlay_values.codes(value):
            if command not in seen:
                seen.add(command)
                found.append((command, source))
    return found


def main(argv: list) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skill", required=True, choices=["spec", "technical-design"], help="부르는 단계의 스킬 이름")
    ap.add_argument("paths", nargs="*", help="이번 단계가 쓴 문서 경로. 저장소 루트 기준")
    try:
        args = ap.parse_args(argv[1:])
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    try:
        root = overlay_values.overlay_paths.repo_root(Path.cwd())
    except ValueError as exc:
        print(f"실행하지 못했다: {exc}", file=sys.stderr)
        return 2
    found = commands(root, args.skill, args.paths)
    if not found:
        print(f"「{NAME}」 이 레포 설정에 없다. 저장소 문서 검사를 건너뛴다")
        return 0
    failed = 0
    for command, source in found:
        print(f"실행: {command} (출처: {source})", flush=True)
        code = subprocess.run(["bash", "-c", command], cwd=root).returncode
        print(f"{'통과' if code == 0 else f'실패(종료 코드 {code})'}: {command}", flush=True)
        failed += code != 0
    print(f"문서 검사 {len(found)}개 중 실패 {failed}개")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
