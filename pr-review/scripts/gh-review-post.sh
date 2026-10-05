#!/usr/bin/env bash
# 인라인 리뷰를 검증한 뒤 등록한다.
#
# usage: gh-review-post.sh <owner/repo> <PR번호> <파일경로> <줄번호> <본문.md> <핵심낱말>...
#   reply 모드: gh-review-post.sh --reply <owner/repo> <PR번호> <댓글id> <본문.md> <핵심낱말>...
#   요약 모드: gh-review-post.sh --summary <owner/repo> <PR번호> <본문.md> <핵심낱말>...
#   묶음 모드: gh-review-post.sh --batch <owner/repo> <PR번호> <요약.md> <핵심낱말>... -- <파일경로>:<줄번호>:<본문.md>...
#     요약과 인라인 여러 건을 리뷰 하나로 등록한다. `--` 뒤에 인라인을 하나 이상 적는다.
#   수정 모드: gh-review-post.sh --edit <owner/repo> <PR번호> <댓글id> <본문.md> <핵심낱말>...
#     이미 등록한 인라인 리뷰의 본문을 바꾼다. 검증은 인라인 리뷰와 같다.
#
# 인라인 리뷰의 첫 줄은 `🟠 **P2 높음**` 처럼 색 원과 등급이어야 한다. 표기는 references/grading.md 가 소유한다.
# 요약의 첫 줄은 `## 코드 리뷰` 로 시작해야 한다.
# 인라인 리뷰와 요약에는 AI 가 작성했다는 안내를 본문 끝에 붙인다. 이미 있으면 다시 붙이지 않는다.
#
# 핵심 낱말은 하나 이상 필수다. 그 리뷰에만 있는 문구를 넣는다.
# 등급 접두사만 보면 접두사가 같은 옛 payload 가 그대로 통과한다.
# DRY_RUN=1 이면 검증만 하고 등록하지 않는다.
#
# 호스트는 git remote 에서 자동으로 찾는다. GH_HOST 로 덮어쓸 수 있다.
# payload 는 매번 새 임시 파일에 쓰고, 등록 직전에 본문을 검증한다.
set -euo pipefail

die() { echo "$*" >&2; exit 1; }

# 호스트 판별은 scripts/gh-host.sh 가 소유한다.
# review-fix 번들에도 같은 파일이 있다. 스킬마다 심링크가 따로 걸려 번들 밖 파일에는 닿지 않으므로
# 사본을 두고 scripts/check-shared.sh 가 어긋남을 잡는다.
detect_host() {
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-host.sh" \
        || die "git remote 에서 호스트를 찾지 못했습니다. GH_HOST 를 지정하세요."
}

# 등록한 인라인이 모두 줄에 붙었는지 확인한다.
# reviews/{id}/comments 는 줄에 붙은 댓글도 line 을 null 로 준다(실측). 판정에 쓰지 않고
# pulls/{N}/comments 에서 pull_request_review_id 로 골라 path:line 을 본다.
# 줄이 diff 에 없어 line 이 null 로 붙은 댓글은 이 목록에서 빠지므로 수가 모자라면 실패한다.
verify_inline() {
    local review_id="$1" expected="$2" found count
    found=$(GH_HOST="$HOST" gh api --paginate "repos/$REPO/pulls/$PR/comments" \
        --jq ".[] | select(.pull_request_review_id == $review_id and .line != null)
              | \"  댓글 \(.id)  \(.path):\(.line)  첫 줄: \(.body | split(\"\\n\")[0])\"")
    [[ -z "$found" ]] || echo "$found"
    count=$(grep -c . <<<"$found" || true)
    if [[ "$count" != "$expected" ]]; then
        echo "경고: 인라인 ${expected}건을 등록했지만 줄에 붙은 것은 ${count}건입니다. 줄이 diff 에 없을 수 있습니다." >&2
        return 1
    fi
}

MODE=review
if [[ "${1:-}" == "--reply" ]]; then MODE=reply; shift; fi
if [[ "${1:-}" == "--summary" ]]; then MODE=summary; shift; fi
if [[ "${1:-}" == "--batch" ]]; then MODE=batch; shift; fi
if [[ "${1:-}" == "--edit" ]]; then MODE=edit; shift; fi

GRADE_RE='^(🔴 \*\*P1 치명|🟠 \*\*P2 높음|🟡 \*\*P3 보통|🔵 \*\*P4 낮음|⚪ \*\*P5 참고)\*\*$'
AI_NOTICE='🤖 이 리뷰는 AI 가 작성했고, 등록 전에 사람이 확인했습니다.'

if [[ "$MODE" == review ]]; then
    REPO="${1:?owner/repo}"; PR="${2:?PR 번호}"; FILE_PATH="${3:?파일 경로}"
    LINE="${4:?줄 번호}"; BODY_FILE="${5:?본문 파일}"; shift 5
elif [[ "$MODE" == summary || "$MODE" == batch ]]; then
    REPO="${1:?owner/repo}"; PR="${2:?PR 번호}"; BODY_FILE="${3:?본문 파일}"; shift 3
else
    REPO="${1:?owner/repo}"; PR="${2:?PR 번호}"; COMMENT_ID="${3:?댓글 id}"
    BODY_FILE="${4:?본문 파일}"; shift 4
fi
KEYWORDS=(); INLINES=()
while [[ $# -gt 0 ]]; do
    if [[ "$MODE" == batch && "$1" == "--" ]]; then shift; INLINES=("$@"); break; fi
    KEYWORDS+=("$1"); shift
done
[[ ${#KEYWORDS[@]} -ge 1 ]] \
    || die "핵심 낱말을 하나 이상 넘기세요. 그 리뷰에만 있는 문구여야 옛 본문을 거릅니다."

[[ -s "$BODY_FILE" ]] || die "본문 파일이 비어 있습니다: $BODY_FILE"
HOST=$(detect_host)

# 본문 검증 — 옛 payload 가 등록되는 사고를 막는 마지막 관문
BODY=$(cat "$BODY_FILE")
if [[ "$MODE" == batch ]]; then
    [[ ${#INLINES[@]} -ge 1 ]] || die "묶음 모드는 '--' 뒤에 <파일경로>:<줄번호>:<본문.md> 를 하나 이상 받습니다."
    for spec in "${INLINES[@]}"; do
        inline_file="${spec##*:}"; rest="${spec%:*}"; inline_line="${rest##*:}"
        [[ "$inline_line" =~ ^[0-9]+$ ]] || die "줄 번호를 읽지 못했습니다: $spec"
        [[ -s "$inline_file" ]] || die "본문 파일이 비어 있습니다: $inline_file"
        grep -qE "$GRADE_RE" <<<"$(head -1 "$inline_file")" \
            || die "$inline_file 의 첫 줄이 색 원과 등급(예: 🟠 **P2 높음**)이 아닙니다."
        BODY+=$'\n'"$(cat "$inline_file")"
    done
fi
if [[ "$MODE" == review || "$MODE" == edit ]]; then
    grep -qE "$GRADE_RE" <<<"$(head -1 "$BODY_FILE")" \
        || die "본문 첫 줄이 색 원과 등급(예: 🟠 **P2 높음**)이 아닙니다. references/grading.md 의 표기를 확인하세요."
elif [[ "$MODE" == summary || "$MODE" == batch ]]; then
    grep -qE '^## 코드 리뷰' <<<"$(head -1 "$BODY_FILE")" \
        || die "요약 첫 줄이 '## 코드 리뷰' 로 시작하지 않습니다."
fi
for kw in "${KEYWORDS[@]}"; do
    grep -qF -- "$kw" <<<"$BODY" || die "본문에 '$kw' 가 없습니다. 다른 본문일 수 있습니다."
done
if grep -qE '(^|[^`])(/review|@claude|@github-actions|@dependabot)\b' <<<"$BODY"; then
    die "본문에 봇 재트리거 토큰이 있습니다. 백틱으로 감싸세요."
fi

echo "호스트  : $HOST"
echo "대상    : $REPO PR #$PR"
case "$MODE" in
    review)  echo "위치    : $FILE_PATH:$LINE" ;;
    summary) echo "위치    : 리뷰 요약" ;;
    batch)   echo "위치    : 리뷰 요약과 인라인 ${#INLINES[@]}건" ;;
    edit)    echo "수정 대상: 댓글 $COMMENT_ID" ;;
    *)       echo "답글 대상: 댓글 $COMMENT_ID" ;;
esac
echo "첫 줄   : $(head -1 "$BODY_FILE")"
echo "검증    : 통과"

if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "DRY_RUN=1 이므로 등록하지 않고 종료합니다."
    exit 0
fi

PAYLOAD=$(mktemp -t gh-review-payload.XXXXXX)
trap 'rm -f "$PAYLOAD"' EXIT

if [[ "$MODE" == batch ]]; then
    python3 - "$BODY_FILE" "$AI_NOTICE" "${INLINES[@]}" > "$PAYLOAD" <<'PY'
import json, sys
notice = sys.argv[2]
body = open(sys.argv[1], encoding="utf-8").read().rstrip()
if notice not in body:
    body += "\n\n---\n\n" + notice
comments = []
for spec in sys.argv[3:]:
    rest, _, path_md = spec.rpartition(":")
    path, _, line = rest.rpartition(":")
    text = open(path_md, encoding="utf-8").read().rstrip()
    if notice not in text:
        text += "\n\n<sub>" + notice + "</sub>"
    comments.append({"path": path, "line": int(line), "side": "RIGHT", "body": text})
print(json.dumps({"event": "COMMENT", "body": body, "comments": comments}, ensure_ascii=False))
PY
    RESULT=$(GH_HOST="$HOST" gh api "repos/$REPO/pulls/$PR/reviews" -X POST --input "$PAYLOAD")
    REVIEW_ID=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d["id"])' <<<"$RESULT")
    echo "등록 완료: 리뷰 $REVIEW_ID"
    verify_inline "$REVIEW_ID" "${#INLINES[@]}"
elif [[ "$MODE" == edit ]]; then
    python3 - "$BODY_FILE" "$AI_NOTICE" > "$PAYLOAD" <<'PY'
import json, sys
body = open(sys.argv[1], encoding="utf-8").read().rstrip()
if sys.argv[2] not in body:
    body += "\n\n<sub>" + sys.argv[2] + "</sub>"
print(json.dumps({"body": body}, ensure_ascii=False))
PY
    GH_HOST="$HOST" gh api "repos/$REPO/pulls/comments/$COMMENT_ID" -X PATCH --input "$PAYLOAD" \
        --jq '"수정 완료: 댓글 \(.id)  \(.path)  첫 줄: \(.body | split("\n")[0])"'
elif [[ "$MODE" == summary ]]; then
    python3 - "$BODY_FILE" "$AI_NOTICE" > "$PAYLOAD" <<'PY'
import json, sys
body = open(sys.argv[1], encoding="utf-8").read().rstrip()
if sys.argv[2] not in body:
    body += "\n\n---\n\n" + sys.argv[2]
print(json.dumps({"event": "COMMENT", "body": body}, ensure_ascii=False))
PY
    RESULT=$(GH_HOST="$HOST" gh api "repos/$REPO/pulls/$PR/reviews" -X POST --input "$PAYLOAD")
    python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print("등록 완료: 요약 리뷰", d["id"], d["html_url"])' <<<"$RESULT"
elif [[ "$MODE" == review ]]; then
    python3 - "$BODY_FILE" "$FILE_PATH" "$LINE" "$AI_NOTICE" > "$PAYLOAD" <<'PY'
import json, sys
body = open(sys.argv[1], encoding="utf-8").read().rstrip()
if sys.argv[4] not in body:
    body += "\n\n<sub>" + sys.argv[4] + "</sub>"
print(json.dumps({"event": "COMMENT", "comments": [
    {"path": sys.argv[2], "line": int(sys.argv[3]), "side": "RIGHT", "body": body}]},
    ensure_ascii=False))
PY
    RESULT=$(GH_HOST="$HOST" gh api "repos/$REPO/pulls/$PR/reviews" -X POST --input "$PAYLOAD")
    REVIEW_ID=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["id"])' <<<"$RESULT")
    echo "등록 완료: 리뷰 $REVIEW_ID"
    verify_inline "$REVIEW_ID" 1
else
    RESULT=$(GH_HOST="$HOST" gh api "repos/$REPO/pulls/$PR/comments/$COMMENT_ID/replies" \
        -X POST -F body=@"$BODY_FILE")
    python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); i=d["id"]; r=d["in_reply_to_id"]; print(f"등록 완료: 답글 {i} (in_reply_to {r})")' <<<"$RESULT"
fi
