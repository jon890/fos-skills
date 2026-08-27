#!/usr/bin/env python3
"""하네스 감사 대상과 줄 수를 출력한다."""

from __future__ import annotations

import sys
from pathlib import Path

from target_files import iter_targets


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    if not root.is_dir():
        print(f"대상 저장소를 찾을 수 없다: {root}", file=sys.stderr)
        return 2

    count = 0
    lines = 0
    external = 0
    print("감사 대상")
    for path in iter_targets(root):
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
        print("대상 파일을 찾지 못했다. 저장소 루트를 확인한다.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
