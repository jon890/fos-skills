#!/usr/bin/env bash
# 사용: merge-queue.sh [옵션] PR[:머지 전 명령] ...
#
# 받은 순서대로 PR 을 하나씩 머지한다. 한 PR 이라도 조건에 못 미치면 이유를 찍고 종료 코드 1 로 멈춘다.
# PR 마다 하는 일:
#   1. 이미 MERGED 면 건너뛴다. OPEN 이 아니면 멈춘다
#   2. 체크가 모두 끝날 때까지 기다린다(--check-timeout 분까지)
#   3. 실패한 체크, 미해결 리뷰 스레드, 충돌이 있으면 멈춘다. mergeable 이 UNKNOWN 이면 몇 번 다시 묻는다
#   4. 머지 전 명령이 있으면 돌리고, 0 이 아니면 멈춘다(DB 백업 같은 것)
#   5. 체크를 보기 전에 읽어 둔 HEAD 와 지금 PR HEAD, 원격 브랜치 HEAD 가 모두 같은지 본다.
#      검사나 머지 전 명령이 도는 사이에 push 된 커밋이 검사 없이 머지되는 것을 막는다
#   6. 처음 읽은 HEAD 로 --match-head-commit 머지하고 MERGED 를 확인한 뒤 원격을 fetch 하고 원격 브랜치를 지운다.
#      fork PR, release/* 브랜치, 다른 열린 PR 의 base 인 브랜치는 지우지 않는다
#
# origin 은 PR 이 속한 저장소를 가리켜야 한다. fork 를 origin 으로 둔 체크아웃에서는 HEAD 대조가 STOP 으로 끝난다.
#
# 옵션
#   --repo DIR            대상 저장소 경로. 기본은 현재 디렉터리. gh 호스트와 저장소는 이 저장소의 origin 이 정한다
#   --before CMD          모든 PR 에 쓸 머지 전 명령. `PR:명령` 으로 준 PR 은 그 명령을 쓴다
#   --method M            merge | squash | rebase. 기본 merge
#   --threads-cmd CMD     미해결 스레드 수를 정수로 내는 명령. 기본은 형제 스킬 review-fix 의 review_threads.py
#   --check-timeout MIN   체크 대기 한도(분). 기본 60
#   --keep-branch         머지 뒤 원격 브랜치를 지우지 않는다
#
# 머지 전 명령과 --threads-cmd 는 bash -c 로 돈다. 환경 변수 PR(번호), BRANCH(head 브랜치), OWNER, REPO 를 받는다.
# 예: merge-queue.sh 101 102:'./bin/backup-db.sh orders "pr-$PR"' 103
#
# 종료 코드: 0 모두 머지(또는 이미 MERGED), 1 어느 PR 에서 멈춤, 2 사용법 오류
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=.
BEFORE_ALL=""
METHOD=merge
THREADS_CMD=""
CHECK_TIMEOUT=60
KEEP_BRANCH=0
ITEMS=()

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
need() { [ -n "${2:-}" ] || { echo "$1 에 값이 없다" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) need "$1" "${2:-}"; REPO_DIR=$2; shift 2 ;;
    --before) need "$1" "${2:-}"; BEFORE_ALL=$2; shift 2 ;;
    --method) need "$1" "${2:-}"; METHOD=$2; shift 2 ;;
    --threads-cmd) need "$1" "${2:-}"; THREADS_CMD=$2; shift 2 ;;
    --check-timeout) need "$1" "${2:-}"; CHECK_TIMEOUT=$2; shift 2 ;;
    --keep-branch) KEEP_BRANCH=1; shift ;;
    -h|--help) usage ;;
    -*) echo "모르는 옵션: $1" >&2; exit 2 ;;
    *) ITEMS+=("$1"); shift ;;
  esac
done
[ ${#ITEMS[@]} -gt 0 ] || usage
case "$METHOD" in merge|squash|rebase) ;; *) echo "--method 는 merge, squash, rebase 중 하나다" >&2; exit 2 ;; esac
case "$CHECK_TIMEOUT" in ''|*[!0-9]*) echo "--check-timeout 은 분 단위 정수다" >&2; exit 2 ;; esac
for item in "${ITEMS[@]}"; do
  case "${item%%:*}" in ''|*[!0-9]*) echo "PR 번호가 아니다: $item" >&2; exit 2 ;; esac
done
cd "$REPO_DIR" || exit 2

if [ -z "$THREADS_CMD" ]; then
  RT="$SCRIPT_DIR/../../review-fix/scripts/review_threads.py"
  [ -f "$RT" ] || { echo "review_threads.py 를 찾지 못했다: $RT. --threads-cmd 로 준다" >&2; exit 2; }
  THREADS_CMD="python3 '$RT' list --count \"\$OWNER\" \"\$REPO\" \"\$PR\""
fi

# PR 하나의 필드를 읽는다. 호출이 실패하면 빈 문자열이다
field() { gh pr view "$1" --json "$2" --jq "$3" 2>/dev/null; }
stop() { echo "STOP $*"; exit 1; }
now() { date +%H:%M; }

PENDING='[.statusCheckRollup[] | select((.status // "COMPLETED") != "COMPLETED" or (.state // "") == "PENDING" or (.state // "") == "EXPECTED")] | length'
FAILED='[.statusCheckRollup[] | select(((.conclusion // "") | test("FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE")) or ((.state // "") | test("FAILURE|ERROR")))] | length'

for item in "${ITEMS[@]}"; do
  n=${item%%:*}
  before=$BEFORE_ALL
  [ "$n" != "$item" ] && before=${item#*:}

  st=$(field "$n" state .state)
  [ "$st" = MERGED ] && { echo "$(now) $n 이미 MERGED"; continue; }
  [ "$st" = OPEN ] || stop "$n state=${st:-조회 실패}"

  # 검사 대상 HEAD 를 체크를 보기 전에 고정한다
  ph=$(field "$n" headRefOid .headRefOid)
  BRANCH=$(field "$n" headRefName .headRefName)
  cross=$(field "$n" isCrossRepository .isCrossRepository)
  [ -n "$ph" ] || stop "$n headRefOid 조회 실패"
  [ -n "$BRANCH" ] || stop "$n headRefName 조회 실패"
  case "$cross" in true|false) ;; *) stop "$n isCrossRepository 조회 실패" ;; esac

  waited=0
  while :; do
    f=$(field "$n" statusCheckRollup "$FAILED")
    [ "${f:-0}" = 0 ] || stop "$n 실패한 체크 $f 개"
    p=$(field "$n" statusCheckRollup "$PENDING")
    [ -n "$p" ] || stop "$n 체크 조회 실패"
    [ "$p" = 0 ] && break
    [ $waited -ge $((CHECK_TIMEOUT * 60)) ] && stop "$n 체크 대기 ${CHECK_TIMEOUT}분 초과(남은 체크 $p)"
    sleep 30; waited=$((waited + 30))
  done
  # 체크가 끝난 직후에 새 체크가 붙는 경우가 있어 잠시 뒤 다시 본다
  sleep 15
  p=$(field "$n" statusCheckRollup "$PENDING")
  [ "$p" = 0 ] || stop "$n 새로 붙은 체크 ${p:-?} 개가 아직 돈다. 다시 돌린다"
  f=$(field "$n" statusCheckRollup "$FAILED")

  url=$(field "$n" url .url)
  path_part=${url#*://*/}
  OWNER=${path_part%%/*}; rest=${path_part#*/}; REPO=${rest%%/*}
  [ -n "$OWNER" ] && [ -n "$REPO" ] || stop "$n url 조회 실패"
  export PR="$n" BRANCH OWNER REPO
  t=$(bash -c "$THREADS_CMD") || stop "$n 스레드 조회 실패"

  m=$(field "$n" mergeable .mergeable)
  for _ in 1 2 3 4; do
    [ "$m" = UNKNOWN ] || break
    sleep 20; m=$(field "$n" mergeable .mergeable)
  done

  echo "$(now) $n fails=$f threads=$t mergeable=$m"
  if [ "$f" != 0 ] || [ "$t" != 0 ] || [ "$m" != MERGEABLE ]; then stop "$n"; fi

  if [ -n "$before" ]; then
    echo "$(now) $n 머지 전 명령: $before"
    bash -c "$before" || stop "$n 머지 전 명령 실패"
  fi

  ph2=$(field "$n" headRefOid .headRefOid)
  [ "$ph" = "$ph2" ] || stop "$n 검사 뒤 HEAD 가 바뀌었다 checked=${ph:0:8} now=${ph2:0:8}"
  if [ "$cross" = false ]; then
    git fetch -q origin "$BRANCH" || stop "$n 원격 브랜치 fetch 실패"
    rh=$(git rev-parse -q --verify "origin/$BRANCH")
    [ "$ph" = "$rh" ] || stop "$n head 불일치 pr=${ph:0:8} remote=${rh:0:8}"
  fi

  gh pr merge "$n" "--$METHOD" --match-head-commit "$ph" 2>&1 | tail -1
  merged=0
  for _ in 1 2 3; do
    sleep 5
    [ "$(field "$n" state .state)" = MERGED ] && { merged=1; break; }
  done
  [ $merged = 1 ] || stop "$n 머지 실패"
  echo "$(now) $n MERGED"
  # 머지 뒤 원격 추적 브랜치를 갱신해야 remove-worktree.sh 가 워크트리 커밋을 원격에 있다고 본다
  git fetch -q origin
  if [ "$KEEP_BRANCH" = 0 ] && [ "$cross" = false ]; then
    case "$BRANCH" in
      release/*) echo "$(now) $n release 브랜치는 남긴다 $BRANCH" ;;
      *)
        based=$(gh pr list --state open --base "$BRANCH" --json number --jq length 2>/dev/null)
        if [ "${based:-1}" != 0 ]; then
          echo "$(now) $n 다른 열린 PR 의 base 이거나 조회 실패라 남긴다 $BRANCH"
        else
          git push -q origin --delete "$BRANCH" 2>/dev/null && echo "$(now) $n 원격 브랜치 삭제 $BRANCH"
          git fetch -q --prune origin
        fi ;;
    esac
  fi
done
echo QUEUE-DONE
