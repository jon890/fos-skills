#!/usr/bin/env bash
# 사용: merge-queue.sh [옵션] PR[:머지 전 명령] ...
#
# 받은 순서대로 PR 을 하나씩 머지한다. 한 PR 이라도 조건에 못 미치면 이유를 찍고 종료 코드 1 로 멈춘다.
# PR 마다 하는 일:
#   1. 이미 MERGED 면 건너뛴다. OPEN 이 아니면 멈춘다
#   2. 필수 체크가 모두 나타나고 끝날 때까지 기다린다(--check-timeout 분까지).
#      PR 을 연 직후에는 체크 목록이 비어 있어 「대기 0」이 「모두 끝남」이 아니기 때문이다
#      --require-up-to-date 이면 PR 이 base 최신을 품는지 보고, 아니면 base 를 merge 한 뒤 2 를 다시 한다
#   3. 실패한 체크, 미해결 리뷰 스레드, 충돌이 있으면 멈춘다. mergeable 이 UNKNOWN 이면 몇 번 다시 묻는다
#      --allow-fail 로 준 체크의 실패는 세지 않고 경고 줄만 찍는다
#   3-1. --stop-on-overlap 이나 --verify-merged 를 주면, PR 이 바꾼 파일과 PR 이 갈라진 뒤 base 에서 바뀐 파일이
#      겹치는지 본다. 겹치면 --stop-on-overlap 은 겹친 파일을 찍고 멈추고, --verify-merged 는 base 와 합친
#      임시 사본에서 그 명령을 돌려 0 일 때만 이어 간다. 체크는 PR 기준으로 돌아 같은 파일을 고친 base 와 합친
#      상태는 아무도 검사하지 않았기 때문이다. 겹치지 않으면 그대로 이어 간다.
#      --verify-merged-when 으로 겹치지 않아도 검사하게 하고, --docs-glob 에 맞는 문서 PR 은 검사 없이 머지한다
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
#                         `gh pr` 는 origin 으로 호스트를 찾지만 `gh api` 는 찾지 않고 기본 호스트(보통 github.com)로 간다.
#                         그래서 `gh api` 에는 PR URL 의 호스트(`gh pr` 가 origin 으로 정한 값)를 --hostname 으로 넘긴다.
#                         GH_HOST 환경 변수는 보지 않는다. 전역 GH_HOST 가 다른 호스트를 가리켜도 `gh pr` 와 같은 호스트로 간다
#   --before CMD          모든 PR 에 쓸 머지 전 명령. `PR:명령` 으로 준 PR 은 그 명령을 쓴다
#   --method M            merge | squash | rebase. 기본 merge
#   --threads-cmd CMD     미해결 스레드 수를 정수로 내는 명령. 기본은 형제 스킬 review-fix 의 review_threads.py
#   --check-timeout MIN   체크 대기 한도(분). 기본 60
#   --required A,B,C      나타나야 하는 필수 체크 이름. 없으면 저장소 규칙(rules/branches/BASE 의
#                         required_status_checks)에서 읽는다. 둘 다 비면 목록이 비었다는 경고를 찍고
#                         지금 있는 체크만 기다린다(예전 동작). 규칙 조회가 실패하면 멈춘다.
#                         예전 방식의 브랜치 보호 규칙은 규칙 조회에 나오지 않으므로 이 옵션으로 준다
#   --allow-fail A,B      실패해도 멈추지 않을 비필수 체크 이름. 실패한 체크마다 `경고: PR 실패를 허용한 체크 이름` 을
#                         찍고 머지한다. 코드와 무관한 이유(사용량 한도, 외부 장애)로 실패했고 그 대신 할 검증을
#                         끝냈을 때만 쓴다. 진행 중인 체크는 이 옵션과 상관없이 끝날 때까지 기다린다.
#                         필수 체크(--required 나 저장소 규칙)에 든 이름은 허용할 수 없다
#   --require-up-to-date  머지 전에 PR 이 base 최신을 품지 않으면 update-branch 로 base 를 merge 하고
#                         필수 체크를 다시 기다린 뒤 머지한다. 기본은 끔. 필수 체크 목록이 있어야 켤 수 있다
#   --stop-on-overlap     PR 의 바뀐 파일이 PR 기준 이후 base 에서 바뀐 파일과 겹치면 `STOP PR 겹침: 파일...` 로 멈춘다
#   --verify-merged CMD   겹치면 origin/BASE 에 PR HEAD 를 merge 한 임시 사본을 만들고, 그 안에서 CMD 를 bash -c 로
#                         돌린다. 사본의 절대경로를 첫 인자($1)로 받는다. 0 이면 이어 가고 아니면 멈춘다.
#                         합치다 충돌하거나, 검사하는 동안 원격 base 가 움직였으면 멈춘다. 사본은 끝나면 지운다.
#                         검사 명령은 저장소마다 달라 오버레이가 정한다(예: --verify-merged 'cd "$1" && make test')
#   --verify-merged-when W  합친 사본 검사를 언제 할지. overlap(기본, 겹칠 때만), code(문서만 바꾼 PR 이 아니면 늘),
#                         always(모든 PR). 파일이 겹치지 않아도 합쳐서 깨질 수 있다(두 PR 이 각자 통과했지만 합치니
#                         같은 상한을 함께 넘었다). code 와 always 는 --verify-merged 가 있어야 한다
#   --docs-glob G1,G2     문서 파일의 glob. PR 이 바꾼 파일이 모두 이것에 맞으면 overlap 과 code 에서 합친 사본 검사 없이
#                         머지한다. 충돌은 mergeable 로 이미 걸렀다. case 패턴이라 `*` 가 `/` 도 넘는다
#                         (예: --docs-glob 'docs/*,*.md'). 여러 번 주면 이어 붙인다. --verify-merged 가 있어야 한다
#   --copy-dir DIR        임시 사본을 둘 폴더. 기본은 TMPDIR(없으면 /tmp). 상대경로는 --repo 기준이다.
#                         저장소 hook 이 워크트리 위치를 막으면 오버레이가 허용된 폴더를 준다.
#                         링크를 푼 실경로로 바꿔 쓴다. macOS 의 TMPDIR(/var/folders/...)는 /var 가 /private/var 를
#                         가리키는 링크라, 실경로를 요구하는 검사가 사본 경로를 거부한다. 검사 명령의 TMPDIR 도 실경로로 준다
#                         사본 이름은 merge-queue-pr<PR>-<pid> 다. 시작할 때 이 폴더에서 pid 가 죽은 사본을 지운다.
#                         EXIT trap 은 KILL 로 끝나면 돌지 못해 사본이 남기 때문이다
#   --continue-on-hold    한 PR 이 조건에 못 미치면 멈추지 않고 STOP 줄을 찍은 뒤 다음 PR 로 간다. 끝에
#                         `QUEUE-HELD 번호...` 를 찍고 정리를 부른 뒤 종료 코드 1 로 끝난다. 기본은 첫 보류에서 멈춘다
#   --skipped-is-missing  결론이 SKIPPED 인 체크는 나타나지 않은 것으로 본다. 필수 체크가 SKIPPED 로만 있으면
#                         실제로 돌 때까지 기다린다. draft 에서는 CI 를 건너뛰게 둔 저장소용이다. 기본은 끔
#                         (GitHub 처럼 SKIPPED 를 통과로 본다). 필수 체크 목록이 있어야 뜻이 있다
#   --after-merged CMD    이번 실행에서 PR 을 하나라도 머지했으면, 큐가 끝나거나 보류로 멈춘 뒤 CMD 를 한 번 bash -c 로
#                         돌린다(배포 같은 것). 환경 변수 MERGED_PRS(머지한 PR 번호, 공백으로 이음)와 CODE_PRS(그 가운데
#                         --docs-glob 에 맞는 문서 PR 을 뺀 것. --docs-glob 이 없으면 MERGED_PRS 와 같다)를 받는다.
#                         실패하면 `AFTER-MERGED-FAILED 종료코드` 를 찍는다. 머지 결과는 바뀌지 않는다
#   --keep-branch         머지 뒤 원격 브랜치를 지우지 않는다
#   --sweep-arg ARG       머지가 끝난 뒤 부르는 cleanup-sweep.py 에 넘길 인자. 하나씩 준다
#                         (예: --sweep-arg --run --sweep-arg run_x --sweep-arg --specs-dir --sweep-arg .omc/specs)
#   --no-sweep            머지 뒤 cleanup-sweep.py --apply 를 부르지 않는다
#
# 모든 PR 이 머지되면 cleanup-sweep.py --apply 로 머지된 worktree, 브랜치, 터미널, 지시서를 정리한다.
# 정리가 실패해도 머지 결과는 바뀌지 않으므로 경고만 찍고 종료 코드는 0 이다.
# CLEANUP_SWEEP 환경 변수로 정리 스크립트 경로를 바꾼다.
#
# PR 조회(gh pr view)가 실패하면 MERGE_QUEUE_GH_RETRIES 번(기본 3)까지 MERGE_QUEUE_GH_RETRY_SECONDS 초(기본 10)
# 간격으로 다시 부른다. 일시 실패로 CI 를 통과한 PR 이 「체크 조회 실패」 로 보류되지 않게 하기 위해서다.
#
# 머지 전 명령, --threads-cmd, --verify-merged 는 bash -c 로 돈다. 환경 변수 PR(번호), BRANCH(head 브랜치), OWNER, REPO,
# GH_HOST(위 --hostname 과 같은 값)를 받는다.
# 예: merge-queue.sh 101 102:'./bin/backup-db.sh orders "pr-$PR"' 103
#
# 종료 코드: 0 모두 머지(또는 이미 MERGED), 1 어느 PR 에서 멈춤(--continue-on-hold 면 보류한 PR 이 있음), 2 사용법 오류,
#           3 모두 머지했지만 --after-merged 명령이 실패했다
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=.
BEFORE_ALL=""
METHOD=merge
THREADS_CMD=""
CHECK_TIMEOUT=60
REQUIRED=""
ALLOW_FAIL=""
UP_TO_DATE=0
KEEP_BRANCH=0
SWEEP=1
SWEEP_BASE=""
SWEEP_ARGS=()
OVERLAP=0
VERIFY_MERGED=""
VERIFY_WHEN=overlap
DOCS_GLOB=""
CONTINUE_ON_HOLD=0
SKIPPED_MISSING=0
AFTER_MERGED=""
HELD=()
COPY_DIR=""
COPY=""
ITEMS=()

usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 2; }
need() { [ -n "${2:-}" ] || { echo "$1 에 값이 없다" >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) need "$1" "${2:-}"; REPO_DIR=$2; shift 2 ;;
    --before) need "$1" "${2:-}"; BEFORE_ALL=$2; shift 2 ;;
    --method) need "$1" "${2:-}"; METHOD=$2; shift 2 ;;
    --threads-cmd) need "$1" "${2:-}"; THREADS_CMD=$2; shift 2 ;;
    --check-timeout) need "$1" "${2:-}"; CHECK_TIMEOUT=$2; shift 2 ;;
    --required) need "$1" "${2:-}"; REQUIRED=$2; shift 2 ;;
    --allow-fail) need "$1" "${2:-}"; ALLOW_FAIL=$2; shift 2 ;;
    --require-up-to-date) UP_TO_DATE=1; shift ;;
    --stop-on-overlap) OVERLAP=1; shift ;;
    --verify-merged) need "$1" "${2:-}"; VERIFY_MERGED=$2; OVERLAP=1; shift 2 ;;
    --verify-merged-when) need "$1" "${2:-}"; VERIFY_WHEN=$2; shift 2 ;;
    --docs-glob) need "$1" "${2:-}"; DOCS_GLOB=${DOCS_GLOB:+$DOCS_GLOB,}$2; shift 2 ;;
    --copy-dir) need "$1" "${2:-}"; COPY_DIR=$2; shift 2 ;;
    --continue-on-hold) CONTINUE_ON_HOLD=1; shift ;;
    --skipped-is-missing) SKIPPED_MISSING=1; shift ;;
    --after-merged) need "$1" "${2:-}"; AFTER_MERGED=$2; shift 2 ;;
    --keep-branch) KEEP_BRANCH=1; shift ;;
    --sweep-arg) need "$1" "${2:-}"; SWEEP_ARGS+=("$2"); shift 2 ;;
    --no-sweep) SWEEP=0; shift ;;
    -h|--help) usage ;;
    -*) echo "모르는 옵션: $1" >&2; exit 2 ;;
    *) ITEMS+=("$1"); shift ;;
  esac
done
[ ${#ITEMS[@]} -gt 0 ] || usage
case "$METHOD" in merge|squash|rebase) ;; *) echo "--method 는 merge, squash, rebase 중 하나다" >&2; exit 2 ;; esac
case "$CHECK_TIMEOUT" in ''|*[!0-9]*) echo "--check-timeout 은 분 단위 정수다" >&2; exit 2 ;; esac
case "$VERIFY_WHEN" in overlap|code|always) ;; *) echo "--verify-merged-when 은 overlap, code, always 중 하나다" >&2; exit 2 ;; esac
if [ -z "$VERIFY_MERGED" ]; then
  [ "$VERIFY_WHEN" = overlap ] || { echo "--verify-merged-when $VERIFY_WHEN 은 --verify-merged 와 함께 쓴다" >&2; exit 2; }
  [ -z "$DOCS_GLOB" ] || [ -n "$AFTER_MERGED" ] || { echo "--docs-glob 은 --after-merged 나 --verify-merged 와 함께 쓴다" >&2; exit 2; }
fi
case "$REQUIRED" in *[\"\\]*) echo "--required 에 따옴표나 역슬래시를 넣을 수 없다" >&2; exit 2 ;; esac
case "$ALLOW_FAIL" in *[\"\\]*) echo "--allow-fail 에 따옴표나 역슬래시를 넣을 수 없다" >&2; exit 2 ;; esac
# --required 에 든 이름의 실패는 허용할 수 없다
for x in ${ALLOW_FAIL//,/ }; do
  case ",$REQUIRED," in *",$x,"*) echo "--allow-fail 의 $x 는 --required 에도 있다. 필수 체크의 실패는 허용할 수 없다" >&2; exit 2 ;; esac
done
for item in "${ITEMS[@]}"; do
  case "${item%%:*}" in ''|*[!0-9]*) echo "PR 번호가 아니다: $item" >&2; exit 2 ;; esac
done
cd "$REPO_DIR" || exit 2
REAL_TMP=$(cd "${TMPDIR:-/tmp}" && pwd -P) || { echo "TMPDIR 를 읽지 못했다: ${TMPDIR:-/tmp}" >&2; exit 2; }
COPY_DIR=${COPY_DIR:-$REAL_TMP}

if [ -z "$THREADS_CMD" ]; then
  RT="$SCRIPT_DIR/../../review-fix/scripts/review_threads.py"
  [ -f "$RT" ] || { echo "review_threads.py 를 찾지 못했다: $RT. --threads-cmd 로 준다" >&2; exit 2; }
  THREADS_CMD="python3 '$RT' list --count \"\$OWNER\" \"\$REPO\" \"\$PR\""
fi

GH_RETRIES=${MERGE_QUEUE_GH_RETRIES:-3}
GH_RETRY_SECONDS=${MERGE_QUEUE_GH_RETRY_SECONDS:-10}
# PR 하나의 필드를 읽는다. 호출이 실패하면 GH_RETRIES 번까지 다시 부르고, 그래도 실패하면 빈 문자열이다
field() {
  local i=1 out
  while :; do
    if out=$(gh pr view "$1" --json "$2" --jq "$3" 2>/dev/null); then
      [ -z "$out" ] || printf '%s\n' "$out"
      return 0
    fi
    [ "$i" -ge "$GH_RETRIES" ] && return 1
    i=$((i + 1))
    sleep "$GH_RETRY_SECONDS"
  done
}
stop() { echo "STOP $*"; exit 1; }
now() { date +%H:%M; }
# 멈추거나 끝날 때 남은 임시 사본을 지운다
drop_copy() {
  [ -n "$COPY" ] || return 0
  git worktree remove --force "$COPY" >/dev/null 2>&1 || rm -rf "$COPY"
  git worktree prune
  COPY=""
}
BASE_FILE=$(mktemp) || exit 2
# 이번 실행에서 머지한 PR 을 「번호 code|docs」 줄로 모은다. --after-merged 가 읽는다
MERGED_FILE=$(mktemp) || exit 2
trap 'drop_copy; rm -f "$BASE_FILE" "$MERGED_FILE"' EXIT

# 앞 실행이 KILL 로 끝나 EXIT trap 이 돌지 못하고 남긴 사본을 지운다. 이름 끝의 pid 가 살아 있으면 다른 큐가 쓰는 중이다
if [ -d "$COPY_DIR" ]; then
  for old in "$COPY_DIR"/merge-queue-pr[0-9]*-[0-9]*; do
    [ -d "$old" ] || continue
    kill -0 "${old##*-}" 2>/dev/null && continue
    git worktree remove --force "$old" >/dev/null 2>&1 || rm -rf "$old"
    echo "$(now) 끝난 실행(pid ${old##*-})이 남긴 사본을 지웠다: $old"
  done
  git worktree prune
fi

# PR 이 바꾼 파일 가운데 PR 이 갈라진 뒤 base 에서도 바뀐 파일. 한 줄에 하나다. 판정하지 못하면 1 로 끝난다
overlap_files() {
  local mb mine theirs
  git fetch -q origin "$base" || return 1
  if ! git cat-file -e "$ph^{commit}" 2>/dev/null; then
    if [ "$cross" = false ]; then git fetch -q origin "$BRANCH"; else git fetch -q origin "refs/pull/$n/head"; fi
  fi
  git cat-file -e "$ph^{commit}" 2>/dev/null || return 1
  mb=$(git merge-base "origin/$base" "$ph") || return 1
  mine=$(git diff --name-only "$mb" "$ph") || return 1
  theirs=$(git diff --name-only "$mb" "origin/$base") || return 1
  comm -12 <(printf '%s\n' "$mine" | sort) <(printf '%s\n' "$theirs" | sort) | sed '/^$/d'
}

# PR 이 바꾼 파일이 모두 --docs-glob 에 맞으면 0. 바꾼 파일이 없거나 판정하지 못하면 1
docs_only() {
  local mb f rest pat hit any=0
  mb=$(git merge-base "origin/$base" "$ph") || return 1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    any=1; hit=0; rest="$DOCS_GLOB,"
    while [ -n "$rest" ]; do
      pat=${rest%%,*}; rest=${rest#*,}
      # shellcheck disable=SC2254
      [ -n "$pat" ] && case "$f" in $pat) hit=1; break ;; esac
    done
    [ "$hit" = 1 ] || return 1
  done < <(git diff --name-only "$mb" "$ph")
  [ "$any" = 1 ]
}

# origin/BASE 에 PR HEAD 를 merge 한 임시 사본에서 --verify-merged 명령을 돌린다. 실패하면 멈춘다
verify_merged() {
  local parent bh now_bh code
  mkdir -p "$COPY_DIR" && parent=$(cd "$COPY_DIR" && pwd -P) || stop "$n 사본 폴더를 만들지 못했다: $COPY_DIR"
  bh=$(git rev-parse -q --verify "origin/$base") || stop "$n origin/$base 를 읽지 못했다"
  COPY="$parent/merge-queue-pr$n-$$"
  git worktree add -q --detach "$COPY" "$bh" >/dev/null 2>&1 || stop "$n 사본을 만들지 못했다: $COPY"
  git -C "$COPY" -c core.hooksPath=/dev/null -c user.name=merge-queue -c user.email=merge-queue@localhost \
    merge -q --no-edit "$ph" >/dev/null 2>&1 || stop "$n base($base) 와 합치면 충돌한다"
  echo "$(now) $n 합친 사본에서 검사: $VERIFY_MERGED"
  (cd "$COPY" && TMPDIR="$REAL_TMP" GH_HOST="$API_HOST" bash -c "$VERIFY_MERGED" verify-merged "$COPY")
  code=$?
  drop_copy
  [ "$code" = 0 ] || stop "$n 합친 사본의 검사 실패(종료 코드 $code)"
  # 검사하는 동안 base 가 움직였으면 검사한 조합과 머지할 조합이 다르다
  now_bh=$(git ls-remote origin "refs/heads/$base" | cut -f1)
  [ "$now_bh" = "$bh" ] || stop "$n 검사하는 동안 base($base) 가 움직였다. 다시 돌린다"
  echo "$(now) $n 합친 사본의 검사 통과"
}

# 쉼표로 이은 이름을 jq 배열 리터럴로 바꾼다
req_json() {
  local out="" x rest="$1,"
  while [ -n "$rest" ]; do
    x=${rest%%,*}; rest=${rest#*,}
    [ -z "$x" ] || out="$out${out:+,}\"$x\""
  done
  echo "[$out]"
}
# 롤업에 나타난 체크 이름(체크 실행은 name, 커밋 상태는 context)
ROLL_NAMES='[.statusCheckRollup[] | (.name // .context)]'
# draft 때 건너뛴 실행만 있는 필수 체크는 아직 돌지 않은 것이다
[ "$SKIPPED_MISSING" = 1 ] && ROLL_NAMES='[.statusCheckRollup[] | select((.conclusion // "") != "SKIPPED") | (.name // .context)]'

PENDING='[.statusCheckRollup[] | select((.status // "COMPLETED") != "COMPLETED" or (.state // "") == "PENDING" or (.state // "") == "EXPECTED")] | length'
FAIL_SEL='select(((.conclusion // "") | test("FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE")) or ((.state // "") | test("FAILURE|ERROR")))'
# 허용한 체크의 실패는 FAILED 에서 빼고 ALLOWED_FAILED 에 이름으로 모은다
IS_ALLOWED="(.name // .context) as \$nm | ($(req_json "$ALLOW_FAIL") | any(. == \$nm))"
FAILED="[.statusCheckRollup[] | $FAIL_SEL | select($IS_ALLOWED | not)] | length"
ALLOWED_FAILED="[.statusCheckRollup[] | $FAIL_SEL | select($IS_ALLOWED) | (.name // .context)] | unique | .[]"

# PR 하나를 머지한다. 서브셸에서 돌아 stop 은 그 PR 만 끝낸다. 정리에 넘길 base 는 BASE_FILE 로 돌려준다
process_pr() {
  local item=$1
  n=${item%%:*}
  before=$BEFORE_ALL
  [ "$n" != "$item" ] && before=${item#*:}

  st=$(field "$n" state .state)
  [ "$st" = MERGED ] && { echo "$(now) $n 이미 MERGED"; echo "${SWEEP_BASE:-$(field "$n" baseRefName .baseRefName)}" > "$BASE_FILE"; return 0; }
  [ "$st" = OPEN ] || stop "$n state=${st:-조회 실패}"

  # 검사 대상 HEAD 를 체크를 보기 전에 고정한다
  ph=$(field "$n" headRefOid .headRefOid)
  BRANCH=$(field "$n" headRefName .headRefName)
  cross=$(field "$n" isCrossRepository .isCrossRepository)
  [ -n "$ph" ] || stop "$n headRefOid 조회 실패"
  [ -n "$BRANCH" ] || stop "$n headRefName 조회 실패"
  case "$cross" in true|false) ;; *) stop "$n isCrossRepository 조회 실패" ;; esac

  url=$(field "$n" url .url)
  path_part=${url#*://*/}
  OWNER=${path_part%%/*}; rest=${path_part#*/}; REPO=${rest%%/*}
  host_part=${url#*://}; API_HOST=${host_part%%/*}
  [ -n "$OWNER" ] && [ -n "$REPO" ] && [ -n "$API_HOST" ] || stop "$n url 조회 실패"
  base=$(field "$n" baseRefName .baseRefName)
  [ -n "$base" ] || stop "$n baseRefName 조회 실패"
  echo "$base" > "$BASE_FILE"

  req=$REQUIRED
  if [ -z "$req" ]; then
    rules_err=$(mktemp)
    if req=$(gh api --hostname "$API_HOST" "repos/$OWNER/$REPO/rules/branches/$base" \
      --jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | unique | join(",")' 2>"$rules_err"); then
      :
    elif grep -q 'HTTP 403' "$rules_err" && grep -q 'Upgrade to GitHub Pro' "$rules_err"; then
      # 무료 플랜의 비공개 저장소는 규칙 API 를 읽을 수 없다. 필수 체크 목록이 없는 것으로 다룬다
      echo "$(now) $n 경고: 이 플랜은 저장소 규칙을 읽을 수 없다(HTTP 403, 플랜 제한). 필수 체크 목록을 비어 있는 것으로 본다"
      req=""
    else
      rm -f "$rules_err"
      stop "$n 필수 체크 규칙 조회 실패. --required 로 준다"
    fi
    rm -f "$rules_err"
  fi
  if [ -z "$req" ]; then
    [ "$UP_TO_DATE" = 0 ] || stop "$n 필수 체크 목록이 비어 있어 --require-up-to-date 를 쓸 수 없다. --required 로 준다"
    echo "$(now) $n 필수 체크 목록이 비어 있다. 지금 있는 체크만 기다린다"
  fi
  for x in ${ALLOW_FAIL//,/ }; do
    case ",$req," in *",$x,"*) stop "$n --allow-fail 의 $x 는 필수 체크다. 필수 체크의 실패는 허용할 수 없다" ;; esac
  done
  MISSING="(($(req_json "$req")) - $ROLL_NAMES)"

  # 필수 체크가 모두 나타나고 끝날 때까지 기다린다. 실패가 보이면 바로 멈춘다
  wait_checks() {
    local waited=0 f p m
    while :; do
      f=$(field "$n" statusCheckRollup "$FAILED")
      [ "${f:-0}" = 0 ] || stop "$n 실패한 체크 $f 개"
      p=$(field "$n" statusCheckRollup "$PENDING")
      m=$(field "$n" statusCheckRollup "$MISSING | length")
      [ -n "$p" ] && [ -n "$m" ] || stop "$n 체크 조회 실패"
      [ "$p" = 0 ] && [ "$m" = 0 ] && break
      [ $waited -ge $((CHECK_TIMEOUT * 60)) ] && stop "$n 체크 대기 ${CHECK_TIMEOUT}분 초과(진행 중 $p, 나타나지 않은 필수 체크 $(field "$n" statusCheckRollup "$MISSING | join(\",\")"))"
      sleep 30; waited=$((waited + 30))
    done
    # 체크가 끝난 직후에 새 체크가 붙는 경우가 있어 잠시 뒤 다시 본다
    sleep 15
    p=$(field "$n" statusCheckRollup "$PENDING")
    m=$(field "$n" statusCheckRollup "$MISSING | length")
    [ "$p" = 0 ] && [ "$m" = 0 ] || stop "$n 새로 붙은 체크가 아직 돈다(진행 중 ${p:-?}, 미등장 ${m:-?}). 다시 돌린다"
  }

  rounds=0
  while :; do
    wait_checks
    [ "$UP_TO_DATE" = 1 ] || break
    behind=$(gh api --hostname "$API_HOST" "repos/$OWNER/$REPO/compare/$base...$ph" --jq .behind_by 2>/dev/null)
    case "$behind" in ''|*[!0-9]*) stop "$n base 와 비교 실패" ;; esac
    [ "$behind" = 0 ] && break
    rounds=$((rounds + 1))
    [ $rounds -le 3 ] || stop "$n base 를 3번 merge 해도 최신이 아니다. base 가 계속 움직인다"
    echo "$(now) $n base($base) 보다 $behind 커밋 뒤처졌다. update-branch 후 체크를 다시 기다린다"
    gh api --hostname "$API_HOST" -X PUT "repos/$OWNER/$REPO/pulls/$n/update-branch" >/dev/null 2>&1 || stop "$n update-branch 실패(충돌 가능)"
    # update-branch 는 비동기라 PR HEAD 가 바뀔 때까지 기다린다
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      sleep 5; nh=$(field "$n" headRefOid .headRefOid)
      [ -n "$nh" ] && [ "$nh" != "$ph" ] && break
    done
    [ -n "$nh" ] && [ "$nh" != "$ph" ] || stop "$n update-branch 뒤 HEAD 가 바뀌지 않았다"
    ph=$nh
  done

  f=$(field "$n" statusCheckRollup "$FAILED")
  while IFS= read -r x; do
    [ -z "$x" ] || echo "경고: $n 실패를 허용한 체크 $x"
  done < <(field "$n" statusCheckRollup "$ALLOWED_FAILED")
  export PR="$n" BRANCH OWNER REPO
  t=$(GH_HOST="$API_HOST" bash -c "$THREADS_CMD") || stop "$n 스레드 조회 실패"

  m=$(field "$n" mergeable .mergeable)
  for _ in 1 2 3 4; do
    [ "$m" = UNKNOWN ] || break
    sleep 20; m=$(field "$n" mergeable .mergeable)
  done

  echo "$(now) $n fails=$f threads=$t mergeable=$m"
  if [ "$f" != 0 ] || [ "$t" != 0 ] || [ "$m" != MERGEABLE ]; then stop "$n"; fi

  if [ "$OVERLAP" = 1 ]; then
    ov=$(overlap_files) || stop "$n 겹침 판정 실패(PR HEAD 나 base 를 받지 못했다)"
    list=$(printf '%s' "$ov" | tr '\n' ' ')
    if [ -z "$VERIFY_MERGED" ]; then
      [ -z "$ov" ] || stop "$n 겹침: $list"
    else
      [ -z "$ov" ] || echo "$(now) $n 겹침: $list"
      if [ "$VERIFY_WHEN" != overlap ] || [ -n "$ov" ]; then
        if [ "$VERIFY_WHEN" != always ] && [ -n "$DOCS_GLOB" ] && docs_only; then
          echo "$(now) $n 문서만 바꿨다(--docs-glob). 합친 사본 검사 없이 머지한다"
        else
          verify_merged
        fi
      fi
    fi
  fi

  if [ -n "$before" ]; then
    echo "$(now) $n 머지 전 명령: $before"
    GH_HOST="$API_HOST" bash -c "$before" || stop "$n 머지 전 명령 실패"
  fi

  ph2=$(field "$n" headRefOid .headRefOid)
  [ "$ph" = "$ph2" ] || stop "$n 검사 뒤 HEAD 가 바뀌었다 checked=${ph:0:8} now=${ph2:0:8}"
  if [ "$cross" = false ]; then
    git fetch -q origin "$BRANCH" || stop "$n 원격 브랜치 fetch 실패"
    rh=$(git rev-parse -q --verify "origin/$BRANCH")
    [ "$ph" = "$rh" ] || stop "$n head 불일치 pr=${ph:0:8} remote=${rh:0:8}"
  fi

  # 머지 뒤에는 merge-base 가 바뀌어 문서 PR 인지 다시 판정할 수 없다. 머지 전에 정한다
  kind=code
  [ -n "$DOCS_GLOB" ] && docs_only && kind=docs
  gh pr merge "$n" "--$METHOD" --match-head-commit "$ph" 2>&1 | tail -1
  merged=0
  for _ in 1 2 3; do
    sleep 5
    [ "$(field "$n" state .state)" = MERGED ] && { merged=1; break; }
  done
  [ $merged = 1 ] || stop "$n 머지 실패"
  echo "$(now) $n MERGED"
  echo "$n $kind" >> "$MERGED_FILE"
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
}

# 이번 실행에서 머지한 PR 이 있으면 --after-merged 를 한 번 돌린다. 실패하면 1 이다
AFTER_FAILED=0
run_after_merged() {
  [ -n "$AFTER_MERGED" ] && [ -s "$MERGED_FILE" ] || return 0
  MERGED_PRS=$(awk '{ print $1 }' "$MERGED_FILE" | tr '\n' ' ' | sed 's/ $//')
  CODE_PRS=$(awk '$2 == "code" { print $1 }' "$MERGED_FILE" | tr '\n' ' ' | sed 's/ $//')
  echo "$(now) 머지 뒤 명령(머지 $MERGED_PRS, 코드 ${CODE_PRS:-없음}): $AFTER_MERGED"
  MERGED_PRS="$MERGED_PRS" CODE_PRS="$CODE_PRS" bash -c "$AFTER_MERGED"
  local code=$?
  : > "$MERGED_FILE"
  [ "$code" = 0 ] && return 0
  echo "AFTER-MERGED-FAILED $code"
  AFTER_FAILED=1
  return 1
}

for item in "${ITEMS[@]}"; do
  ( trap drop_copy EXIT; process_pr "$item" )
  code=$?
  [ -s "$BASE_FILE" ] && SWEEP_BASE=$(cat "$BASE_FILE")
  [ "$code" = 0 ] && continue
  # 1 은 그 PR 의 보류다. 그 밖(신호로 끊김 같은 것)은 이어 가지 않는다
  if [ "$CONTINUE_ON_HOLD" != 1 ] || [ "$code" != 1 ]; then
    # 보류로 멈춰도 앞에서 머지한 PR 의 머지 뒤 명령은 돌린다
    [ "$code" = 1 ] && run_after_merged
    exit "$code"
  fi
  HELD+=("${item%%:*}")
  echo "$(now) ${item%%:*} 보류. 다음 PR 로 간다"
done
if [ ${#HELD[@]} -gt 0 ]; then echo "QUEUE-HELD ${HELD[*]}"; else echo QUEUE-DONE; fi
run_after_merged

if [ "$SWEEP" = 1 ]; then
  SWEEP_SCRIPT=${CLEANUP_SWEEP:-$SCRIPT_DIR/cleanup-sweep.py}
  python3 "$SWEEP_SCRIPT" --repo "$PWD" --base "${SWEEP_BASE:-main}" --apply ${SWEEP_ARGS[@]+"${SWEEP_ARGS[@]}"} \
    || echo "경고: cleanup-sweep.py 가 실패했다. 머지 결과는 그대로다"
fi
[ ${#HELD[@]} -eq 0 ] || exit 1
[ "$AFTER_FAILED" = 0 ] || exit 3
