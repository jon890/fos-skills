#!/usr/bin/env bash
# 사용:
#   launch-worker.sh --spec <지시서> --repo <저장소> --name <워크트리 이름> [--base <기준 브랜치>] [옵션] -- <worker-start 인자...>
#   launch-worker.sh --spec <지시서> --worktree <기존 워크트리 경로> [옵션] -- <worker-start 인자...>
#
# worker 를 띄우는 세 단계를 한 명령으로 묶는다. 하나라도 빠지면 오늘 겪은 실패가 다시 난다.
#   1. `spec-line.py --require-permission` 으로 첫 지시 줄을 만든다. `허락:` 줄이 없으면 띄우지 않는다.
#      허락이 지시서 파일 안에만 있으면 Codex worker 일부가 GitHub 게시가 금지됐다며 PR 을 열지 않는다
#   2. 새 워크트리(--name)는 `make-worktree.sh` 로 만든다. 기존 워크트리(--worktree)는 그 경로에 붙은 터미널이
#      남아 있으면 목록을 보여 주고 거부한다. 같은 워크트리에 이어 띄우면 앞 세션이 닫히지 않고 쌓인다.
#      worker-start 인자에 --terminal 로 준 터미널은 이어 쓰는 것이라 세지 않는다
#   3. `worker-start --worktree path:<경로>` 로 띄운 뒤 `worker-show` 의 단계를 --watch 초 동안 본다.
#      `worktree_creating` 에서 넘어가지 않으면 그 dispatch 를 `worker-abandon` 하고 같은 Task 를
#      `--retry-of` 로 한 번 다시 띄운다. 다시 띄워도 멈추면 종료 코드 1 이다
#
# 옵션
#   --run RUN_ID    worker-start 와 다시 띄우기에 줄 Run. 없으면 코디네이터에 묶인 Run 이다
#   --watch SEC     단계를 지켜볼 초. 기본 90. 0 이면 보지 않는다
#   --              뒤의 인자는 worker-start 에 그대로 넘긴다(--agent, --model, --effort, --terminal 같은 것)
#
# 표준 출력: 진행 줄과, 마지막 줄 `LAUNCHED <dispatch id> <워크트리 경로>`.
# ORCA, SPEC_LINE, MAKE_WORKTREE 환경 변수로 실행 파일과 스크립트 경로를 바꾼다. LAUNCH_POLL 은 확인 간격(초, 기본 5)이다.
#
# 종료 코드: 0 띄웠다, 1 거부했거나 띄우지 못했다(이유를 낸다), 2 사용법 오류
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ORCA=${ORCA:-orca}
SPEC_LINE=${SPEC_LINE:-$HERE/spec-line.py}
MAKE_WORKTREE=${MAKE_WORKTREE:-$HERE/make-worktree.sh}
POLL=${LAUNCH_POLL:-5}
spec="" repo="" name="" base="" worktree="" run="" watch=90
while [ $# -gt 0 ]; do
  case "$1" in
    --spec) spec=${2:?--spec 에 지시서가 필요하다}; shift 2 ;;
    --repo) repo=${2:?--repo 에 경로가 필요하다}; shift 2 ;;
    --name) name=${2:?--name 에 이름이 필요하다}; shift 2 ;;
    --base) base=${2:?--base 에 브랜치가 필요하다}; shift 2 ;;
    --worktree) worktree=${2:?--worktree 에 경로가 필요하다}; shift 2 ;;
    --run) run=${2:?--run 에 Run id 가 필요하다}; shift 2 ;;
    --watch) watch=${2:?--watch 에 초가 필요하다}; shift 2 ;;
    --) shift; break ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "모르는 인자: $1. worker-start 인자는 -- 뒤에 준다" >&2; exit 2 ;;
  esac
done
[ -n "$spec" ] || { echo "--spec 이 필요하다" >&2; exit 2; }
if [ -n "$worktree" ]; then
  [ -z "$name" ] && [ -z "$repo" ] || { echo "--worktree 와 --repo/--name 은 함께 쓰지 않는다" >&2; exit 2; }
else
  [ -n "$repo" ] && [ -n "$name" ] || { echo "새 워크트리는 --repo 와 --name, 기존 워크트리는 --worktree 를 준다" >&2; exit 2; }
fi
case "$watch" in ''|*[!0-9]*) echo "--watch 는 초 단위 정수다" >&2; exit 2 ;; esac

# 표준 입력의 orca JSON 에서 result 아래 점으로 이은 경로의 값을 낸다. `|` 로 이은 경로는 앞에서부터 찾는다. 없으면 빈 줄이다
jget() {
  python3 -c '
import json, sys
try:
    result = json.load(sys.stdin).get("result")
except (ValueError, AttributeError):
    sys.exit(0)
for path in sys.argv[1].split("|"):
    value = result
    for key in path.split("."):
        value = value.get(key) if isinstance(value, dict) else None
    if value not in (None, ""):
        print(value)
        break
' "$1"
}

line=$(python3 "$SPEC_LINE" "$spec" --require-permission) || { echo "거부: 첫 지시 줄을 만들지 못했다(지시서에 \`허락:\` 줄을 적는다)" >&2; exit 1; }

if [ -z "$worktree" ]; then
  worktree=$(bash "$MAKE_WORKTREE" --repo "$repo" --spec "$spec" --name "$name" ${base:+--base "$base"}) || exit 1
  echo "워크트리를 만들었다: $worktree"
else
  worktree=$(cd "$worktree" 2>/dev/null && pwd -P) || { echo "워크트리가 없다: $worktree" >&2; exit 1; }
  reuse=""
  prev=""
  for arg in "$@"; do
    [ "$prev" = --terminal ] && reuse=$arg
    prev=$arg
  done
  terminals=$("$ORCA" terminal list --json 2>/dev/null) || { echo "거부: orca terminal list 를 읽지 못해 남은 터미널을 확인할 수 없다" >&2; exit 1; }
  left=$(printf '%s' "$terminals" | python3 -c '
import json, sys
path, reuse = sys.argv[1], sys.argv[2]
rows = (json.load(sys.stdin).get("result") or {}).get("terminals") or []
for t in rows:
    if t.get("worktreePath") == path and t.get("handle") != reuse:
        print(t.get("handle"), (t.get("title") or "")[:60])
' "$worktree" "$reuse") || { echo "거부: 터미널 목록을 해석하지 못했다" >&2; exit 1; }
  if [ -n "$left" ]; then
    echo "거부: 이 워크트리에 터미널이 남아 있다. 끝났는지 보고 orca terminal close --terminal <handle> 로 닫은 뒤 다시 띄운다"
    printf '%s\n' "$left" | sed 's/^/  /'
    exit 1
  fi
fi

# --watch 초 동안 worker-show 의 단계를 본다. 단계를 내고, worktree_creating 에서 넘어가지 못하면 1 이다
watch_stage() {
  local dispatch=$1 waited=0 stage=""
  while :; do
    stage=$("$ORCA" orchestration worker-show --dispatch "$dispatch" --json 2>/dev/null | jget worker.stage)
    if [ -n "$stage" ] && [ "$stage" != worktree_creating ]; then echo "$dispatch 단계: $stage"; return 0; fi
    [ "$waited" -ge "$watch" ] && break
    sleep "$POLL"; waited=$((waited + POLL))
    [ "$POLL" = 0 ] && waited=$((waited + 1))
  done
  echo "$dispatch 가 ${watch}초 동안 ${stage:-단계 없음} 에서 넘어가지 않았다"
  return 1
}

out=$("$ORCA" orchestration worker-start ${run:+--run "$run"} --spec "$line" --worktree "path:$worktree" "$@" --json 2>&1)
code=$?
printf '%s\n' "$out"
[ "$code" = 0 ] || { echo "worker-start 가 종료 코드 $code 로 끝났다. launch.md 의 「첫 화면에서 멈춤」 과 「시작 직후 실패」 를 본다" >&2; exit 1; }
dispatch=$(printf '%s' "$out" | jget "dispatch.id|dispatchId|worker.dispatchId")
task=$(printf '%s' "$out" | jget "dispatch.taskId|taskId|task.id")
[ -n "$dispatch" ] || { echo "worker-start 출력에서 dispatch id 를 읽지 못했다" >&2; exit 1; }

if [ "$watch" -gt 0 ] && ! watch_stage "$dispatch"; then
  [ -n "$task" ] || { echo "task id 를 몰라 다시 띄우지 못한다: $dispatch" >&2; exit 1; }
  "$ORCA" orchestration worker-abandon --dispatch "$dispatch" --json >/dev/null 2>&1 || { echo "worker-abandon 실패: $dispatch" >&2; exit 1; }
  echo "$dispatch 를 abandon 하고 같은 Task 를 path:$worktree 로 다시 띄운다"
  out=$("$ORCA" orchestration worker-start ${run:+--run "$run"} --task "$task" --retry-of "$dispatch" --worktree "path:$worktree" "$@" --json 2>&1)
  code=$?
  printf '%s\n' "$out"
  [ "$code" = 0 ] || { echo "다시 띄우기가 종료 코드 $code 로 끝났다" >&2; exit 1; }
  dispatch=$(printf '%s' "$out" | jget "dispatch.id|dispatchId|worker.dispatchId")
  [ -n "$dispatch" ] || { echo "다시 띄운 출력에서 dispatch id 를 읽지 못했다" >&2; exit 1; }
  watch_stage "$dispatch" || exit 1
fi
echo "LAUNCHED $dispatch $worktree"
