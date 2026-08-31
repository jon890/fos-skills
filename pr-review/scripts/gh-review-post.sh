#!/usr/bin/env bash
# 인라인 리뷰를 검증한 뒤 등록한다.
#
# usage: gh-review-post.sh <owner/repo> <PR번호> <파일경로> <줄번호> <본문.md> <핵심낱말>...
#   reply 모드: gh-review-post.sh --reply <owner/repo> <PR번호> <댓글id> <본문.md> <핵심낱말>...
#
# 핵심 낱말은 하나 이상 필수다. 그 리뷰에만 있는 문구를 넣는다.
# 등급 접두사만 보면 접두사가 같은 옛 payload 가 그대로 통과한다.
# DRY_RUN=1 이면 검증만 하고 등록하지 않는다.
#
# 호스트는 git remote 에서 자동으로 찾는다. GH_HOST 로 덮어쓸 수 있다.
# payload 는 매번 새 임시 파일에 쓰고, 등록 직전에 본문을 검증한다.
set -euo pipefail

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

MODE=review
if [[ "${1:-}" == "--reply" ]]; then MODE=reply; shift; fi

if [[ "$MODE" == review ]]; then
    REPO="${1:?owner/repo}"; PR="${2:?PR 번호}"; FILE_PATH="${3:?파일 경로}"
    LINE="${4:?줄 번호}"; BODY_FILE="${5:?본문 파일}"; shift 5
else
    REPO="${1:?owner/repo}"; PR="${2:?PR 번호}"; COMMENT_ID="${3:?댓글 id}"
    BODY_FILE="${4:?본문 파일}"; shift 4
fi
KEYWORDS=("$@")
[[ ${#KEYWORDS[@]} -ge 1 ]] \
    || die "핵심 낱말을 하나 이상 넘기세요. 그 리뷰에만 있는 문구여야 옛 본문을 거릅니다."

[[ -s "$BODY_FILE" ]] || die "본문 파일이 비어 있습니다: $BODY_FILE"
HOST=$(detect_host)

# 본문 검증 — 옛 payload 가 등록되는 사고를 막는 마지막 관문
BODY=$(cat "$BODY_FILE")
if [[ "$MODE" == review ]]; then
    grep -qE '^\(P[1-5]\)' <<<"$(head -1 "$BODY_FILE")" \
        || die "본문 첫 줄이 (P1)~(P5) 로 시작하지 않습니다. 등급 표기를 확인하세요."
fi
for kw in "${KEYWORDS[@]}"; do
    grep -qF -- "$kw" <<<"$BODY" || die "본문에 '$kw' 가 없습니다. 다른 본문일 수 있습니다."
done
if grep -qE '(^|[^`])(/review|@claude|@github-actions|@dependabot)\b' <<<"$BODY"; then
    die "본문에 봇 재트리거 토큰이 있습니다. 백틱으로 감싸세요."
fi

echo "호스트  : $HOST"
echo "대상    : $REPO PR #$PR"
[[ "$MODE" == review ]] && echo "위치    : $FILE_PATH:$LINE" || echo "답글 대상: 댓글 $COMMENT_ID"
echo "첫 줄   : $(head -1 "$BODY_FILE")"
echo "검증    : 통과"

if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "DRY_RUN=1 이므로 등록하지 않고 종료합니다."
    exit 0
fi

PAYLOAD=$(mktemp -t gh-review-payload.XXXXXX)
trap 'rm -f "$PAYLOAD"' EXIT

if [[ "$MODE" == review ]]; then
    python3 - "$BODY_FILE" "$FILE_PATH" "$LINE" > "$PAYLOAD" <<'PY'
import json, sys
body = open(sys.argv[1], encoding="utf-8").read().rstrip()
print(json.dumps({"event": "COMMENT", "comments": [
    {"path": sys.argv[2], "line": int(sys.argv[3]), "side": "RIGHT", "body": body}]},
    ensure_ascii=False))
PY
    RESULT=$(GH_HOST="$HOST" gh api "repos/$REPO/pulls/$PR/reviews" -X POST --input "$PAYLOAD")
    REVIEW_ID=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["id"])' <<<"$RESULT")
    echo "등록 완료: 리뷰 $REVIEW_ID"
    GH_HOST="$HOST" gh api "repos/$REPO/pulls/$PR/reviews/$REVIEW_ID/comments" \
        --jq '.[] | "  댓글 \(.id)  \(.path)  첫 줄: \(.body[0:30])"'
else
    RESULT=$(GH_HOST="$HOST" gh api "repos/$REPO/pulls/$PR/comments/$COMMENT_ID/replies" \
        -X POST -F body=@"$BODY_FILE")
    python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(f"등록 완료: 답글 {d[\"id\"]} (in_reply_to {d[\"in_reply_to_id\"]})")' <<<"$RESULT"
fi
