#!/usr/bin/env bash
# 본문 파일을 korean-check 의 검사기로 검사한다.
#
# 판정 기준과 검사기는 korean-check 스킬이 소유한다. 여기서는 그것을 찾아 부른다.
# 절대경로를 박지 않는 이유는 저장소마다 스킬 배치가 달라서다.
# 개인 공용은 <repo>/content-preview, 팀 공용은 <repo>/skills/content-preview 라
# 두 경우 모두 korean-check 가 형제 디렉터리에 온다.
#
# 사용법:
#   style-check.sh <파일.md> [<파일.md>...]
#   style-check.sh --text "<제목>"
#
# 종료 코드는 korean-check 의 check.sh 와 같다.
#   0  통과
#   1  위반 발견
#   2  검사기를 찾지 못했거나 돌지 못함
#
# --where 를 그대로 넘기면 찾은 korean-check 의 경로를 낸다.
# 검토 단계가 그 스킬의 references/ 를 열어야 하므로, 경로를 여기서 받아 간다.
set -u

[ $# -gt 0 ] || { echo "검사할 파일이나 --text 가 필요하다" >&2; exit 2; }

# pwd -P 로 실체 경로를 잡는다. 스킬 디렉터리가 심링크라 논리 경로로는 저장소 밖으로 나간다.
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
SIBLING="$(dirname "$SKILL_DIR")/korean-check"

CHECK=""
FOUND=""
for cand in "${KOREAN_CHECK:-}/scripts/check.sh" \
            "$SIBLING/scripts/check.sh" \
            "$HOME/.claude/skills/korean-check/scripts/check.sh"; do
  case "$cand" in /scripts/check.sh) continue ;; esac
  [ -f "$cand" ] || continue
  FOUND="$cand"
  # 실행 권한이 빠진 사본을 「찾지 못했다」로 보고하면 엉뚱한 곳을 고치게 된다.
  [ -x "$cand" ] && { CHECK="$cand"; break; }
done

if [ -z "$CHECK" ] && [ -n "$FOUND" ]; then
  echo "찾았으나 실행 권한이 없다: $FOUND" >&2
  echo "chmod +x 로 권한을 준다." >&2
  exit 2
fi

# 조용히 통과시키지 않는다. 검사기가 돌지 않은 것이 통과로 보이는 상황이 가장 위험하다.
if [ -z "$CHECK" ]; then
  cat >&2 <<'MSG'
korean-check 를 찾지 못해 표기 검사를 돌리지 못했다.
찾은 곳은 셋이다. KOREAN_CHECK, 이 스킬의 형제 디렉터리, 개인 스킬 디렉터리다.
korean-check 를 함께 받거나 KOREAN_CHECK 로 경로를 준다.
MSG
  exit 2
fi

exec "$CHECK" "$@"
