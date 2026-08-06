#!/usr/bin/env bash
# SKILL.md 를 고치고 그것이 위임한 참조 문서를 안 고친 경우를 찾는다.
#
# 사용법: check_rename_drift.sh <대상 저장소> [<기준 커밋>]
#   기준 커밋 생략 시 HEAD 와 작업 트리를 비교한다.
#
# 이 저장소에서 네 번 반복된 실패가 대상이다 —
# SKILL.md 에서 절 이름·개념·주어를 바꾸고 그것을 소유한 references/*.md 를 안 고침.
# 그러면 요약본과 소유자 문서가 서로 다른 것을 지시하게 된다.
#
# 출력 0 줄이면 통과. 주의: grep 무매치가 exit 1 이므로 set -e 를 쓰지 않는다.
set -u

REPO="${1:?사용법: check_rename_drift.sh <대상 저장소> [<기준 커밋>]}"
BASE="${2:-HEAD}"
cd "$REPO" || exit 2

found=0

for skill in */; do
  skill="${skill%/}"
  md="$skill/SKILL.md"
  [ -f "$md" ] || continue
  [ -d "$skill/references" ] || continue

  # SKILL.md 가 이번에 바뀌지 않았으면 볼 것이 없다
  git diff --quiet "$BASE" -- "$md" && continue

  # 참조 문서가 함께 바뀌었는지
  refs_changed=0
  git diff --quiet "$BASE" -- "$skill/references/" || refs_changed=1

  # SKILL.md 에서 사라진 헤딩·굵은 라벨을 뽑는다
  #   diff 줄은 "-" 마커 뒤에 리스트 마커가 또 붙는다 ("-- **이름**...").
  #   마커를 먼저 벗겨야 헤딩·굵은 라벨이 줄 머리에 온다.
  removed=$(git diff "$BASE" -- "$md" |
    grep '^-' | grep -v '^---' |
    sed -E 's/^-//; s/^ *[-*] +//' |
    grep -oE '^#{2,4} .+|^\*\*[^*]+\*\*' |
    sed -E 's/^#{2,4} //; s/^\*\*//; s/\*\*$//' |
    sed -E 's/ *\(.*\)$//' | sort -u)

  [ -n "$removed" ] || continue

  while IFS= read -r label; do
    [ -n "$label" ] || continue
    # 그 이름이 참조 문서에 아직 남아 있는데 참조 문서는 안 바뀌었다 → 드리프트 의심
    if grep -qF -- "$label" "$skill"/references/*.md 2>/dev/null && [ "$refs_changed" -eq 0 ]; then
      hits=$(grep -lF -- "$label" "$skill"/references/*.md 2>/dev/null | tr '\n' ' ')
      echo "DRIFT: $md 에서 \"$label\" 을 바꿨는데 참조 문서가 그대로다 — $hits"
      found=$((found + 1))
    fi
  done <<< "$removed"
done

exit 0
