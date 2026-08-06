#!/usr/bin/env bash
#
# 지침이 금지하는 대상을 다른 수단이 실제로 막는지 판정한다.
#
# "이미 lint 가 잡으니 문장 지침은 지워도 된다" 는 판단은 자주 틀린다.
# 막는다고 믿은 수단에 구멍이 있으면, 유일한 지침을 지운 셈이 된다.
#
# Usage:
#   check_enforcement.sh <repo> gitignore <경로>
#   check_enforcement.sh <repo> lint <probe 파일 경로> '<probe 내용>' '<lint 명령>'
#   check_enforcement.sh <repo> tools <agent 정의 파일>
#
set -u

REPO="${1:-}"
MODE="${2:-}"
[ -n "$REPO" ] && [ -n "$MODE" ] || { sed -n '3,14p' "$0"; exit 2; }
cd "$REPO" || exit 2

case "$MODE" in

gitignore)
  TARGET="${3:?경로를 지정하라}"
  echo "대상: $TARGET"
  if out=$(git check-ignore -v "$TARGET" 2>&1); then
    echo "막힌다 — $out"
    echo "판정: gitignore 가 강제한다. 같은 내용의 문장 지침은 지울 수 있다."
    exit 0
  fi
  echo "막히지 않는다 (git check-ignore 히트 없음)"
  echo "판정: gitignore 가 강제하지 않는다. 문장 지침을 남기거나 gitignore 를 고친다."
  exit 1
  ;;

lint)
  PROBE="${3:?probe 파일 경로를 지정하라}"
  BODY="${4:?probe 내용을 지정하라}"
  CMD="${5:?lint 명령을 지정하라}"
  [ -e "$PROBE" ] && { echo "이미 있는 파일이다 — 다른 경로를 쓰라: $PROBE" >&2; exit 2; }

  # probe 는 lint 가 실제로 훑는 위치에 놓아야 한다. 설정의 include 범위 밖이면 통과가 당연하다.
  mkdir -p "$(dirname "$PROBE")"
  printf '%s\n' "$BODY" > "$PROBE"
  trap 'rm -f "$PROBE"' EXIT

  echo "probe: $PROBE"
  echo "명령: $CMD"
  echo "---"
  eval "$CMD" 2>&1 | tail -30
  code=${PIPESTATUS[0]}
  echo "---"
  echo "exit code: $code"

  if [ "$code" -ne 0 ]; then
    echo "판정: lint 가 probe 를 잡는다. 같은 내용의 문장 지침은 지울 수 있다."
    exit 0
  fi
  echo "판정: lint 가 통과시킨다. 규칙이 없거나 probe 위치가 검사 범위 밖이다."
  echo "      규칙 설정을 확인하고, 없으면 문장 지침을 남긴다."
  exit 1
  ;;

tools)
  AGENT="${3:?agent 정의 파일을 지정하라}"
  [ -f "$AGENT" ] || { echo "파일이 없다: $AGENT" >&2; exit 2; }
  echo "대상: $AGENT"
  FM=$(sed -n '/^---$/,/^---$/p' "$AGENT")
  printf '%s\n' "$FM" | grep -iE '^(tools|disallowedTools|allowed-tools):' \
    || echo "  (도구 제한 선언 없음 — 전체 도구 사용 가능)"
  echo "---"

  # 허용 목록과 금지 목록을 모두 본다. 허용 목록만 보고 판정하면 반대 결론이 난다.
  ALLOW=$(printf '%s\n' "$FM" | grep -iE '^(tools|allowed-tools):' | sed 's/^[^:]*://')
  DENY=$(printf '%s\n' "$FM" | grep -iE '^disallowedTools:' | sed 's/^[^:]*://')

  # 파일을 고칠 수 있는 우회 경로. Write/Edit 만 막아도 이들 중 하나가 남으면 못 막는다.
  bypass=0
  for t in Bash Agent Task NotebookEdit; do
    if [ -n "$ALLOW" ]; then
      case "$ALLOW" in
        *"*"*) ;;                                                    # 전체 허용
        *) printf '%s' "$ALLOW" | grep -qw "$t" || continue ;;       # 허용 목록 밖이면 애초에 못 쓴다
      esac
    fi
    printf '%s' "$DENY" | grep -qw "$t" && continue
    echo "  우회 가능: $t"
    bypass=$((bypass + 1))
  done

  echo "---"
  if [ "$bypass" -eq 0 ]; then
    echo "판정: 파일을 고칠 도구가 남아 있지 않다. 도구 제한이 강제한다."
    exit 0
  fi
  echo "판정: 위 도구로 우회할 수 있어 도구 제한이 파일 수정을 막지 못한다."
  echo "      (예: Bash 의 리다이렉트로 Write 없이 파일을 덮어쓸 수 있다)"
  echo "      문장 지침을 지우지 않는다."
  exit 1
  ;;

*)
  echo "알 수 없는 모드: $MODE" >&2
  sed -n '3,14p' "$0" >&2
  exit 2
  ;;
esac
