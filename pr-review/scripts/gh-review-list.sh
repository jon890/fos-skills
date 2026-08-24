#!/usr/bin/env bash
# PR 의 리뷰 댓글과 스레드를 읽는다. 호스트는 git remote 에서 자동으로 찾는다.
#
# usage: gh-review-list.sh <owner/repo> <PR번호> [--thread <root댓글id>] [--mine]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "$*" >&2; exit 1; }

detect_host() {
    [[ -n "${GH_HOST:-}" ]] && { echo "$GH_HOST"; return; }
    local url
    url=$(git remote get-url origin 2>/dev/null || true)
    case "$url" in
        *github.com*) echo "github.com" ;;
        https://*|http://*) echo "$url" | sed -E 's#^https?://([^/]+)/.*#\1#' ;;
        *@*:*) echo "$url" | sed -E 's#^[^@]+@([^:]+):.*#\1#' ;;
        *) die "git remote 에서 호스트를 찾지 못했습니다. GH_HOST 를 지정하세요." ;;
    esac
}

REPO="${1:?owner/repo}"; PR="${2:?PR 번호}"; shift 2
THREAD=""; MINE=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --thread) THREAD="${2:?root 댓글 id}"; shift 2 ;;
        --mine) MINE=1; shift ;;
        *) die "알 수 없는 옵션: $1" ;;
    esac
done

HOST=$(detect_host)
ME=$(GH_HOST="$HOST" gh api user --jq .login)

RAW=$(mktemp -t gh-review-list.XXXXXX)
trap 'rm -f "$RAW"' EXIT
GH_HOST="$HOST" gh api "repos/$REPO/pulls/$PR/comments?per_page=100" > "$RAW"

python3 "$HERE/render-comments.py" "$RAW" "$THREAD" "$MINE" "$ME"
