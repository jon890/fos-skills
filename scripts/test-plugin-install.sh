#!/usr/bin/env bash
# 작업 트리를 플러그인으로 설치해 보고, 설치 캐시에서 스킬과 경로 참조가 동작하는지 확인한다.
#
# 매니페스트 시험은 파일만 보므로, 설치해야 드러나는 문제를 여기서 잡는다.
# 실제 ~/.claude 는 바꾸지 않는다. 임시 디렉터리를 CLAUDE_CONFIG_DIR 로 쓰고,
# 가짜 git 주소를 임시 저장소로 돌려 마켓플레이스를 등록한다. 네트워크는 쓰지 않는다.
#
# 사용법:
#   test-plugin-install.sh           시험하고 임시 디렉터리를 지운다
#   test-plugin-install.sh --keep    임시 디렉터리를 지우지 않고 경로를 출력한다
#
# 종료 코드: 0 통과, 1 시험 실패, 2 실행 불가
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_URL="https://marketplace.test/fos-skills.git"
PLUGIN_ID="fos-skills@fos-skills"

KEEP=false
case "${1:-}" in
  "")      ;;
  --keep)  KEEP=true ;;
  *)       echo "알 수 없는 인자: $1  (쓸 수 있는 것은 --keep 뿐이다)" >&2; exit 2 ;;
esac

for tool in claude git tar python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "실행 불가: $tool 없음" >&2; exit 2; }
done

T="$(mktemp -d)"
T="$(cd "$T" && pwd -P)"
if $KEEP; then
  echo "임시 디렉터리를 남긴다: $T"
else
  trap 'rm -rf "$T"' EXIT
fi

# git 이 추적하거나 추적 후보인 파일만 복사한다. 무시되는 worktrees/ 와 .omc/ 는 빠지고
# 아직 커밋하지 않은 새 파일은 들어간다. 작업 트리에서 지운 파일은 목록에서 뺀다.
mkdir -p "$T/src"
(
  cd "$REPO_DIR"
  git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      printf '%s\0' "$f"
    fi
  done | tar --null -T - -cf -
) | tar -xf - -C "$T/src"

git -C "$T/src" init -q
git -C "$T/src" add -A
git -C "$T/src" -c user.name=tester -c user.email=tester@example.com commit -q -m "install test"

export CLAUDE_CONFIG_DIR="$T/config"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="url.file://$T/src.insteadOf"
export GIT_CONFIG_VALUE_0="$FAKE_URL"

# 실제 ~/.claude 에 가짜 마켓플레이스가 등록되지 않게 claude 를 부르기 전에 격리를 확인한다.
case "$CLAUDE_CONFIG_DIR" in
  "$T"/*) ;;
  *) echo "실행 불가: CLAUDE_CONFIG_DIR 격리 실패" >&2; exit 2 ;;
esac
mkdir -p "$CLAUDE_CONFIG_DIR"

FAILS=0
ok()   { echo "ok: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

# claude 명령을 돌려 출력을 OUT 에, 종료 코드를 RC 에 담는다. set -e 로 죽지 않게 한다.
OUT=""
RC=0
run() {
  RC=0
  OUT="$("$@" 2>&1)" || RC=$?
}

# 기대하는 스킬 이름은 매니페스트의 skills 배열에서 읽는다.
SKILLS=()
while IFS= read -r line; do
  [ -n "$line" ] && SKILLS+=("$line")
done < <(python3 -c '
import json, sys
for s in json.load(open(sys.argv[1], encoding="utf-8"))["skills"]:
    print(s[2:] if s.startswith("./") else s)
' "$T/src/.claude-plugin/plugin.json")
EXPECTED=${#SKILLS[@]}

# 검증: 매니페스트 오류가 없고 경고는 version 하나뿐이어야 한다.
run bash -c 'cd "$1" && claude plugin validate . --json' _ "$T/src"
VALIDATE_OUT="$OUT"
VALIDATE_RC="$RC"
if [ "$VALIDATE_RC" -eq 0 ] && printf '%s' "$VALIDATE_OUT" | python3 -c '
import json, sys
d = json.load(sys.stdin)
m = d.get("manifest", {})
paths = [w.get("path") for w in m.get("warnings", [])]
sys.exit(0 if d.get("success") is True and not m.get("errors") and paths == ["plugins[0] plugin.json → version"] else 1)
'; then
  ok "claude plugin validate 가 오류 없이 통과하고 경고는 version 하나뿐이다"
else
  fail "claude plugin validate 결과가 기대와 다르다"
  printf '%s\n' "$VALIDATE_OUT"
fi

run claude plugin marketplace add "$FAKE_URL"
if [ "$RC" -ne 0 ]; then
  fail "마켓플레이스 등록이 실패했다 (종료 코드 $RC)"
  printf '%s\n' "$OUT"
fi
run claude plugin install "$PLUGIN_ID"
if [ "$RC" -ne 0 ]; then
  fail "플러그인 설치가 실패했다 (종료 코드 $RC)"
  printf '%s\n' "$OUT"
fi

# 설치 상태
run claude plugin list
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "$PLUGIN_ID" && printf '%s' "$OUT" | grep -q "enabled"; then
  ok "설치 상태: $PLUGIN_ID 가 enabled 이다"
else
  fail "설치 상태: claude plugin list 에 $PLUGIN_ID 와 enabled 가 없다"
  printf '%s\n' "$OUT"
fi

# 스킬 인식
run claude plugin details "$PLUGIN_ID"
SKILLS_LINE="$(printf '%s\n' "$OUT" | grep -E 'Skills \([0-9]+\)' | head -n 1 || true)"
COUNT="$(printf '%s' "$SKILLS_LINE" | sed -n 's/.*Skills (\([0-9][0-9]*\)).*/\1/p')"
MISSING_NAMES=""
for name in "${SKILLS[@]}"; do
  case "$SKILLS_LINE" in *"$name"*) ;; *) MISSING_NAMES="$MISSING_NAMES $name" ;; esac
done
if [ "$RC" -eq 0 ] && [ "$COUNT" = "$EXPECTED" ] && [ -z "$MISSING_NAMES" ]; then
  ok "스킬 인식: ${COUNT}개가 모두 인식된다"
else
  fail "스킬 인식: 기대 ${EXPECTED}개, 인식 ${COUNT:-없음}개, 빠진 이름:${MISSING_NAMES:- 없음}"
  printf '%s\n' "$OUT"
fi

# 캐시 디렉터리
CACHE_ROOT="$CLAUDE_CONFIG_DIR/plugins/cache/fos-skills/fos-skills"
CACHE=""
CACHE_COUNT=0
if [ -d "$CACHE_ROOT" ]; then
  for d in "$CACHE_ROOT"/*; do
    [ -d "$d" ] || continue
    CACHE="$d"
    CACHE_COUNT=$((CACHE_COUNT + 1))
  done
fi
if [ "$CACHE_COUNT" -eq 1 ] && printf '%s' "$(basename "$CACHE")" | grep -Eq '^[0-9a-f]{12}$'; then
  ok "캐시 디렉터리: $(basename "$CACHE")"
else
  fail "캐시 디렉터리: $CACHE_ROOT 아래에 16진수 12자리 디렉터리가 하나여야 한다 (발견 ${CACHE_COUNT}개)"
  CACHE=""
fi

if [ -z "$CACHE" ]; then
  # 캐시가 없으면 이후 검사는 의미가 없다.
  fail "스킬 파일, 형제 참조, 검사기 탐색, 도구, 스크립트 실행, 링크 없음 검사를 할 수 없다"
else
  # 스킬 파일
  NO_SKILL_MD=""
  for name in "${SKILLS[@]}"; do
    [ -f "$CACHE/$name/SKILL.md" ] || NO_SKILL_MD="$NO_SKILL_MD $name"
  done
  if [ -z "$NO_SKILL_MD" ]; then
    ok "스킬 파일: ${EXPECTED}개 모두 SKILL.md 가 있다"
  else
    fail "스킬 파일: SKILL.md 가 없는 스킬:$NO_SKILL_MD"
  fi

  # 형제 참조
  if [ -f "$CACHE/content-preview/../korean-check/references/review-axes.md" ]; then
    ok "형제 참조: content-preview 에서 korean-check/references/review-axes.md 로 닿는다"
  else
    fail "형제 참조: content-preview/../korean-check/references/review-axes.md 가 없다"
  fi

  # 검사기 탐색
  EXPECT_CHECK="$(cd "$CACHE/korean-check" && pwd -P)"
  run env KOREAN_CHECK= bash "$CACHE/content-preview/scripts/style-check.sh" --where
  if [ "$RC" -eq 0 ] && [ "$(cd "$OUT" 2>/dev/null && pwd -P)" = "$EXPECT_CHECK" ]; then
    ok "검사기 탐색: style-check.sh --where 가 설치된 korean-check 를 가리킨다"
  else
    fail "검사기 탐색: 기대 $EXPECT_CHECK, 실제 '$OUT' (종료 코드 $RC)"
  fi

  # 도구
  if [ -f "$CACHE/tools/browser-driver/browser_driver.py" ] && [ -x "$CACHE/tools/browser-driver/browser_driver.py" ]; then
    ok "도구: tools/browser-driver/browser_driver.py 가 있고 실행 권한이 있다"
  else
    fail "도구: tools/browser-driver/browser_driver.py 가 없거나 실행 권한이 없다"
  fi

  # 스크립트 실행
  run python3 "$CACHE/planning/scripts/verify_task.py" --help
  if [ "$RC" -eq 0 ]; then
    ok "스크립트 실행: planning/scripts/verify_task.py --help 가 종료 코드 0 이다"
  else
    fail "스크립트 실행: verify_task.py --help 가 종료 코드 $RC 로 끝났다"
    printf '%s\n' "$OUT"
  fi

  # 링크 없음
  LINKS="$(find "$CACHE" -type l)"
  if [ -z "$LINKS" ]; then
    ok "링크 없음: 캐시에 심볼릭 링크가 없다"
  else
    fail "링크 없음: 캐시에 심볼릭 링크가 있다"
    printf '%s\n' "$LINKS"
  fi
fi

if [ "$FAILS" -gt 0 ]; then
  echo "실패 $FAILS 건"
  exit 1
fi
echo "통과"
