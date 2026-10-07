#!/usr/bin/env python3
"""하네스 감사 대상과 줄 수를 출력한다.

Usage: python3 collect_targets.py [repo-root] [--scope <저장소 안 경로>]
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from target_files import count_scripts, iter_targets, resolve_scope, take_scope


def stray_skill_dirs(root: Path, scope: Path | None) -> list[Path]:
    """스킬 루트 바로 밑에서 SKILL.md 도 없고 git 추적 파일도 없는 디렉터리를 찾는다.

    `__pycache__` 와 `.omc` 만 남은 옛 스킬 폴더가 여기 해당한다. git 저장소가 아니거나 git 이 없으면 비운다. `--scope` 가 스킬 하나를 가리키면 그 스킬만 본다.
    """
    roots = [root / "skills", *sorted(root.glob("plugins/*/skills"))]
    found = []
    for skill_root in roots:
        if not skill_root.is_dir():
            continue
        if scope is not None and not (scope.is_relative_to(skill_root) or skill_root.is_relative_to(scope)):
            continue
        for directory in sorted(d for d in skill_root.iterdir() if d.is_dir() and not d.is_symlink()):
            if scope is not None and scope.is_relative_to(skill_root) and scope != skill_root:
                if not (scope.is_relative_to(directory) or directory.is_relative_to(scope)):
                    continue
            if (directory / "SKILL.md").exists():
                continue
            try:
                done = subprocess.run(
                    ["git", "-C", str(root), "ls-files", "--", str(directory.relative_to(root))],
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError:
                return []
            if done.returncode == 0 and not done.stdout.strip():
                found.append(directory)
    return found


def main() -> int:
    try:
        argv, scope_arg = take_scope(sys.argv[1:])
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    root = Path(argv[0] if argv else ".").resolve()
    if not root.is_dir():
        print(f"대상 저장소를 찾을 수 없다: {root}", file=sys.stderr)
        return 2
    try:
        scope = resolve_scope(root, scope_arg)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    for directory in stray_skill_dirs(root, scope):
        print(
            f"경고: git 이 추적하지 않는 스킬 폴더가 있다 (SKILL.md 없음): {directory.relative_to(root)}",
            file=sys.stderr,
        )

    count = 0
    lines = 0
    external = 0
    print("감사 대상" if scope is None else f"감사 대상 (범위: {scope.relative_to(root)})")
    for path in iter_targets(root, scope=scope):
        relative = path.relative_to(root)
        resolved = path.resolve()
        if not resolved.is_relative_to(root):
            print(f"  {relative}  (외부 symlink, 대상 아님)")
            external += 1
            continue
        size = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
        print(f"  {str(relative):<60} {size:>5}")
        count += 1
        lines += size

    print(f"\n합계: {count}개 파일, {lines}줄")
    if external:
        print(f"외부 symlink: {external}개")
    if count == 0:
        scripts = count_scripts(scope) if scope is not None else 0
        if scripts:
            print(f"Markdown 대상은 없고 스크립트 {scripts}개가 있다.", file=sys.stderr)
            print(
                "저장소 루트는 맞다. references/script-audit.md 의 절차로 스크립트를 감사한다.",
                file=sys.stderr,
            )
        else:
            print("대상 파일을 찾지 못했다. 저장소 루트를 확인한다.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
