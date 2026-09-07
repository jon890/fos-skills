#!/usr/bin/env python3
"""작업 트리를 대상 PR 의 head 브랜치로 맞춘다.

사용법:
    checkout_pr.py <PR번호>

종료 코드:
    0  현재 브랜치가 PR 의 head 브랜치다
    1  작업 트리가 dirty 하다. 다른 작업 중일 수 있으므로 체크아웃하지 않는다
    2  사용법이 틀렸다
    3  PR 의 head 브랜치를 읽지 못했다

정렬하지 않으면 뒤 단계가 다른 브랜치의 파일을 고친다.
conflict 여부와 무관하게 항상 수행한다.

진입 시점의 현재 브랜치가 base 브랜치인 경우가 정상이다.
구현 스킬이 워크트리를 정리하면 거기로 돌아오기 때문이다 (실측).
"""

import subprocess
import sys


def git(*args, check=False):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=check)


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    num = argv[1]

    dirty = git("status", "--porcelain").stdout
    if dirty.strip():
        print("작업 트리가 dirty 하다. 사용자에게 확인받는다 (stash·커밋·중단).", file=sys.stderr)
        print(git("status", "--short").stdout, end="", file=sys.stderr)
        return 1

    done = subprocess.run(
        ["gh", "pr", "view", num, "--json", "headRefName", "--jq", ".headRefName"],
        capture_output=True, text=True)
    head_ref = done.stdout.strip()
    if done.returncode != 0 or not head_ref:
        print(f"PR #{num} 의 head 브랜치를 읽지 못했다", file=sys.stderr)
        if done.stderr.strip():
            print(done.stderr.strip(), file=sys.stderr)
        return 3

    current = git("branch", "--show-current").stdout.strip()
    if current != head_ref:
        out = subprocess.run(["gh", "pr", "checkout", num], capture_output=True, text=True)
        if out.returncode != 0:
            print(out.stderr.strip(), file=sys.stderr)
            return 3
        current = git("branch", "--show-current").stdout.strip()

    print(current)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
