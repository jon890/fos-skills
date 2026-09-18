#!/usr/bin/env bash
# 원격 브랜치까지 훑어 이미 쓰인 plan 번호와 다음 번호를 낸다.
#
# 왜 로컬만 보면 안 되나 (실측):
#   tasks/ 의 로컬 목록이 plan5, plan6, plan7 이라 다음이 plan8 로 보였으나,
#   main 에 머지되지 않은 원격 브랜치 셋에 plan8 이 이미 있었다.
#   그 브랜치를 체크아웃하지 않으면 로컬 작업 트리에 나타나지 않는다.
#
# 사용법:
#   plan_number.sh [<tasks 디렉터리>]
#
# cwd 는 그 저장소 안이어야 한다. 디렉터리 인자를 생략하면 tasks 를 본다.
# 브랜치 20개 남짓인 저장소에서 3초쯤 걸린다 (실측). ref 마다 ls-tree 를 한 번 부른다.
#
# 종료 코드:
#   0  훑기 성공. 마지막 줄이 다음 번호다
#   2  저장소가 아니거나 fetch 가 실패했다

set -euo pipefail

TASKS_DIR="${1:-tasks}"

git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "git 저장소가 아니다: $PWD" >&2
  exit 2
}

# fetch 없이 훑으면 다른 세션이 방금 올린 브랜치를 보지 못한다.
git fetch --all --quiet || {
  echo "git fetch 가 실패했다. 원격을 보지 못한 번호는 신뢰할 수 없다." >&2
  exit 2
}

# ref 마다 한 번만 훑어 `번호 ref` 줄을 모은다.
# ls-tree 는 체크아웃 없이 그 ref 의 트리를 읽으므로 작업 트리를 건드리지 않는다.
#
# `sort -n -u` 를 쓰지 않는다. `-n` 은 첫 숫자 필드로만 비교해서
# 같은 번호를 쥔 다른 ref 를 중복으로 보고 지운다 (실측: plan8 의 ref 넷이 하나로 줄었다).
PAIRS=$(
  for ref in HEAD $(git branch -a --format='%(refname:short)' | grep -v 'HEAD$'); do
    git ls-tree -d --name-only "$ref" "$TASKS_DIR/" 2>/dev/null \
      | sed -n "s|^${TASKS_DIR}/plan\([0-9]\{1,\}\)-.*|\1 ${ref}|p"
  done | sort -u | sort -n -s -k1,1
)

if [ -z "$PAIRS" ]; then
  echo "쓰인 번호가 없다"
  echo "다음 번호: 1"
  exit 0
fi

# main 에 있는 번호는 이미 끝난 계획이다. 판단이 필요한 것은 main 밖에만 있는 번호다.
MAIN_REF=$(git rev-parse --verify --quiet origin/main >/dev/null 2>&1 && echo origin/main || echo HEAD)
MAIN_NUMS=$(git ls-tree -d --name-only "$MAIN_REF" "$TASKS_DIR/" 2>/dev/null \
  | sed -n "s|^${TASKS_DIR}/plan\([0-9]\{1,\}\)-.*|\1|p" | sort -n -u)

echo "쓰인 번호:"
for n in $(echo "$PAIRS" | awk '{print $1}' | sort -n -u); do
  if echo "$MAIN_NUMS" | grep -qx "$n"; then
    printf '  plan%-4s %s 안에 있다\n' "$n" "$MAIN_REF"
  else
    refs=$(echo "$PAIRS" | awk -v n="$n" '$1 == n {print $2}' | paste -sd' ' -)
    printf '  plan%-4s %s 밖에만 있다: %s\n' "$n" "$MAIN_REF" "$refs"
  fi
done

echo "다음 번호: $(( $(echo "$PAIRS" | awk '{print $1}' | sort -n | tail -1) + 1 ))"
