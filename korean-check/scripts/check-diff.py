#!/usr/bin/env python3
"""git diff 로 이번에 더한 줄의 발견만 판정하고, 기존 줄의 발견은 따로 알린다.

여러 사람이 함께 고치는 큰 문서에서 파일 전체를 검사하면
내가 손대지 않은 기존 문장의 금지어까지 실패로 막혀, 고칠 수 없는 것을 고치라는 결과가 된다.
이 모드는 두 검사기를 파일 전체에 그대로 돌린 뒤 발견을 줄 번호로 나눈다.
줄만 잘라 검사하지 않는 이유는 코드 블록과 frontmatter 안인지를 파일 전체로만 판정할 수 있어서다.

사용법 (cwd: 검사할 저장소 안):
    check-diff.py [--base <ref>] [<파일.md>...]

    --base   비교 기준. 기본값은 HEAD 라 커밋하지 않은 변경만 본다.
             브랜치 전체를 보려면 origin/main 처럼 기준 브랜치를 준다.
             기준과 HEAD 의 merge-base 부터 작업 트리까지를 비교하므로,
             기준 브랜치에 나중에 들어온 남의 변경은 이번 변경에 섞이지 않는다.
    파일     생략하면 그 범위에서 바뀐 .md 와 추적하지 않는 새 .md 를 모두 본다.
             추적하지 않는 파일은 모든 줄을 이번 변경으로 본다.

출력은 「이번 변경」 과 「기존 줄」 두 묶음이다. 기존 줄의 발견은 종료 코드에 넣지 않는다.

종료 코드:
    0  이번 변경에 금지어가 없다. 경고와 기존 줄의 발견이 있어도 0 이다
    1  이번 변경의 줄에 매핑 표 금지어가 있다
    2  돌지 못함. git 저장소가 아니거나 기준을 찾지 못했거나, 검사기가 2 로 끝났다

한계: 가독성 검사기의 TILDE 경고는 단락의 첫 줄 번호로 나온다.
단락 중간에 더한 줄 때문에 걸려도 첫 줄이 기존 줄이면 「기존 줄」 로 분류된다.
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STYLE = HERE / "korean-style-check.py"
READABILITY = HERE / "check-readability.py"

HUNK = re.compile(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@")
# 두 검사기의 발견 줄은 「경로:줄번호:」 또는 「경로:줄번호  경고」 로 시작한다.
FINDING = re.compile(r"^(?P<path>.+?):(?P<line>\d+)[: ]")
BANNED = "금지어"


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True)


def fail(message):
    print(f"check-diff: {message}", file=sys.stderr)
    return 2


def added_lines(merge_base, path):
    """작업 트리의 그 파일에서 merge-base 이후 더하거나 바꾼 줄 번호 집합."""
    done = git("diff", "-U0", "--no-color", "--no-ext-diff", merge_base, "--", path)
    if done.returncode != 0:
        return None
    lines = set()
    for row in done.stdout.splitlines():
        m = HUNK.match(row)
        if m:
            start, count = int(m.group(1)), int(m.group(2) or 1)
            lines.update(range(start, start + count))
    return lines


def is_untracked(path):
    return git("ls-files", "--error-unmatch", "--", path).returncode != 0


def changed_markdown(root, merge_base):
    """범위 안에서 바뀐 .md 와 추적하지 않는 새 .md 를 cwd 기준 경로로 낸다."""
    # diff --name-only 는 저장소 루트 기준 경로를 내고, ls-files 는 cwd 밑만 본다.
    # 둘 다 루트에서 불러 같은 기준으로 맞춘다.
    tracked = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=AMR", merge_base, "--", "*.md"],
        capture_output=True, text=True, cwd=root,
    )
    names = tracked.stdout.splitlines()
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "--", "*.md"],
        capture_output=True, text=True, cwd=root,
    )
    names += untracked.stdout.splitlines()
    return sorted({os.path.relpath(Path(root) / n) for n in names})


def run_checker(command, paths):
    done = subprocess.run(command + paths, capture_output=True, text=True)
    return done.returncode, done.stdout.splitlines(), done.stderr


def main():
    parser = argparse.ArgumentParser(add_help=True, description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="HEAD")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args()

    top = git("rev-parse", "--show-toplevel")
    if top.returncode != 0:
        return fail("git 저장소 안에서 돌린다")
    root = top.stdout.strip()

    mb = git("merge-base", args.base, "HEAD")
    if mb.returncode != 0:
        return fail(f"기준을 찾지 못했다: {args.base}")
    merge_base = mb.stdout.strip()

    paths = args.files or changed_markdown(root, merge_base)
    for p in paths:
        if not os.path.isfile(p):
            return fail(f"대상이 없다: {p}")
        if not p.endswith(".md"):
            return fail(f"확장자가 .md 가 아니다: {p}")
    if not paths:
        print(f"통과: {args.base} 이후 바뀐 .md 가 없다")
        return 0

    added = {}
    for p in paths:
        if is_untracked(p):
            added[p] = None  # None 은 모든 줄이 이번 변경이라는 뜻이다
            continue
        lines = added_lines(merge_base, p)
        if lines is None:
            return fail(f"git diff 가 실패했다: {p}")
        added[p] = lines

    new, old = [], []
    status = 0
    for command in ([sys.executable, str(STYLE)], [sys.executable, str(READABILITY)]):
        rc, out, err = run_checker(command, paths)
        if rc == 2:
            sys.stderr.write(err)
            return 2
        for row in out:
            m = FINDING.match(row)
            if not m or m.group("path") not in added:
                continue
            scope = added[m.group("path")]
            if scope is None or int(m.group("line")) in scope:
                new.append(row)
                if BANNED in row:
                    status = 1
            else:
                old.append(row)

    print(f"## 이번 변경 ({args.base} 이후 더한 줄)")
    print("\n".join(new) if new else "발견 없음")
    print()
    print("## 기존 줄 (참고. 종료 코드에 넣지 않는다)")
    print("\n".join(old) if old else "발견 없음")
    return status


if __name__ == "__main__":
    sys.exit(main())
