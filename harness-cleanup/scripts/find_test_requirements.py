#!/usr/bin/env python3
"""지우거나 이름을 바꾸려는 문자열을 저장소의 시험이 요구하는지 찾는다.

판정표에 제거·축소·이름 변경을 적기 전에 그 제목이나 문장을 넘긴다.
찾으면 그 위치가 「시험이 요구」 근거다. 시험도 함께 고칠지를 승인 항목으로 낸다.
탐색 대상은 시험 폴더와 시험 파일 이름 규칙에 맞는 파일, CI 설정(`.github/workflows/*.yml`), `scripts/validate*` 다.
`.git`, `node_modules`, `.venv`, `worktrees`, `__pycache__` 만 건너뛰므로 `tests/data/` 같은 fixture 폴더도 읽는다.
인자가 Markdown 제목 표기(`#` 와 공백)로 시작하면 표기를 뗀 문자열로도 찾는다.
찾지 못해도 종료 코드는 0 이다. 출력의 「없음」 으로 판정한다.

Usage: python3 find_test_requirements.py <repo-root> <문자열> [<문자열> ...]
종료 코드: 0 (검사를 마침), 2 (인자 오류, 빈 문자열 포함)
"""
import os
import re
import sys
from pathlib import Path

TEST_SKIP = {".git", "node_modules", ".venv", "worktrees", "__pycache__"}
TEST_DIRS = {"tests", "test", "__tests__"}


def is_test_file(path: Path, root: Path) -> bool:
    parts = path.relative_to(root).parts
    return (
        (parts[:2] == (".github", "workflows") and path.suffix in {".yml", ".yaml"})
        or (parts[:1] == ("scripts",) and path.name.startswith("validate"))
        or any(part in TEST_DIRS for part in parts[:-1])
        or path.name.startswith("test_")
        or ".test." in path.name
        or path.stem.endswith("_test")
    )


def test_files(root: Path):
    for current, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = sorted(d for d in directories if d not in TEST_SKIP)
        for name in sorted(filenames):
            path = Path(current) / name
            if is_test_file(path, root):
                yield path


def variants(needle: str) -> list[str]:
    stripped = re.sub(r"^#+\s+", "", needle)
    return [needle] if stripped == needle or not stripped else [needle, stripped]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = Path(argv[0]).resolve()
    needles = argv[1:]
    if any(not needle for needle in needles):
        print("빈 문자열은 찾을 수 없다", file=sys.stderr)
        return 2
    if not root.is_dir():
        print(f"대상 저장소를 찾을 수 없다: {root}", file=sys.stderr)
        return 2

    files = list(test_files(root))
    print(f"시험 파일 {len(files)}개에서 {len(needles)}개 문자열을 찾는다")
    for needle in needles:
        forms = variants(needle)
        hits = []
        for path in files:
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            hits += [(path.relative_to(root), i, line.strip()[:80]) for i, line in enumerate(lines, 1) if any(v in line for v in forms)]
        print(f"\n\"{needle}\"")
        if hits:
            for rel, i, text in hits:
                print(f"  시험이 요구: {rel}:{i}  {text}")
        else:
            print("  없음")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
