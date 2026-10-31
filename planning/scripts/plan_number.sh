#!/usr/bin/env bash
# 원격 브랜치와 git 이력까지 훑어 이미 쓰인 plan 번호와 다음 번호를 낸다.
#
# 왜 로컬만 보면 안 되나:
#   main 에 머지되지 않은 원격 브랜치가 이미 다음 번호를 쓰고 있을 수 있다.
#   그 브랜치를 체크아웃하지 않으면 로컬 작업 트리의 tasks/ 에 나타나지 않는다.
#
# 왜 git 이력도 보나:
#   구현이 끝난 계획서는 지운다. 지운 뒤에는 어느 브랜치의 트리에도 없어서
#   트리만 보면 마지막 번호를 다시 내준다. 지운 계획서는 커밋 이력에만 남는다.
#
# 왜 PR 의 head 브랜치 이름도 보나:
#   같은 PR 안에서 계획서를 더하고 지운 뒤 squash 머지하면 main 이력에 계획서가 남지 않는다.
#   머지 후 원 브랜치를 지우면 git log --all 도 그 번호를 보지 못한다.
#   PR 목록은 브랜치를 지워도 남으므로 gh pr list --state all 의 headRefName 에서 번호를 읽는다.
#   기본 형식은 `{접두사}plan{N}-...` 와 `plan/{접두사}{N}-...` 두 가지다. 다른 형식은 읽지 못한다.
#   --name-regex 를 주면 브랜치 이름의 어느 `/` 뒤에서든 그 형식을 앞에서부터 맞춘다.
#   gh 가 없거나 실패하면 번호를 내되, 마지막 줄 앞에 PR 이력을 보지 못했다고 알린다.
#
# 사용법:
#   plan_number.sh [--tasks-dir DIR] [--prefix PREFIX | --name-regex REGEX] [--allow-empty] [DIR]
#
#   --tasks-dir   계획서를 담는 디렉터리. 저장소 루트 기준이다. 기본값 tasks
#                 이전 호출과 같이 첫 위치 인자로 줘도 된다
#   --prefix      plan 접두사. 모노레포에서 하위 프로젝트마다 번호를 따로 셀 때 쓴다
#                 `fe-` 면 `fe-plan{N}-*` 만 센다. 주지 않으면 접두사 없는 `plan{N}-*` 만 센다
#   --name-regex  저장소가 `plan{N}` 이 아닌 이름을 쓸 때 디렉터리 이름 형식을 정규식으로 준다.
#                 이름 앞에서부터 맞추고, 번호를 잡는 캡처 그룹이 정확히 하나다. `\d` 를 쓸 수 있다
#                 예: `--name-regex 'area-(\d{3})-'` 는 `tasks/area-032-foo/` 에서 32 를 읽는다
#                 접두사도 정규식에 넣으므로 --prefix 와 함께 쓰지 않는다
#   --allow-empty tasks 이력이 있는데 읽은 번호가 0개여도 1 을 낸다. 다른 하위 프로젝트의 계획만 있는 정상 상태용이다
#
# cwd 는 그 저장소 안이어야 한다.
# 번호는 앞의 0 을 떼고 센다. `plan027` 은 27 이다. 자릿수 맞춤은 저장소 관례를 따른다.
# git 은 이력 조회 한 번(`git log --all --full-history -- tasks`)과 main 트리 조회 한 번만 부른다.
# 그래서 main 밖의 계획이 어느 ref 에 있는지는 이력에서 가장 최근 커밋이 닿은 ref 로 근사한다.
#
# 종료 코드:
#   0  훑기 성공. 마지막 줄이 다음 번호다
#   2  인자가 잘못됐거나, 저장소가 아니거나, fetch 가 실패했다.
#      또는 tasks 이력에 계획 디렉터리가 있는데 이름 형식으로 해석한 번호가 0개다(형식이 저장소와 다르다)

set -euo pipefail

TASKS_DIR=tasks
PREFIX=""
NAME_REGEX=""
ALLOW_EMPTY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tasks-dir) TASKS_DIR="${2:?--tasks-dir 에 값이 없다}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix 에 값이 없다}"; shift 2 ;;
    --name-regex) NAME_REGEX="${2:?--name-regex 에 값이 없다}"; shift 2 ;;
    --allow-empty) ALLOW_EMPTY=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ {sub(/^# ?/, ""); print; next} NR > 1 {exit}' "$0"; exit 0 ;;
    -*) echo "모르는 옵션: $1" >&2; exit 2 ;;
    *) TASKS_DIR="$1"; shift ;;
  esac
done
TASKS_DIR="${TASKS_DIR%/}"

if [ -n "$NAME_REGEX" ] && [ -n "$PREFIX" ]; then
  echo "--name-regex 와 --prefix 는 함께 쓰지 않는다. 접두사는 정규식에 넣는다" >&2
  exit 2
fi
# 접두사는 정규식 안에서 escape 해 쓰지만 디렉터리 이름 규칙에 맞는 문자만 받는다.
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

# 이력은 한 번만 읽는다. ref 마다 git 을 따로 부르지 않는다(원격 ref 가 수백 개인 저장소에서 수 분이 걸렸다).
# --full-history: 머지 전후 경로가 모두 없어도 중간에 지운 계획서를 빠뜨리지 않는다.
# 번호를 읽고 출력하는 일은 plan_numbers.py 가 한다.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git -c core.quotepath=off log --all --full-history --no-renames --name-status --format='%x01%S' -- "$TASKS_DIR" \
  > "$WORK/log" 2>/dev/null || : > "$WORK/log"

# main 에 있는 번호는 머지됐지만 아직 지우지 않은 계획이다. 판단이 필요한 것은 main 밖에만 있는 번호다.
MAIN_REF=$(git rev-parse --verify --quiet origin/main >/dev/null 2>&1 && echo origin/main || echo HEAD)
git -c core.quotepath=off ls-tree -d --name-only "$MAIN_REF" "$TASKS_DIR/" > "$WORK/main-tree" 2>/dev/null || : > "$WORK/main-tree"

# 브랜치 이름은 `fe-plan027-login` 이나 `plan/fe-027-login` 이다. 앞에 `feature/` 같은 디렉터리가 붙어도 읽는다.
HEADS_ARGS=()
if gh pr list --state all --limit 1000 --json headRefName --jq '.[].headRefName' > "$WORK/heads" 2>/dev/null; then
  HEADS_ARGS=(--heads "$WORK/heads")
fi

ARGS=(--tasks-dir "$TASKS_DIR" --log "$WORK/log" --main-tree "$WORK/main-tree" --main-ref "$MAIN_REF")
[ -z "$NAME_REGEX" ] || ARGS+=(--name-regex "$NAME_REGEX")
[ -z "$PREFIX" ] || ARGS+=(--prefix "$PREFIX")
[ "$ALLOW_EMPTY" = 0 ] || ARGS+=(--allow-empty)

python3 "$(dirname "$0")/plan_numbers.py" "${ARGS[@]}" ${HEADS_ARGS[@]+"${HEADS_ARGS[@]}"}
