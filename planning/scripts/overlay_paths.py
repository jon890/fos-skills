#!/usr/bin/env python3
"""작업 대상 하위 프로젝트를 정하고 레포 설정을 읽을 순서를 낸다.

판정 규칙은 references/monorepo.md 가 소유한다. 이 스크립트는 그 규칙을 그대로 실행한다.
planning, build-with-teams, docs-check, review-fix 가 함께 쓴다.

사용법:
    python3 scripts/overlay_paths.py --skill review-fix [--sub DIR] [--plan NAME] [PATH ...]
    gh pr diff 12 --name-only | python3 scripts/overlay_paths.py --skill review-fix -

PATH 는 변경 파일 경로다. 저장소 루트 기준이고, `-` 를 주면 표준 입력에서 한 줄에 하나씩 읽는다.
cwd 는 대상 저장소 안이어야 한다. cwd 가 하위 프로젝트 안이면 그것도 판정 근거로 쓴다.

출력은 JSON 이다.
    monorepo      하위 프로젝트 오버레이가 하나라도 있는가
    subprojects   오버레이를 가진 하위 프로젝트 목록
    targets       대상 하위 프로젝트. 둘 이상이면 변경이 걸친 것이다
    reason        무엇으로 정했나. user, plan, paths, cwd, single 중 하나
    search        대상마다 레포 설정을 읽을 순서. 없는 파일도 순서대로 낸다

종료 코드
    0  대상을 정했다. 단일 저장소도 여기다
    1  모노레포인데 대상을 정하지 못했다. 사용자에게 묻는다
    2  실행하지 못했다. 저장소가 아니거나 --sub 가 하위 프로젝트가 아니다
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# 오버레이의 「저장소 배치」 표에서 plan 접두사를 읽는다. 형식은 references/monorepo.md 가 정한다.
PREFIX_ROW = re.compile(r"^\|\s*plan 접두사\s*\|\s*`([^`]+)`\s*\|", re.M)
HARNESS = ("AGENTS.md", "CLAUDE.md")


def repo_root(cwd: Path) -> Path:
    proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ValueError(f"git 저장소가 아니다: {cwd}")
    return Path(proc.stdout.strip()).resolve()


def subprojects(root: Path) -> list[str]:
    """루트 바로 아래 디렉터리 중 `.claude/*-overlay.md` 를 가진 것."""
    return sorted(d.name for d in root.iterdir() if d.is_dir() and any((d / ".claude").glob("*-overlay.md")))


def plan_prefix(root: Path, sub: str) -> str | None:
    for overlay in sorted((root / sub / ".claude").glob("*-overlay.md")):
        m = PREFIX_ROW.search(overlay.read_text(encoding="utf-8"))
        if m:
            return m.group(1)
    return None


def owner(path: str, subs: list[str]) -> str | None:
    first = Path(path.removeprefix("./")).parts[:1]
    return first[0] if first and first[0] in subs else None


def search_order(root: Path, skill: str, sub: str | None) -> list[str]:
    """값 하나마다 이 순서로 찾는다. 앞의 파일에 있으면 그것을 쓴다."""
    order = []
    if sub:
        order.append(f"{sub}/.claude/{skill}-overlay.md")
    order.append(f".claude/{skill}-overlay.md")
    if sub:
        order += [f"{sub}/{name}" for name in HARNESS]
    order += list(HARNESS)
    return [rel for rel in order if (root / rel).is_file()] + [f"(없음) {rel}" for rel in order if not (root / rel).is_file()]


def resolve(root: Path, cwd: Path, subs: list[str], sub: str | None, plan: str | None, paths: list[str]):
    """references/monorepo.md 의 「작업 대상 하위 프로젝트를 정한다」 순서를 따른다."""
    if not subs:
        return [], "single"
    if sub:
        if sub not in subs:
            raise ValueError(f"하위 프로젝트 오버레이가 없다: {sub}. 있는 것: {', '.join(subs)}")
        return [sub], "user"
    if plan:
        hits = [s for s in subs if (p := plan_prefix(root, s)) and plan.startswith(f"{p}plan")]
        if len(hits) == 1:
            return hits, "plan"
    owners = {owner(p, subs) for p in paths}
    if paths and None not in owners:
        return sorted(owners), "paths"
    try:
        inside = cwd.resolve().relative_to(root).parts[:1]
    except ValueError:
        inside = ()
    if inside and inside[0] in subs:
        return [inside[0]], "cwd"
    return [], None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skill", required=True, help="오버레이 파일 이름에 쓰는 스킬 이름")
    ap.add_argument("--sub", help="사용자가 지정한 하위 프로젝트 디렉터리")
    ap.add_argument("--plan", help="plan 디렉터리 이름. 접두사로 하위 프로젝트를 정한다")
    ap.add_argument("paths", nargs="*", help="변경 파일 경로. - 면 표준 입력에서 읽는다")
    try:
        args = ap.parse_args(argv[1:])
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    paths = [p for p in args.paths if p != "-"]
    if "-" in args.paths:
        paths += [line.strip() for line in sys.stdin if line.strip()]
    cwd = Path.cwd()
    try:
        root = repo_root(cwd)
        subs = subprojects(root)
        targets, reason = resolve(root, cwd, subs, args.sub, args.plan, paths)
    except ValueError as exc:
        print(f"실행하지 못했다: {exc}", file=sys.stderr)
        return 2
    result = {
        "monorepo": bool(subs),
        "subprojects": subs,
        "targets": targets,
        "reason": reason,
        "search": {t: search_order(root, args.skill, t) for t in targets} if targets else {".": search_order(root, args.skill, None)},
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if subs and not targets else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
