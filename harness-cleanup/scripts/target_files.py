#!/usr/bin/env python3
"""하네스 감사 대상 파일 선택을 한곳에서 관리한다."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable


SKIP_PARTS = {
    ".git",
    ".omx",
    ".venv",
    "node_modules",
    "applications",
    "cache",
    "data",
    "logs",
    "private",
    "reports",
    "sources",
    "tasks",
    "worktrees",
}


def _is_skipped(path: Path, root: Path) -> bool:
    return any(part in SKIP_PARTS for part in path.relative_to(root).parts)


def _inside(path: Path, *parts: str) -> bool:
    values = path.parts
    width = len(parts)
    return any(values[index : index + width] == parts for index in range(len(values) - width + 1))


def is_target(path: Path, root: Path, include_readme: bool = False) -> bool:
    if _is_skipped(path, root):
        return False
    if path.name in {"AGENTS.md", "CLAUDE.md"}:
        return True
    if include_readme and path.name == "README.md" and path.parent == root:
        return True
    if path.name.endswith("-overlay.md") and ".claude" in path.parts:
        return True
    if path.name == "SKILL.md":
        return True
    if path.suffix == ".toml" and _inside(path, ".codex", "agents"):
        return True
    if path.suffix != ".md":
        return False
    for prefix in (
        (".claude", "agents"),
        (".claude", "rules"),
        (".agents", "roles"),
        (".claude", "skills", "_shared"),
    ):
        if _inside(path, *prefix):
            return True
    for parent in path.parents:
        if parent == root:
            break
        if (parent / "SKILL.md").is_file() and "references" in path.relative_to(parent).parts:
            return True
    return False


def resolve_scope(root: Path, scope: str | None) -> Path | None:
    """`--scope` 값을 저장소 안의 절대 경로로 바꾼다.

    범위 밖이거나 없는 경로면 `ValueError` 를 낸다.
    """
    if scope is None:
        return None
    path = Path(scope)
    if not path.is_absolute():
        path = root / path
    path = path.resolve()
    if not path.exists():
        raise ValueError(f"범위 경로가 없다: {scope}")
    if path != root and not path.is_relative_to(root):
        raise ValueError(f"범위가 저장소 밖을 가리킨다: {scope}")
    return path


def take_scope(argv: list[str]) -> tuple[list[str], str | None]:
    """argv 에서 `--scope` 를 떼어내고 나머지를 그대로 돌려준다.

    위치 인자의 자리를 바꾸지 않으므로, 두 번째 위치 인자를 쓰는 스크립트도 그대로 동작한다.
    """
    rest: list[str] = []
    scope: str | None = None
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--scope":
            if index + 1 >= len(argv):
                raise ValueError("--scope 에 경로가 없다")
            scope = argv[index + 1]
            index += 2
            continue
        if item.startswith("--scope="):
            scope = item.split("=", 1)[1]
            index += 1
            continue
        rest.append(item)
        index += 1
    return rest, scope


def iter_targets(
    root: Path, include_readme: bool = False, scope: Path | None = None
) -> Iterable[Path]:
    """감사 대상 파일을 낸다.

    `scope` 를 주면 그 디렉터리 아래나 그 파일 하나만 본다.
    대상 판정은 언제나 `root` 기준이므로, 범위를 좁혀도 같은 파일이 같은 판정을 받는다.
    """
    start = scope or root
    if start.is_file():
        if is_target(start, root, include_readme=include_readme):
            yield start
        return

    seen: set[Path] = set()
    for current, directories, filenames in os.walk(start, followlinks=False):
        directories[:] = sorted(
            directory for directory in directories if directory not in SKIP_PARTS
        )
        for filename in sorted(filenames):
            path = Path(current) / filename
            if not is_target(path, root, include_readme=include_readme):
                continue
            try:
                resolved = path.resolve(strict=True)
            except OSError:
                resolved = path.absolute()
            if not resolved.is_relative_to(root):
                yield path
                continue
            if resolved in seen:
                continue
            seen.add(resolved)
            yield path
