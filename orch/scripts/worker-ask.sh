#!/usr/bin/env bash
# worker 가 코디네이터에게 묻고 답을 받는다. 답이 오기까지 오래 걸리므로 백그라운드로 돌린다.
#
# `orca orchestration ask` 는 답이 올 때까지 막혀, 에이전트 도구 호출의 시간 제한을 넘기면
# 질문은 남은 채 호출만 실패한다. Claude 는 Bash 의 run_in_background 로 돌리고 완료 알림을 기다린다.
# 백그라운드 실행이 없는 에이전트는 --timeout-ms 를 도구 시간 제한보다 짧게 주고,
# 종료 코드 4 면 같은 질문을 새로 만들지 않고 --resume 으로 다시 부른다.
#
# 이미 끝난 Dispatch 에서는 ask 가 실패한다. 그때는 Run 메일함으로 question 메시지를 보낸다.
# 답은 reply 가 아니라 코디네이터의 새 메시지로 오므로 `orca orchestration check` 로 읽는다.
#
# 사용법:
#   worker-ask.sh --from <handle> --question <text> [--options <csv>] [--run <run_id>] [--timeout-ms <n>]
#   worker-ask.sh --from <handle> --resume <message_id> [--timeout-ms <n>]
#
#   --run   ask 가 실패했을 때 보낼 Run. 없으면 `check --peek --json` 의 runId 를 쓴다
#   ORCA    orca 실행 파일. 기본값 orca
#
# 종료 코드:
#   0  답을 받았다. 답은 표준 출력에 있다
#   2  사용법 오류, 또는 ask 도 대신 보내기도 실패했다
#   3  ask 가 실패해 Run 메일함으로 대신 보냈다. 답은 check 로 읽는다
#   4  시간 제한으로 답을 받지 못했다. 질문은 남아 있다. 출력의 메시지 ID 로 --resume 한다
set -u

ORCA="${ORCA:-orca}"
from="" question="" options="" run="" resume="" timeout_ms="600000"

while [ $# -gt 0 ]; do
  case "$1" in
    --from) from="${2:-}"; shift 2 ;;
    --question) question="${2:-}"; shift 2 ;;
    --options) options="${2:-}"; shift 2 ;;
    --run) run="${2:-}"; shift 2 ;;
    --resume) resume="${2:-}"; shift 2 ;;
    --timeout-ms) timeout_ms="${2:-}"; shift 2 ;;
    *) echo "worker-ask: 다루지 않는 인자다: $1" >&2; exit 2 ;;
  esac
done

[ -n "$from" ] || { echo "worker-ask: --from 이 필요하다" >&2; exit 2; }
if [ -z "$question" ] && [ -z "$resume" ]; then
  echo "worker-ask: --question 이나 --resume 중 하나가 필요하다" >&2; exit 2
fi

# 배열로 모은다. 문자열 변수로 모으면 zsh 는 낱말로 나누지 않고 bash 는 질문의 공백에서 나눈다.
args=(orchestration ask --from "$from" --timeout-ms "$timeout_ms" --json)
if [ -n "$resume" ]; then
  args+=(--resume "$resume")
else
  args+=(--question "$question")
  [ -n "$options" ] && args+=(--options "$options")
fi

out="$("$ORCA" "${args[@]}" 2>&1)"
rc=$?

# 시간 제한은 종료 코드만으로 실패와 가를 수 없다. 출력의 timedOut 을 본다.
if printf '%s' "$out" | grep -Eq '"timedOut"[[:space:]]*:[[:space:]]*true|timed out'; then
  printf '%s\n' "$out"
  echo "worker-ask: 시간 제한으로 답을 받지 못했다. 위 출력의 메시지 ID 로 --resume 한다" >&2
  exit 4
fi

if [ "$rc" -eq 0 ]; then
  printf '%s\n' "$out"
  exit 0
fi

if [ -n "$resume" ]; then
  printf '%s\n' "$out" >&2
  echo "worker-ask: --resume 이 실패했다. 대신 보낼 질문 본문이 없어 멈춘다" >&2
  exit 2
fi

printf '%s\n' "$out" >&2
echo "worker-ask: ask 가 실패했다. Dispatch 가 끝났을 수 있어 Run 메일함으로 대신 보낸다" >&2

if [ -z "$run" ]; then
  run="$("$ORCA" orchestration check --terminal "$from" --peek --json 2>/dev/null \
    | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin)["result"]["runId"] or "")
except Exception:
    pass')"
fi
[ -n "$run" ] || { echo "worker-ask: Run 을 찾지 못했다. --run 으로 준다" >&2; exit 2; }

body="$question"
[ -n "$options" ] && body="$body
선택지: $options"

if "$ORCA" orchestration send --from "$from" --to "run:$run" --type question \
    --subject "질문 (ask 대신 보냄)" --body "$body" --json; then
  echo "worker-ask: run:$run 으로 보냈다. 답은 orca orchestration check --terminal $from 로 읽는다" >&2
  exit 3
fi
echo "worker-ask: 대신 보내기도 실패했다" >&2
exit 2
