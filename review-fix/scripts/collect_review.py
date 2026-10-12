#!/usr/bin/env python3
"""PR 의 리뷰를 네 소스에서 모아 낸다.

사용법:
    collect_review.py <owner> <repo> <PR번호> [--carried-from <PR번호> ...] [--carried-marker 문구]

    --carried-from    이전 PR 에서 「다음 PR 에서 반영」 으로 회신한 스레드를 다섯째 소스로 더한다.
                      PR 번호를 여럿 줄 수 있고, resolve 된 스레드도 낸다
                      숫자는 모두 PR 번호로 읽으므로 `<owner> <repo> <PR번호>` 를 먼저 준다
    --carried-marker  회신에서 찾을 문구. 기본은 「다음 PR」

종료 코드:
    0  성공
    1  GitHub 호출 실패
    2  사용법 오류

워크플로 버전에 따라 리뷰가 담기는 위치가 다르다.
한 소스만 보면 봇의 구조화 리뷰를 놓친다.

리뷰 스레드를 함께 내는 이유는 「회신」 단계가 THREAD_ID 로 회신하기 때문이다.
REST 댓글의 `path` 와 `line` 을 스레드의 것과 대조해 어느 지적에 회신할지 정한다.

`diff_hunk`, `html_url`, `_links`, `reactions` 는 토큰만 차지하므로 빼고 `body` 는 잘라 낸다.
호스트는 `<owner> <repo>` 로 정한다. 어느 디렉터리에서 돌리든 같은 호스트가 나온다.
로그인된 호스트 어디에도 그 저장소가 없으면 현재 디렉터리의 origin 으로 되돌아가고,
저장소 밖이면 그 단계에서 실패한다. `gh_host.py` 가 그때 stderr 로 알린다.
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import gh_host  # noqa: E402

REVIEW_JQ = "[.[] | {id, body: .body[0:1000], state, author: .user.login}]"
COMMENT_JQ = ("[.[] | {id, path, line, body: .body[0:500], "
              "author: .user.login, in_reply_to_id}]")


def run(header, argv, env):
    """머리말을 내고 명령을 돌린다.

    머리말을 먼저 flush 한다. 하위 프로세스는 파일 서술자로 직접 쓰므로,
    이쪽 버퍼를 비우지 않으면 머리말이 그 출력 뒤로 밀린다 (실측).
    """
    print(header, flush=True)
    merged = dict(os.environ)
    merged.update(env)
    return subprocess.run(argv, text=True, env=merged).returncode


def parse_args(argv):
    """(owner, repo, num, carried PR 목록, marker) 를 낸다. 틀리면 None."""
    positional, carried, marker = [], [], None
    seen_carried = False
    index = 1
    while index < len(argv):
        item = argv[index]
        if item == "--carried-from":
            seen_carried = True
            index += 1
            while index < len(argv) and argv[index].isdigit():
                carried.append(argv[index])
                index += 1
        elif item == "--carried-marker":
            if index + 1 >= len(argv):
                return None
            marker = argv[index + 1]
            index += 2
        else:
            positional.append(item)
            index += 1
    if len(positional) != 3 or (seen_carried and not carried):
        return None
    return (*positional, carried, marker)


def main(argv):
    parsed = parse_args(argv)
    if parsed is None:
        print(__doc__, file=sys.stderr)
        return 2
    owner, repo, num, carried, marker = parsed

    try:
        env = {"GH_HOST": gh_host.resolve(owner, repo)}
    except RuntimeError as e:
        print(e, file=sys.stderr)
        return 2

    failed = 0

    failed |= run("## 1. GitHub Review (요약 리뷰가 담기는 곳)",
                  ["gh", "api", f"repos/{owner}/{repo}/pulls/{num}/reviews",
                   "--jq", REVIEW_JQ], env)
    failed |= run("## 2. 인라인 코드 리뷰 댓글 (diff 라인에 달림)",
                  ["gh", "api", f"repos/{owner}/{repo}/pulls/{num}/comments",
                   "--jq", COMMENT_JQ], env)
    failed |= run("## 3. 일반 PR(issue) 댓글",
                  ["gh", "pr", "view", num, "--repo", f"{owner}/{repo}", "--comments"], env)
    failed |= run("## 4. 미해결 리뷰 스레드 (「회신」 단계의 대상)",
                  [sys.executable, str(HERE / "review_threads.py"),
                   "list", owner, repo, num], env)
    for prior in carried:
        extra = ["--marker", marker] if marker else []
        failed |= run(f"## 5. 이전 PR #{prior} 에서 「{marker or '다음 PR'}」 로 회신한 스레드",
                      [sys.executable, str(HERE / "review_threads.py"),
                       "carried", owner, repo, prior, *extra], env)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
