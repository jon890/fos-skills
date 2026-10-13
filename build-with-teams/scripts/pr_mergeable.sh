#!/usr/bin/env bash
# PR 을 만든 직후 기준 브랜치와 충돌하는지 확인한다.
#
# 충돌은 PR 을 만든 순간에 이미 정해지지만, 확인하지 않으면 리뷰나 머지 단계에서야 드러난다.
# GitHub 는 생성 직후 mergeable 을 UNKNOWN 으로 두고 뒤에서 계산하므로, 값이 정해질 때까지 다시 묻는다.
#
# 사용법 (cwd: 대상 저장소 안):
#   pr_mergeable.sh <PR번호> [--tries <n>] [--interval <초>]
#
#   --tries     UNKNOWN 일 때 다시 묻는 횟수. 기본 10
#   --interval  다시 묻기 전 기다리는 초. 기본 3
#
# 출력: `mergeable=<값> mergeStateStatus=<값>` 한 줄
#
# 종료 코드:
#   0  충돌 없음 (MERGEABLE). 보호 규칙의 BLOCKED 는 충돌이 아니라 0 이다
#   1  충돌 (mergeable CONFLICTING 또는 mergeStateStatus DIRTY)
#   2  조회 실패, 또는 횟수를 다 써도 UNKNOWN
set -u

pr="" tries=10 interval=3
while [ $# -gt 0 ]; do
  case "$1" in
    --tries) tries="${2:-}"; shift 2 ;;
    --interval) interval="${2:-}"; shift 2 ;;
    -*) echo "pr_mergeable: 다루지 않는 옵션이다: $1" >&2; exit 2 ;;
    *) pr="$1"; shift ;;
  esac
done
[ -n "$pr" ] || { echo "pr_mergeable: PR 번호가 필요하다" >&2; exit 2; }

attempt=1
while :; do
  line="$(gh pr view "$pr" --json mergeable,mergeStateStatus \
    --jq '"mergeable=\(.mergeable) mergeStateStatus=\(.mergeStateStatus)"')" || {
    echo "pr_mergeable: gh pr view 가 실패했다" >&2; exit 2
  }
  case "$line" in
    *mergeable=CONFLICTING*|*mergeStateStatus=DIRTY*)
      echo "$line"
      echo "pr_mergeable: 기준 브랜치와 충돌한다. 기준 브랜치를 병합해 풀고 일반 push 로 올린다" >&2
      exit 1 ;;
    *mergeable=MERGEABLE*)
      echo "$line"
      exit 0 ;;
  esac
  if [ "$attempt" -ge "$tries" ]; then
    echo "$line"
    echo "pr_mergeable: $tries 번 물어도 값이 정해지지 않았다" >&2
    exit 2
  fi
  attempt=$((attempt + 1))
  sleep "$interval"
done
