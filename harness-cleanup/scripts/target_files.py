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


def iter_targets(root: Path, include_readme: bool = False) -> Iterable[Path]:
    seen: set[Path] = set()
    for current, directories, filenames in os.walk(root, followlinks=False):
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
