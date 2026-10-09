#!/usr/bin/env python3
"""지우거나 이름을 바꾸려는 문자열을 저장소의 시험이 요구하는지 찾는다.

판정표에 제거·축소·이름 변경을 적기 전에 그 제목이나 문장을 넘긴다.
찾으면 그 위치가 「시험이 요구」 근거다. 시험도 함께 고칠지를 승인 항목으로 낸다.
탐색 대상은 시험 폴더와 시험 파일 이름 규칙에 맞는 파일, CI 설정(`.github/workflows/*.yml`), `scripts/validate*` 다.
`tests/data/` 같은 fixture 폴더도 읽는다.

후보 파일은 git 저장소면 `git ls-files -co --exclude-standard` 로 정한다. git 이 무시하는 빌드 결과물은 빠진다.
git 저장소가 아니면 디렉터리를 순회하고 `.git`, `node_modules`, `.venv`, `worktrees`, `__pycache__` 와
빌드 결과물 폴더(`build`, `dist`, `out`, `target`, `coverage`, `.next`)를 건너뛴다.

「시험이 요구」 로 내는 줄은 셋이다. 인자가 Markdown 제목 표기(`#` 와 공백)로 시작하면 표기를 뗀 문자열을 `S` 라 한다.
  1. 인자를 그대로 담은 줄. 예: `## 확인`
  2. `S` 가 따옴표(`"`, `'`, `` ` ``)나 「」, 『』 로 감싸인 줄
  3. 줄 전체를 trim 한 값이 `S` 와 같은 줄
제목 표기가 없는 인자는 `S` 가 인자와 같으므로 1번이 부분 문자열 일치다.
`S` 가 줄 어딘가에 들어 있을 뿐인 나머지는 `낱말만 겹침 N건` 으로 개수만 낸다. `--loose` 를 주면 그 목록을 펼친다.
`확인` 처럼 흔한 낱말은 이 줄이 수백 건이 되어, 펼치면 진짜 근거가 묻힌다.
찾지 못해도 종료 코드는 0 이다. 출력의 「없음」 으로 판정한다.

Usage: python3 find_test_requirements.py <repo-root> <문자열> [<문자열> ...] [--loose]
종료 코드: 0 (검사를 마침), 2 (인자 오류, 빈 문자열 포함)
"""
import os
import re
import subprocess
import sys
from pathlib import Path

TEST_SKIP = {".git", "node_modules", ".venv", "worktrees", "__pycache__"}
BUILD_SKIP = {"build", "dist", "out", "target", "coverage", ".next"}
TEST_DIRS = {"tests", "test", "__tests__"}
WRAPPERS = ('"', "'", "`", "「」", "『』")


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


def git_candidates(root: Path):
    """git 저장소면 추적 파일과 무시되지 않은 새 파일. 저장소가 아니면 None."""
    done = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=root, capture_output=True)
    if done.returncode != 0:
        return None
    names = done.stdout.decode("utf-8", errors="replace").split("\0")
    return [root / name for name in sorted(set(names)) if name]


def walk_candidates(root: Path):
    for current, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = sorted(d for d in directories if d not in TEST_SKIP | BUILD_SKIP)
        for name in sorted(filenames):
            yield Path(current) / name


def test_files(root: Path):
    candidates = git_candidates(root)
    if candidates is None:
        candidates = walk_candidates(root)
    for path in candidates:
        parts = path.relative_to(root).parts
        if any(part in TEST_SKIP for part in parts[:-1]) or not path.is_file():
            continue
        if is_test_file(path, root):
            yield path


def stripped_form(needle: str) -> str:
    return re.sub(r"^#+\s+", "", needle)


def requires(needle: str, line: str) -> bool:
    """줄이 「시험이 요구」 에 드는가. 인자 그대로, 감싼 `S`, 줄 전체가 `S`."""
    if needle in line:
        return True
    bare = stripped_form(needle)
    if not bare or bare == needle:
        return False
    if line.strip() == bare:
        return True
    return any(bare in line and f"{w[0]}{bare}{w[-1]}" in line for w in WRAPPERS)


def loosely_overlaps(needle: str, line: str) -> bool:
    bare = stripped_form(needle)
    return bool(bare) and bare in line


def main(argv: list[str]) -> int:
    loose = "--loose" in argv
    argv = [item for item in argv if item != "--loose"]
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

    contents = []
    for path in test_files(root):
        try:
            contents.append((path.relative_to(root), path.read_text(encoding="utf-8").splitlines()))
        except (OSError, UnicodeDecodeError):
            continue
    print(f"시험 파일 {len(contents)}개에서 {len(needles)}개 문자열을 찾는다")
    for needle in needles:
        hits, overlaps = [], []
        for rel, lines in contents:
            for i, line in enumerate(lines, 1):
                entry = (rel, i, line.strip()[:80])
                if requires(needle, line):
                    hits.append(entry)
                elif loosely_overlaps(needle, line):
                    overlaps.append(entry)
        print(f"\n\"{needle}\"")
        for rel, i, text in hits:
            print(f"  시험이 요구: {rel}:{i}  {text}")
        if not hits:
            print("  없음")
        if overlaps:
            if loose:
                for rel, i, text in overlaps:
                    print(f"  낱말만 겹침: {rel}:{i}  {text}")
            else:
                print(f"  낱말만 겹침 {len(overlaps)}건 (--loose 로 목록)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
