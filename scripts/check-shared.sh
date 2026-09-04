#!/usr/bin/env bash
# 스킬 번들에 복제된 공용 파일이 어긋났는지 본다.
#
# 스킬마다 심링크가 따로 걸려 번들 밖 파일에는 상대경로로 닿지 않는다.
# 그래서 공용 파일은 번들마다 사본을 두고, 어긋남은 이 검사가 잡는다.
# 팀 저장소로 내보내는 export-to-team.sh 와 같은 구조다.
#
# 사용법:
#   scripts/check-shared.sh            # 어긋나면 종료 코드 1
set -u
cd "$(dirname "$0")/.."

# 원본:사본 쌍. 원본을 왼쪽에 둔다.
PAIRS="
review-fix/scripts/gh-host.sh:pr-review/scripts/gh-host.sh
"

fail=0
for pair in $PAIRS; do
  [ -n "$pair" ] || continue
  src=${pair%%:*}; dst=${pair##*:}
  if [ ! -f "$src" ]; then echo "  원본 없음  $src"; fail=1; continue; fi
  if [ ! -f "$dst" ]; then echo "  사본 없음  $dst"; fail=1; continue; fi
  if ! diff -q "$src" "$dst" >/dev/null; then
    echo "  다름      $src -> $dst"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "복제된 공용 파일이 모두 같다."
else
  echo
  echo "원본을 사본으로 복사한다: cp <원본> <사본>"
  exit 1
fi
