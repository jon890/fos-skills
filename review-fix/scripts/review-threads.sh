#!/usr/bin/env bash
# PR 의 리뷰 스레드를 조회하고, 스레드에 회신하고, resolve 한다.
#
# 사용법:
#   review-threads.sh list     <owner> <repo> <PR번호>   # 미해결 스레드만
#   review-threads.sh list-all <owner> <repo> <PR번호>   # resolve 된 것까지
#   review-threads.sh reply    <THREAD_ID> <본문파일>
#   review-threads.sh resolve  <THREAD_ID> [<THREAD_ID> ...]
#
# 봇의 발견사항은 인라인 댓글이 아니라 리뷰 스레드로 달리는 경우가 많다.
# REST 의 pulls/<N>/comments 로는 스레드 ID 를 얻을 수 없어 조회와 회신 모두 GraphQL 로 한다 (실측).
# path 와 line 을 함께 내므로 REST 댓글과 대조해 어느 지적인지 가릴 수 있다.
#
# 회신 본문은 파일로 받는다. -f body='...' 로 직접 넘기면
# 셸이 해석해 본문 안의 백틱과 달러가 명령 치환으로 사라진다 (실측).
#
# resolve 하지 않으면 "A conversation must be resolved" 보호 규칙이 머지를 막는다.
# 아직 반영하지 않은 스레드는 resolve 하지 않는다. resolve 는 "처리했다"는 표시다.
#
# 호스트는 gh-host.sh 로 스스로 구한다. 미리 export 할 필요가 없다.
set -u

usage() { sed -n '2,19p' "$0" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
GH_HOST="${GH_HOST:-$("$here/gh-host.sh")}" || exit 1
export GH_HOST

list_threads() {
  gh api graphql -f query='
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$num) {
          reviewThreads(first:100) {
            totalCount
            nodes { id isResolved isOutdated path line
                    comments(first:1){ nodes{ author{login} body } } }
          }
        }
      }
    }' -f owner="$1" -f repo="$2" -F num="$3" --jq "
      .data.repository.pullRequest.reviewThreads
      | (if .totalCount > 100 then
           \"경고: 스레드 \(.totalCount)건 중 100건만 조회했다\" else empty end),
        (.nodes[] | $4
         | {id, resolved: .isResolved, outdated: .isOutdated, path, line,
            author: .comments.nodes[0].author.login,
            head: (.comments.nodes[0].body[0:120])})"
}

cmd="${1:-}"
case "$cmd" in
  list)     [ $# -eq 4 ] || usage; list_threads "$2" "$3" "$4" 'select(.isResolved==false)' ;;
  list-all) [ $# -eq 4 ] || usage; list_threads "$2" "$3" "$4" '.' ;;
  reply)
    [ $# -eq 3 ] || usage
    [ -r "$3" ] || { echo "본문 파일을 읽을 수 없다: $3" >&2; exit 2; }
    gh api graphql -f query='
      mutation($threadId:ID!, $body:String!) {
        addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId, body:$body}) {
          comment { url }
        }
      }' -f threadId="$2" -F body=@"$3" \
      --jq '.data.addPullRequestReviewThreadReply.comment.url'
    ;;
  resolve)
    [ $# -ge 2 ] || usage
    shift
    for tid in "$@"; do
      gh api graphql -f query='
        mutation($threadId:ID!) {
          resolveReviewThread(input:{threadId:$threadId}) {
            thread { id isResolved }
          }
        }' -f threadId="$tid" --jq '.data.resolveReviewThread.thread | "\(.id) resolved=\(.isResolved)"'
    done
    ;;
  *) usage ;;
esac
