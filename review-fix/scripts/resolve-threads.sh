#!/usr/bin/env bash
# PR 의 미해결 리뷰 스레드를 조회하고 resolve 한다.
#
# 사용법:
#   resolve-threads.sh list    <owner> <repo> <PR번호>
#   resolve-threads.sh resolve <THREAD_ID> [<THREAD_ID> ...]
#
# resolve 하지 않으면 "A conversation must be resolved" 보호 규칙이 머지를 막는다.
# 아직 반영하지 않은 스레드는 resolve 하지 않는다 — resolve 는 "처리했다"는 표시다.
#
# github.com 이 아닌 호스트(사내 GHE 등)는 GH_HOST 를 지정한다.
#   GH_HOST=github.example.com resolve-threads.sh list <owner> <repo> <N>
# gh api graphql 은 --repo 를 받지 않아 기본 호스트를 보므로, 지정하지 않으면 NOT_FOUND 가 난다 (실측).
set -u

usage() { sed -n '2,10p' "$0" >&2; exit 2; }

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
