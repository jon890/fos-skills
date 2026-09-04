#!/usr/bin/env bash
# PR 의 리뷰를 네 소스에서 모아 출력한다.
#
# 사용법:
#   collect-review.sh <owner> <repo> <PR번호>
#
# 워크플로 버전에 따라 리뷰가 담기는 위치가 다르다.
# 한 소스만 보면 봇의 구조화 리뷰를 놓친다.
#
# 리뷰 스레드를 함께 내는 이유는 「회신」 단계가 THREAD_ID 로 회신하기 때문이다.
# REST 댓글의 path 와 line 을 스레드의 것과 대조해 어느 지적에 회신할지 정한다.
#
# diff_hunk, html_url, _links, reactions 는 토큰만 차지하므로 jq 로 빼고 body 는 잘라 낸다.
# 호스트는 gh-host.sh 로 스스로 구한다. 미리 export 할 필요가 없다.
set -eu

[ $# -eq 3 ] || { sed -n '2,14p' "$0" >&2; exit 2; }
owner=$1; repo=$2; num=$3

here=$(cd "$(dirname "$0")" && pwd)
GH_HOST="${GH_HOST:-$("$here/gh-host.sh")}"
export GH_HOST

echo "## 1. GitHub Review (요약 리뷰가 담기는 곳)"
gh api "repos/$owner/$repo/pulls/$num/reviews" \
  --jq '[.[] | {id, body: .body[0:1000], state, author: .user.login}]'

echo "## 2. 인라인 코드 리뷰 댓글 (diff 라인에 달림)"
gh api "repos/$owner/$repo/pulls/$num/comments" \
  --jq '[.[] | {id, path, line, body: .body[0:500], author: .user.login, in_reply_to_id}]'

echo "## 3. 일반 PR(issue) 댓글"
gh pr view "$num" --repo "$owner/$repo" --comments

echo "## 4. 미해결 리뷰 스레드 (「회신」 단계의 대상)"
"$here/review-threads.sh" list "$owner" "$repo" "$num"
