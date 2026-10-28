#!/usr/bin/env python3
"""PR 의 리뷰 스레드를 조회하고, 스레드에 회신하고, resolve 한다.

사용법:
    review_threads.py list     <owner> <repo> <PR번호>   # 미해결 스레드만
    review_threads.py list-all <owner> <repo> <PR번호>   # resolve 된 것까지
    review_threads.py list --count <owner> <repo> <PR번호>   # 미해결 스레드 수만 정수로 낸다
    review_threads.py reply    <THREAD_ID> <본문파일>
    review_threads.py reply-batch <map.tsv>   # 줄마다 `THREAD_ID<탭>본문파일`. 빈 줄과 # 줄은 건너뛴다
    review_threads.py carried  <owner> <repo> <PR번호> [--marker 문구]   # 회신에 문구가 든 스레드
    review_threads.py resolve  <THREAD_ID> [<THREAD_ID> ...]
    review_threads.py resolve  -              # 표준 입력에서 공백이나 줄로 나뉜 THREAD_ID 를 읽는다

    --repo <owner>/<repo>    reply 와 resolve 에서 호스트를 정한다. 어느 자리에 와도 된다

종료 코드:
    0  성공
    1  GitHub 호출 실패. `reply-batch` 는 하나라도 실패하면 1 이다. `--count` 는 스레드가 한 번에 조회하는 수를 넘어도 1 이다
    2  사용법 오류

머지 전 확인은 `list --count` 로 한다. 출력에서 `"resolved":false` 를 grep 해 세지 않는다.
한 줄 JSON 은 여백이 없어 `"resolved": false` 패턴이 늘 0 으로 나온다 (실측).
`--count` 의 0 은 미해결 스레드가 없다는 뜻이다. 조회가 잘렸으면 0 으로 내지 않고 실패한다.

봇의 발견사항은 인라인 댓글이 아니라 리뷰 스레드로 달리는 경우가 많다.
REST 의 `pulls/<N>/comments` 로는 스레드 ID 를 얻을 수 없어 조회와 회신 모두 GraphQL 로 한다 (실측).
`path` 와 `line` 을 함께 내므로 REST 댓글과 대조해 어느 지적인지 가릴 수 있다.
push 뒤 outdated 가 된 스레드는 GitHub 가 `line` 을 비우므로 그때는 `originalLine` 을 `line` 에 담아 낸다.

회신 본문은 파일로 받는다. 셸에서 본문을 직접 넘기면
백틱과 달러가 명령 치환으로 사라진다 (실측).

여러 ID 를 셸 변수 하나에 담아 `resolve $IDS` 로 넘기지 않는다.
bash 는 낱말로 나누지만 zsh 는 나누지 않아 ID 전체가 인자 하나로 가고 GraphQL 이 실패한다 (실측).
`resolve -` 로 표준 입력에서 읽거나, 인자 하나에 공백이 섞여 와도 이 스크립트가 나눈다.

resolve 하지 않으면 "A conversation must be resolved" 보호 규칙이 머지를 막는다.
아직 반영하지 않은 스레드는 resolve 하지 않는다. resolve 는 "처리했다"는 표시다.

호스트는 `gh_host.py` 가 정한다.
`list` 와 `list-all` 은 받은 `<owner> <repo>` 를 그대로 넘기므로 현재 디렉터리를 보지 않는다.
`reply` 와 `resolve` 는 THREAD_ID 만 받아 저장소를 알 수 없으므로 `--repo` 로 준다.
주지 않으면 현재 디렉터리의 origin 을 보므로, 대상 저장소 안에서 돌려야 한다.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gh_host  # noqa: E402

HEAD_LEN = 120
PAGE_SIZE = 100

LIST_QUERY = """
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$num) {
          reviewThreads(first:%d) {
            totalCount
            nodes { id isResolved isOutdated path line originalLine
                    comments(first:1){ nodes{ author{login} body } } }
          }
        }
      }
    }""" % PAGE_SIZE

REPLY_MUTATION = """
      mutation($threadId:ID!, $body:String!) {
        addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId, body:$body}) {
          comment { url }
        }
      }"""

CARRIED_QUERY = """
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$num) {
          reviewThreads(first:%d) {
            totalCount
            nodes { id isResolved path line
                    comments(first:50){ nodes{ author{login} body url } } }
          }
        }
      }
    }""" % PAGE_SIZE

DEFAULT_MARKER = "다음 PR"

RESOLVE_MUTATION = """
        mutation($threadId:ID!) {
          resolveReviewThread(input:{threadId:$threadId}) {
            thread { id isResolved }
          }
        }"""


def gh(*args, env=None):
    """gh 를 돌려 (종료 코드, stdout, stderr) 를 낸다."""
    merged = dict(os.environ)
    if env:
        merged.update(env)
    done = subprocess.run(["gh", *args], capture_output=True, text=True, env=merged)
    return done.returncode, done.stdout, done.stderr


def usage(code=2):
    print(__doc__, file=sys.stderr)
    return code


def emit(value):
    """gh --jq 와 같은 형식으로 낸다.

    문자열은 따옴표 없이, 객체는 여백 없는 JSON 이다.
    키를 정렬하는 이유는 `gh --jq` 가 그렇게 내기 때문이다 (실측).
    옮기기 전 출력과 글자 단위로 같게 두려고 맞춘다.
    """
    if isinstance(value, str):
        print(value)
    else:
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True))


def thread_line(node):
    """push 뒤 outdated 가 된 스레드는 `line` 이 비므로 `originalLine` 으로 대신한다."""
    line = node.get("line")
    return line if line is not None else node.get("originalLine")


def cmd_list(host, owner, repo, num, only_unresolved, count_only=False):
    code, out, err = gh("api", "graphql", "-f", f"query={LIST_QUERY}",
                        "-f", f"owner={owner}", "-f", f"repo={repo}", "-F", f"num={num}",
                        env={"GH_HOST": host})
    if code != 0:
        print(err.strip() or out.strip(), file=sys.stderr)
        return 1

    threads = json.loads(out)["data"]["repository"]["pullRequest"]["reviewThreads"]
    total = threads["totalCount"]
    if count_only:
        if total > PAGE_SIZE:
            # 잘린 조회의 수는 머지 판단에 쓸 수 없다. 0 으로 보일 수도 있어 실패로 낸다.
            print(f"스레드 {total}건 중 {PAGE_SIZE}건만 조회해 수를 세지 못했다", file=sys.stderr)
            return 1
        nodes = [n for n in threads["nodes"] if not (only_unresolved and n["isResolved"])]
        print(len(nodes))
        return 0
    if total > PAGE_SIZE:
        emit(f"경고: 스레드 {total}건 중 {PAGE_SIZE}건만 조회했다")

    for node in threads["nodes"]:
        if only_unresolved and node["isResolved"]:
            continue
        first = (node["comments"]["nodes"] or [{}])[0]
        emit({
            "id": node["id"],
            "resolved": node["isResolved"],
            "outdated": node["isOutdated"],
            "path": node["path"],
            "line": thread_line(node),
            "author": (first.get("author") or {}).get("login"),
            "head": (first.get("body") or "")[:HEAD_LEN],
        })
    return 0


def cmd_reply(host, thread_id, body_file):
    path = Path(body_file)
    if not path.is_file() or not os.access(path, os.R_OK):
        print(f"본문 파일을 읽을 수 없다: {body_file}", file=sys.stderr)
        return 2
    code, out, err = gh("api", "graphql", "-f", f"query={REPLY_MUTATION}",
                        "-f", f"threadId={thread_id}", "-F", f"body=@{path}",
                        "--jq", ".data.addPullRequestReviewThreadReply.comment.url",
                        env={"GH_HOST": host})
    if code != 0:
        print(err.strip() or out.strip(), file=sys.stderr)
        return 1
    print(out.strip())
    return 0


def parse_batch_map(text):
    """`THREAD_ID<탭>본문파일` 줄을 (줄 번호, id, 파일) 로 푼다. 빈 줄과 `#` 줄은 건너뛴다.

    탭이 없는 줄은 (줄 번호, None, 원문) 으로 내고 호출부가 실패로 센다.
    """
    rows = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
            rows.append((number, None, line))
        else:
            rows.append((number, parts[0].strip(), parts[1].strip()))
    return rows


def cmd_reply_batch(host, map_file):
    """map.tsv 의 모든 줄을 회신한다. 실패해도 나머지를 계속 돌리고 끝에 실패 목록을 낸다."""
    try:
        text = Path(map_file).read_text(encoding="utf-8")
    except OSError as e:
        print(f"map 파일을 읽을 수 없다: {map_file} ({e})", file=sys.stderr)
        return 2
    rows = parse_batch_map(text)
    if not rows:
        print(f"회신할 줄이 없다: {map_file}", file=sys.stderr)
        return 2
    base = Path(map_file).resolve().parent
    failed = []
    for number, tid, body in rows:
        if tid is None:
            print(f"줄 {number}: `THREAD_ID<탭>본문파일` 꼴이 아니다: {body}", file=sys.stderr)
            failed.append(f"줄 {number}")
            continue
        body_path = Path(body)
        if not body_path.is_absolute():
            body_path = base / body_path
        print(f"[{tid}] ", end="", flush=True)
        if cmd_reply(host, tid, str(body_path)) != 0:
            failed.append(f"줄 {number} {tid}")
    if failed:
        print(f"회신 실패 {len(failed)}/{len(rows)}건: " + ", ".join(failed), file=sys.stderr)
        return 1
    return 0


def cmd_carried(host, owner, repo, num, marker):
    """이전 PR 의 스레드 중 첫 댓글 뒤의 회신에 marker 가 든 것을 낸다. resolve 된 것도 낸다."""
    code, out, err = gh("api", "graphql", "-f", f"query={CARRIED_QUERY}",
                        "-f", f"owner={owner}", "-f", f"repo={repo}", "-F", f"num={num}",
                        env={"GH_HOST": host})
    if code != 0:
        print(err.strip() or out.strip(), file=sys.stderr)
        return 1
    threads = json.loads(out)["data"]["repository"]["pullRequest"]["reviewThreads"]
    if threads["totalCount"] > PAGE_SIZE:
        emit(f"경고: 스레드 {threads['totalCount']}건 중 {PAGE_SIZE}건만 조회했다")
    for node in threads["nodes"]:
        comments = node["comments"]["nodes"]
        hits = [c for c in comments[1:] if marker in (c.get("body") or "")]
        if not hits:
            continue
        first = comments[0]
        emit({
            "pr": int(num),
            "id": node["id"],
            "resolved": node["isResolved"],
            "path": node["path"],
            "line": node["line"],
            "author": (first.get("author") or {}).get("login"),
            "head": (first.get("body") or "")[:HEAD_LEN],
            "reply_url": hits[-1].get("url"),
        })
    return 0


def split_thread_ids(args, stdin):
    """resolve 인자를 THREAD_ID 목록으로 편다.

    `-` 는 표준 입력의 내용으로 바꾼다. 인자 안의 공백과 줄바꿈으로도 나눈다.
    zsh 는 따옴표 없는 변수를 낱말로 나누지 않아 `resolve $IDS` 가 인자 하나로 오기 때문이다.
    THREAD_ID 에는 공백이 없으므로 나눠도 잃는 것이 없다.
    """
    ids = []
    for arg in args:
        text = stdin.read() if arg == "-" else arg
        ids.extend(text.split())
    return ids


def cmd_resolve(host, thread_ids):
    failed = 0
    for tid in thread_ids:
        code, out, err = gh("api", "graphql", "-f", f"query={RESOLVE_MUTATION}",
                            "-f", f"threadId={tid}",
                            "--jq", '.data.resolveReviewThread.thread | "\\(.id) resolved=\\(.isResolved)"',
                            env={"GH_HOST": host})
        if code != 0:
            print(err.strip() or out.strip(), file=sys.stderr)
            failed = 1
            continue
        print(out.strip())
    return failed


class BadRepo(ValueError):
    """`--repo` 값이 `<owner>/<repo>` 꼴이 아니다."""


def take_repo(argv):
    """argv 에서 `--repo <owner>/<repo>` 를 떼어내고 나머지를 그대로 돌려준다.

    값에 `/` 가 없으면 `BadRepo` 를 낸다.
    조용히 버리면 현재 디렉터리로 되돌아가 엉뚱한 호스트를 쓰게 된다.
    """
    rest, owner, repo = [], None, None
    index = 0
    while index < len(argv):
        item = argv[index]
        value = None
        if item == "--repo" and index + 1 < len(argv):
            value, index = argv[index + 1], index + 2
        elif item.startswith("--repo="):
            value, index = item.split("=", 1)[1], index + 1
        else:
            rest.append(item)
            index += 1
        if value is not None:
            if "/" not in value:
                raise BadRepo(f"--repo 는 <owner>/<repo> 꼴이어야 한다: {value}")
            owner, repo = value.split("/", 1)
    return rest, owner, repo


def main(argv):
    count_only = "--count" in argv
    argv = [a for a in argv if a != "--count"]
    try:
        argv, given_owner, given_repo = take_repo(argv)
    except BadRepo as e:
        print(e, file=sys.stderr)
        return 2
    marker = DEFAULT_MARKER
    if "--marker" in argv:
        at = argv.index("--marker")
        if at + 1 >= len(argv):
            return usage()
        marker = argv[at + 1]
        del argv[at:at + 2]
    if len(argv) < 2:
        return usage()
    cmd, rest = argv[1], argv[2:]

    if cmd in ("list", "list-all", "carried") and len(rest) == 3:
        given_owner, given_repo = rest[0], rest[1]

    try:
        host = gh_host.resolve(given_owner, given_repo)
    except RuntimeError as e:
        print(e, file=sys.stderr)
        return 2

    if cmd in ("list", "list-all"):
        if len(rest) != 3:
            return usage()
        return cmd_list(host, rest[0], rest[1], rest[2],
                        only_unresolved=(cmd == "list"), count_only=count_only)
    if cmd == "reply":
        return cmd_reply(host, *rest[:2]) if len(rest) == 2 else usage()
    if cmd == "reply-batch":
        return cmd_reply_batch(host, rest[0]) if len(rest) == 1 else usage()
    if cmd == "carried":
        return cmd_carried(host, *rest[:3], marker) if len(rest) == 3 else usage()
    if cmd == "resolve":
        thread_ids = split_thread_ids(rest, sys.stdin)
        return cmd_resolve(host, thread_ids) if thread_ids else usage()
    return usage()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
