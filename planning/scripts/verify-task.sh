#!/usr/bin/env bash
# task 생성 직후 자동 검증 — common-pitfalls.md 섹션 1 의 자동화 가능한 5 패턴 검출.
# 사용법: .claude/skills/planning/scripts/verify-task.sh plan{N}-{slug}
# cwd: <repo root>. 위반 라인을 stdout 으로 출력한다. 출력 0 줄이면 통과.
# 주의: grep 무매치가 exit 1 이므로 set -e 를 쓰지 않는다.
set -u

if [ $# -lt 1 ]; then
  echo "사용법: verify-task.sh <plan 디렉터리명>   (예: plan053-foo)"
  exit 2
fi
PLAN="$1"
DIR="tasks/$PLAN"
[ -d "$DIR" ] || { echo "디렉터리 없음: $DIR"; exit 2; }
ls "$DIR"/phase-*.md >/dev/null 2>&1 || { echo "phase 파일 없음: $DIR"; exit 2; }

# 1-2: "전체" 표현 (파일 범위 부정확)
grep -nE "전체\s*(수정|변경|적용|교체|리팩토링|삭제)" "$DIR"/phase-*.md

# 1-4: Bash 블록의 cwd 주석 누락
awk '
  /^```bash/ { in_block=1; lines=""; start_line=NR; next }
  /^```/ && in_block {
    if (lines !~ /# cwd:/) print FILENAME ":" start_line " — Bash 블록 cwd 주석 누락"
    in_block=0; next
  }
  in_block { lines = lines "\n" $0 }
' "$DIR"/phase-*.md

# 1-5: 인간 의존 검증 (코드 블록 외 prose 라인만)
#   "수동 smoke" 는 dev server 동작 확인이라 정규식이 잡지 않는다.
awk '
  /^```/ { in_code = !in_code; next }
  !in_code && /수동 검토|눈으로 확인|직접 확인|육안/ { print FILENAME ":" NR ": " $0 }
' "$DIR"/phase-*.md

# 1-8: 마지막 phase 에 index.json completed 마킹 지시 누락
LAST_PHASE=$(ls "$DIR"/phase-*.md | sort | tail -1)
grep -E "index\.json.*completed|status.*completed" "$LAST_PHASE" > /dev/null || \
  echo "$LAST_PHASE — index.json completed 마킹 지시 누락"

# 1-9: macOS BSD sed \b 미지원 (코드 블록 외 prose 라인만)
awk '
  /^```/ { in_code = !in_code; next }
  !in_code && /sed[[:space:]].*\\b/ { print FILENAME ":" NR ": " $0 }
' "$DIR"/phase-*.md
