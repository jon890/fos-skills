#!/usr/bin/env python3
"""PR 의 리뷰를 네 소스에서 모아 낸다.

사용법:
    collect_review.py <owner> <repo> <PR번호>

종료 코드:
    0  성공
    1  GitHub 호출 실패
    2  사용법 오류

워크플로 버전에 따라 리뷰가 담기는 위치가 다르다.
한 소스만 보면 봇의 구조화 리뷰를 놓친다.

리뷰 스레드를 함께 내는 이유는 「회신」 단계가 THREAD_ID 로 회신하기 때문이다.
REST 댓글의 `path` 와 `line` 을 스레드의 것과 대조해 어느 지적에 회신할지 정한다.

`diff_hunk`, `html_url`, `_links`, `reactions` 는 토큰만 차지하므로 빼고 `body` 는 잘라 낸다.
호스트는 `<owner> <repo>` 로 정한다. 현재 디렉터리를 보지 않으므로 어디서 돌려도 된다.
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


def main(argv):
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    owner, repo, num = argv[1], argv[2], argv[3]

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

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
