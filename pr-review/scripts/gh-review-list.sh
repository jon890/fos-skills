#!/usr/bin/env bash
# PR 의 리뷰 댓글과 스레드를 읽는다. 호스트는 git remote 에서 자동으로 찾는다.
#
# usage: gh-review-list.sh <owner/repo> <PR번호> [--thread <root댓글id>] [--mine]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "$*" >&2; exit 1; }

# 호스트 판별은 scripts/gh-host.sh 가 소유한다.
# review-fix 번들에도 같은 파일이 있다. 스킬마다 심링크가 따로 걸려 번들 밖 파일에는 닿지 않으므로
# 사본을 두고 evaluation/score.sh 의 드리프트 검사가 어긋남을 잡는다.
detect_host() {
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-host.sh" \
        || die "git remote 에서 호스트를 찾지 못했습니다. GH_HOST 를 지정하세요."
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
ME=""
[[ "$MINE" == 1 ]] && ME=$(GH_HOST="$HOST" gh api user --jq .login)

RAW=$(mktemp -t gh-review-list.XXXXXX)
trap 'rm -f "$RAW"' EXIT
# --paginate 로 100 건을 넘겨 받는다. per_page 만 두면 넘는 댓글이 조용히 잘린다.
GH_HOST="$HOST" gh api --paginate --slurp "repos/$REPO/pulls/$PR/comments?per_page=100" \
    | python3 -c 'import json,sys; json.dump([c for p in json.load(sys.stdin) for c in p], sys.stdout)' \
    > "$RAW"

python3 "$HERE/render-comments.py" "$RAW" "$THREAD" "$MINE" "$ME"
