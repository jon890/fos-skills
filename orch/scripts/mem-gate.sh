#!/usr/bin/env bash
# macOS 에 메모리 여유가 생길 때까지 기다린다. worker 여럿이 로컬 CI, 브라우저, 무거운 테스트를 함께 돌리다
# 48GB 머신이 꺼진 일이 있었다. 무거운 검사를 띄우기 전에 이것을 앞에 둔다.
#
# 사용법:
#   mem-gate.sh                기다리기만 한다
#   mem-gate.sh -- <명령...>   기다린 뒤 그 명령을 실행하고 그 종료 코드로 끝난다(시간 초과면 실행하지 않고 1)
#
#   도구 시간 제한(120초, 600초)에 걸리지 않게 Bash 의 run_in_background 로 띄운다.
#   앞단에 따로 돌리면 기다리다 같은 줄의 다음 명령까지 exit 144 로 끝난다.
#
# 판정:
#   free 가 EASY_FREE_PCT 이상이면 통과한다.
#   아니면 free 가 MIN_FREE_PCT 이상이고 swap 사용량이 MAX_SWAP_MB 이하일 때 통과한다.
#   swap 은 free 가 EASY_FREE_PCT 아래일 때만 본다. macOS 는 메모리가 풀린 뒤에도 swap 을 잡아 두어
#   (free 50% 에 swap 13GB 가 남은 일이 있었다) swap 만으로는 지금 압박인지 알 수 없다.
#   free 는 `memory_pressure` 의 free percentage, swap 은 `sysctl -n vm.swapusage` 의 used 다.
#
# 환경 변수 (기본값):
#   EASY_FREE_PCT 37   MIN_FREE_PCT 35   MAX_SWAP_MB 10240   MAX_WAIT 3600(초)   POLL 30(초)
#
# 출력: 기다릴 때마다 stderr 에 한 줄(`mem-gate: waiting ...`), 통과하면 `mem-gate: ok ...`, 시간 초과면 `mem-gate: timeout ...`
#
# 종료 코드:
#   0  통과했다(명령을 줬으면 그 명령의 종료 코드)
#   1  MAX_WAIT 를 넘겼다. 명령은 실행하지 않았다
set -u
cmd=(); if [ "${1:-}" = "--" ]; then shift; cmd=("$@"); fi
EASY_FREE_PCT=${EASY_FREE_PCT:-37}; MIN_FREE_PCT=${MIN_FREE_PCT:-35}; MAX_SWAP_MB=${MAX_SWAP_MB:-10240}; MAX_WAIT=${MAX_WAIT:-3600}; POLL=${POLL:-30}
free_pct() { memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{gsub("%","",$2); print $2+0}'; }
swap_mb() { sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/' | awk '{print int($1)}'; }
waited=0
while :; do
  f=$(free_pct); s=$(swap_mb)
  if [ "${f:-0}" -ge "$EASY_FREE_PCT" ] || { [ "${f:-0}" -ge "$MIN_FREE_PCT" ] && [ "${s:-0}" -le "$MAX_SWAP_MB" ]; }; then
    echo "mem-gate: ok free=${f}% swap=${s}MB" >&2; [ ${#cmd[@]} -gt 0 ] && exec "${cmd[@]}"; exit 0
  fi
  [ "$waited" -ge "$MAX_WAIT" ] && { echo "mem-gate: timeout free=${f}% swap=${s}MB" >&2; exit 1; }
  echo "mem-gate: waiting free=${f}% swap=${s}MB (need >=${MIN_FREE_PCT}% and <=${MAX_SWAP_MB}MB)" >&2
  sleep "$POLL"; waited=$((waited + POLL))
done
