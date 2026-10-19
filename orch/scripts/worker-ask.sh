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
# 묻기 전에 읽지 않은 코디네이터 메시지가 있으면 묻지 않고 그 메시지를 낸다(종료 코드 5).
# 코디네이터가 이미 답이나 방향을 status 로 보냈는데 같은 것을 다시 묻고 30분을 기다린 일이 있었다.
# 한 번 보여 준 메시지는 ORCH_ASK_SEEN 파일(기본 $TMPDIR/orch-worker-ask-<handle>.seen)에 적어 다시 막지 않는다.
# 그래서 읽고도 물어야 하면 같은 명령을 다시 부르면 된다. --force 는 확인 없이 바로 묻는다.
#
# 코디네이터는 ask 에 reply 하지 않고 status 로 답하기도 한다. 그러면 ask 는 시간 제한까지 기다린다.
# 시간 제한으로 끝나면 읽지 않은 메시지에서 그 질문 스레드나 이 Dispatch 로 온 status 를 찾아 답으로 낸다.
#
# 사용법:
#   worker-ask.sh --from <handle> --question <text> [--options <csv>] [--run <run_id>] [--timeout-ms <n>] [--force]
#   worker-ask.sh --from <handle> --resume <message_id> [--timeout-ms <n>]
#
#   --run   ask 가 실패했을 때 보낼 Run. 없으면 `check --peek --json` 의 runId 를 쓴다
#   --force 읽지 않은 메시지가 있어도 묻는다
#   ORCA    orca 실행 파일. 기본값 orca
#
# 답을 받으면 표준 출력 첫 줄이 `answer: <본문>` 이다. 그 뒤에 원래 JSON 이 온다. `head -n 1` 로 읽는다.
#
# 종료 코드:
#   0  답을 받았다. 첫 줄이 `answer: <본문>` 이다
#   2  사용법 오류, 또는 ask 도 대신 보내기도 실패했다
#   3  답이 ask 가 아닌 메시지로 왔거나 올 것이다. 첫 줄이 `answer: ` 면 시간 제한 뒤 찾은 status 답이고,
#      아니면 ask 가 실패해 Run 메일함으로 대신 보낸 것이니 답은 check 로 읽는다
#   4  시간 제한으로 답을 받지 못했다. 질문은 남아 있다. 출력의 메시지 ID 로 --resume 한다
#   5  처음 보는 읽지 않은 코디네이터 메시지가 있어 묻지 않았다. 표준 출력에 그 메시지가 있다. 다시 부르면 묻는다
set -u

ORCA="${ORCA:-orca}"
JSON="$(dirname "$0")/ask-json.py"
from="" question="" options="" run="" resume="" timeout_ms="600000" force=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from) from="${2:-}"; shift 2 ;;
    --question) question="${2:-}"; shift 2 ;;
    --options) options="${2:-}"; shift 2 ;;
    --run) run="${2:-}"; shift 2 ;;
    --resume) resume="${2:-}"; shift 2 ;;
    --timeout-ms) timeout_ms="${2:-}"; shift 2 ;;
    --force) force=1; shift ;;
    *) echo "worker-ask: 다루지 않는 인자다: $1" >&2; exit 2 ;;
  esac
done

[ -n "$from" ] || { echo "worker-ask: --from 이 필요하다" >&2; exit 2; }
if [ -z "$question" ] && [ -z "$resume" ]; then
  echo "worker-ask: --question 이나 --resume 중 하나가 필요하다" >&2; exit 2
fi

peek() { "$ORCA" orchestration check --terminal "$from" --peek --json 2>/dev/null; }

if [ -z "$resume" ] && [ "$force" = 0 ]; then
  seen="${ORCH_ASK_SEEN:-${TMPDIR:-/tmp}/orch-worker-ask-$from.seen}"
  unread="$(peek | python3 "$JSON" unread --from "$from" --seen "$seen")"
  if [ -n "$unread" ]; then
    printf '%s\n' "$unread"
    echo "worker-ask: 읽지 않은 코디네이터 메시지가 있어 묻지 않았다. 위 메시지를 읽고도 물어야 하면 같은 명령을 다시 부른다" >&2
    exit 5
  fi
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
  asked="$(printf '%s' "$out" | python3 "$JSON" message-id)"
  reply="$(peek | python3 "$JSON" reply --from "$from" --question "${asked:-$resume}")"
  if [ -n "$reply" ]; then
    printf 'answer: %s\n' "$reply"
    printf '%s\n' "$out"
    echo "worker-ask: ask 에는 답이 없지만 코디네이터가 status 로 답했다. 첫 줄이 그 본문이다" >&2
    exit 3
  fi
  printf '%s\n' "$out"
  echo "worker-ask: 시간 제한으로 답을 받지 못했다. 위 출력의 메시지 ID 로 --resume 한다" >&2
  exit 4
fi

if [ "$rc" -eq 0 ]; then
  printf 'answer: %s\n' "$(printf '%s' "$out" | python3 "$JSON" answer)"
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

[ -n "$run" ] || run="$(peek | python3 "$JSON" run-id)"
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
