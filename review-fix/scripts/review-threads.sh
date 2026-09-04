#!/usr/bin/env bash
# PR 의 리뷰 스레드를 조회하고, 스레드에 회신하고, resolve 한다.
#
# 사용법:
#   review-threads.sh list    <owner> <repo> <PR번호>
#   review-threads.sh reply   <THREAD_ID> <본문파일>
#   review-threads.sh resolve <THREAD_ID> [<THREAD_ID> ...]
#
# 봇의 발견사항은 인라인 댓글이 아니라 리뷰 스레드로 달리는 경우가 많다.
# REST 의 pulls/<N>/comments 로는 스레드 ID 를 얻을 수 없어 조회와 회신 모두 GraphQL 로 한다 (실측).
#
# 회신 본문은 파일로 받는다. gh api graphql -f b='...' 에 본문을 직접 쓰면
# 셸이 해석해 본문 안의 백틱과 달러가 명령 치환으로 사라진다 (실측).
#
# resolve 하지 않으면 "A conversation must be resolved" 보호 규칙이 머지를 막는다.
# 아직 반영하지 않은 스레드는 resolve 하지 않는다. resolve 는 "처리했다"는 표시다.
#
# 호스트는 gh-host.sh 로 미리 export 한다: eval "$(~/.claude/skills/review-fix/scripts/gh-host.sh)"
set -u

usage() { sed -n '2,19p' "$0" >&2; exit 2; }

cmd="${1:-}"
case "$cmd" in
  list)
    [ $# -eq 4 ] || usage
    gh api graphql -f query='
      query($owner:String!, $repo:String!, $num:Int!) {
        repository(owner:$owner, name:$repo) {
          pullRequest(number:$num) {
            reviewThreads(first:100) {
              nodes { id isResolved isOutdated comments(first:1){ nodes{ author{login} body } } }
            }
          }
        }
      }' -f owner="$2" -f repo="$3" -F num="$4" \
      --jq '.data.repository.pullRequest.reviewThreads.nodes[]
            | select(.isResolved==false)
            | {id, outdated: .isOutdated, author: .comments.nodes[0].author.login,
               head: (.comments.nodes[0].body[0:120])}'
    ;;
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
