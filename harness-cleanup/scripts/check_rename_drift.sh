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
# 출력 0 줄이면 통과. 종료 코드는 0 통과 / 1 드리프트 검출 / 2 사용법 오류다.
# 주의: grep 무매치가 exit 1 이므로 set -e 를 쓰지 않는다.
#
# 검사 대상 수를 stderr 로 알린다. 출력 0 줄이 "깨끗함" 인지 "볼 것이 없었음" 인지
# 구분되지 않으면, 억제된 검사가 통과로 읽혀 회귀가 그대로 지나간다.
set -u

REPO="${1:?사용법: check_rename_drift.sh <대상 저장소> [<기준 커밋>]}"
BASE="${2:-HEAD}"
cd "$REPO" || exit 2

found=0
scanned=0

while IFS= read -r -d '' md; do
  skill="${md%/SKILL.md}"
  [ -d "$skill/references" ] || continue

  # SKILL.md 가 이번에 바뀌지 않았으면 볼 것이 없다
  git diff --quiet "$BASE" -- "$md" && continue
  scanned=$((scanned + 1))

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

    # 그 이름이 지금도 SKILL.md 에 있으면 이름을 바꾼 것이 아니라 옮긴 것이다.
    #   diff 는 이동을 삭제+추가로 보여주므로 이 가드가 없으면 절 이동마다 오탐이 난다.
    grep -qF -- "$label" "$md" && continue

    # 그 이름을 아직 담고 있는 참조 문서를 찾는다
    owners=$(grep -lF -- "$label" "$skill"/references/*.md 2>/dev/null)
    [ -n "$owners" ] || continue

    # 그 라벨을 담은 문서가 하나라도 함께 바뀌었으면 반영된 것으로 본다.
    #   스킬 단위로 "참조가 하나라도 바뀌었나" 를 보면, 무관한 참조 파일 한 줄 수정이
    #   그 스킬의 드리프트를 전부 침묵시킨다. 라벨을 담은 파일만 따져야 한다.
    #   반대로 파일별로 따로 따지면, 라벨이 새 소유자로 옮겨 간 리팩토링에서
    #   그 단어를 우연히 담은 무관한 문서가 매번 오탐으로 걸린다.
    reflected=0
    stale=""
    while IFS= read -r owner; do
      [ -n "$owner" ] || continue
      if git diff --quiet "$BASE" -- "$owner"; then
        stale="$stale $owner"
      else
        reflected=1
      fi
    done <<< "$owners"

    if [ "$reflected" -eq 0 ] && [ -n "$stale" ]; then
      echo "DRIFT: $md 에서 \"$label\" 을 바꿨는데 참조 문서가 그대로다 —$stale"
      found=$((found + 1))
    fi
  done <<< "$removed"
done < <(find . \
  -type d \( -name .git -o -name .omx -o -name node_modules -o -name data -o -name private -o -name sources -o -name tasks \) -prune -o \
  -type f -name SKILL.md -print0)

if [ "$scanned" -eq 0 ]; then
  echo "검사 대상 없음 — 기준 '$BASE' 대비 변경된 SKILL.md 가 하나도 없다 (통과가 아니다)" >&2
else
  echo "검사한 SKILL.md: ${scanned}개, 드리프트: ${found}건" >&2
fi

[ "$found" -eq 0 ] || exit 1
exit 0
