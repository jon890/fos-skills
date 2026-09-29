#!/usr/bin/env bash
# 원격 브랜치와 git 이력까지 훑어 이미 쓰인 plan 번호와 다음 번호를 낸다.
#
# 왜 로컬만 보면 안 되나 (실측):
#   tasks/ 의 로컬 목록이 plan5, plan6, plan7 이라 다음이 plan8 로 보였으나,
#   main 에 머지되지 않은 원격 브랜치 셋에 plan8 이 이미 있었다.
#   그 브랜치를 체크아웃하지 않으면 로컬 작업 트리에 나타나지 않는다.
#
# 왜 git 이력도 보나:
#   구현이 끝난 계획서는 지운다. 지운 뒤에는 어느 브랜치의 트리에도 없어서
#   트리만 보면 마지막 번호를 다시 내준다. 지운 계획서는 커밋 이력에만 남는다.
#
# 사용법:
#   plan_number.sh [--tasks-dir DIR] [--prefix PREFIX] [DIR]
#
#   --tasks-dir  계획서를 담는 디렉터리. 저장소 루트 기준이다. 기본값 tasks
#                이전 호출과 같이 첫 위치 인자로 줘도 된다
#   --prefix     plan 접두사. 모노레포에서 하위 프로젝트마다 번호를 따로 셀 때 쓴다
#                `fe-` 면 `fe-plan{N}-*` 만 센다. 주지 않으면 접두사 없는 `plan{N}-*` 만 센다
#
# cwd 는 그 저장소 안이어야 한다.
# 번호는 앞의 0 을 떼고 센다. `plan027` 은 27 이다. 자릿수 맞춤은 저장소 관례를 따른다.
# 브랜치 20개 남짓인 저장소에서 3초쯤 걸린다 (실측). ref 마다 ls-tree 를 한 번 부른다.
#
# 종료 코드:
#   0  훑기 성공. 마지막 줄이 다음 번호다
#   2  인자가 잘못됐거나, 저장소가 아니거나, fetch 가 실패했다

set -euo pipefail

TASKS_DIR=tasks
PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tasks-dir) TASKS_DIR="${2:?--tasks-dir 에 값이 없다}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix 에 값이 없다}"; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ {sub(/^# ?/, ""); print; next} NR > 1 {exit}' "$0"; exit 0 ;;
    -*) echo "모르는 옵션: $1" >&2; exit 2 ;;
    *) TASKS_DIR="$1"; shift ;;
  esac
done
TASKS_DIR="${TASKS_DIR%/}"

# 접두사와 경로는 sed 정규식에 들어간다. 메타 문자가 섞이면 엉뚱한 디렉터리를 센다.
case "$PREFIX" in
  *[!A-Za-z0-9_-]*) echo "접두사는 영문, 숫자, -, _ 만 쓴다: $PREFIX" >&2; exit 2 ;;
esac
case "$TASKS_DIR" in
  ''|*[!A-Za-z0-9_./-]*) echo "tasks 경로는 영문, 숫자, -, _, ., / 만 쓴다: $TASKS_DIR" >&2; exit 2 ;;
esac

git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "git 저장소가 아니다: $PWD" >&2
  exit 2
}

# fetch 없이 훑으면 다른 세션이 방금 올린 브랜치를 보지 못한다.
git fetch --all --quiet || {
  echo "git fetch 가 실패했다. 원격을 보지 못한 번호는 신뢰할 수 없다." >&2
  exit 2
}

NAME_RE="${PREFIX}plan\([0-9]\{1,\}\)-"

# ref 마다 한 번만 훑어 `번호 ref` 줄을 모은다.
# ls-tree 는 체크아웃 없이 그 ref 의 트리를 읽으므로 작업 트리를 건드리지 않는다.
#
# `sort -n -u` 를 쓰지 않는다. `-n` 은 첫 숫자 필드로만 비교해서
# 같은 번호를 쥔 다른 ref 를 중복으로 보고 지운다 (실측: plan8 의 ref 넷이 하나로 줄었다).
PAIRS=$(
  for ref in HEAD $(git branch -a --format='%(refname:short)' | grep -v 'HEAD$'); do
    git ls-tree -d --name-only "$ref" "$TASKS_DIR/" 2>/dev/null \
      | sed -n "s|^${TASKS_DIR}/${NAME_RE}.*|\1 ${ref}|p"
  done | awk '{print $1 + 0, $2}' | sort -u | sort -n -s -k1,1
)

# 지운 계획서는 트리에 없고 그것을 더한 커밋에만 남는다. --all 이라 머지되지 않은 브랜치도 본다.
HISTORY_NUMS=$(
  git log --all --format= --name-only -- "$TASKS_DIR/*/index.json" 2>/dev/null \
    | sed -n "s|^${TASKS_DIR}/${NAME_RE}[^/]*/index\.json$|\1|p" | awk '{print $1 + 0}' | sort -n -u
)

ALL_NUMS=$( { echo "$PAIRS" | awk 'NF {print $1}'; echo "$HISTORY_NUMS"; } | awk 'NF' | sort -n -u)

if [ -z "$ALL_NUMS" ]; then
  echo "쓰인 번호가 없다"
  echo "다음 번호: 1"
  exit 0
fi

# main 에 있는 번호는 머지됐지만 아직 지우지 않은 계획이다. 판단이 필요한 것은 main 밖에만 있는 번호다.
MAIN_REF=$(git rev-parse --verify --quiet origin/main >/dev/null 2>&1 && echo origin/main || echo HEAD)
MAIN_NUMS=$(git ls-tree -d --name-only "$MAIN_REF" "$TASKS_DIR/" 2>/dev/null \
  | sed -n "s|^${TASKS_DIR}/${NAME_RE}.*|\1|p" | awk '{print $1 + 0}' | sort -n -u)

echo "쓰인 번호:"
for n in $ALL_NUMS; do
  label="${PREFIX}plan${n}"
  refs=$(echo "$PAIRS" | awk -v n="$n" '$1 == n {print $2}' | paste -sd' ' -)
  if echo "$MAIN_NUMS" | grep -qx "$n"; then
    printf '  %-12s %s 안에 있다\n' "$label" "$MAIN_REF"
  elif [ -n "$refs" ]; then
    printf '  %-12s %s 밖에만 있다: %s\n' "$label" "$MAIN_REF" "$refs"
  else
    printf '  %-12s 지워졌고 git 이력에만 있다\n' "$label"
  fi
done

echo "다음 번호: $(( $(echo "$ALL_NUMS" | tail -1) + 1 ))"
