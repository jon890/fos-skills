#!/usr/bin/env bash
# task 생성 직후 자동 검증 — 기계적으로 판정되는 task 위생 5 패턴을 검출한다.
# 사용법: ~/.claude/skills/planning/scripts/verify-task.sh plan{N}-{slug}
# 스크립트는 스킬 디렉터리에 있고, cwd 는 tasks/ 를 가진 <타깃 레포 root> 여야 한다.
# 위반 라인을 stdout 으로 출력한다. 출력 0 줄이면 통과.
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

# execution profile schema: 신규 provider-neutral field + legacy read compatibility.
jq -e '
  .phases
  | all(
      ((has("execution_profile") and (.execution_profile | IN("fast", "standard", "deep")))
       or
       (has("model") and (.model | IN("haiku", "sonnet", "opus"))))
      and
      ((has("execution_profile") and has("model")) | not)
    )
' "$DIR/index.json" >/dev/null || \
  echo "$DIR/index.json — execution_profile/model schema 오류"

# 범위 불명확: "전체" 표현 — executor 가 어디까지 손댈지 알 수 없다
grep -nE "전체\s*(수정|변경|적용|교체|리팩토링|삭제)" "$DIR"/phase-*.md

# cwd 누락: Bash 블록에 실행 위치가 없으면 worktree 대신 main repo 를 고칠 수 있다
awk '
  /^```bash/ { in_block=1; lines=""; start_line=NR; next }
  /^```/ && in_block {
    if (lines !~ /# cwd:/) print FILENAME ":" start_line " — Bash 블록 cwd 주석 누락"
    in_block=0; next
  }
  in_block { lines = lines "\n" $0 }
' "$DIR"/phase-*.md

# 사람 의존 검증: 자동 실행이 끊긴다 (코드 블록 밖 본문만 본다)
#   "수동 smoke" 는 dev server 동작 확인이라 정규식이 잡지 않는다.
awk '
  /^```/ { in_code = !in_code; next }
  !in_code && /수동 검토|눈으로 확인|직접 확인|육안/ { print FILENAME ":" NR ": " $0 }
' "$DIR"/phase-*.md

# 완료 마킹 누락: plan 이 끝나도 상태가 안 바뀌어 재실행 사고로 이어진다
LAST_PHASE=$(ls "$DIR"/phase-*.md | sort | tail -1)
grep -E "index\.json.*completed|status.*completed" "$LAST_PHASE" > /dev/null || \
  echo "$LAST_PHASE — index.json completed 마킹 지시 누락"

# BSD sed \b 미지원: macOS 에서 조용히 아무것도 치환되지 않는다 (코드 블록 밖 본문만 본다)
awk '
  /^```/ { in_code = !in_code; next }
  !in_code && /sed[[:space:]].*\\b/ { print FILENAME ":" NR ": " $0 }
' "$DIR"/phase-*.md
