#!/usr/bin/env bash
# 사용:
#   launch-worker.sh --spec <지시서> --repo <저장소> --name <워크트리 이름> [--base <기준 브랜치>] [옵션] -- <worker-start 인자...>
#   launch-worker.sh --spec <지시서> --worktree <기존 워크트리 경로> [옵션] -- <worker-start 인자...>
#
# worker 를 띄우는 네 단계를 한 명령으로 묶는다. 하나라도 빠지면 오늘 겪은 실패가 다시 난다.
#   1. `spec-line.py --require-permission` 으로 첫 지시 줄을 만든다. `허락:` 줄이 없으면 띄우지 않는다.
#      허락이 지시서 파일 안에만 있으면 Codex worker 일부가 GitHub 게시가 금지됐다며 PR 을 열지 않는다
#   2. 새 워크트리(--name)는 `make-worktree.sh` 로 만든다. 기존 워크트리(--worktree)는 그 경로에 붙은 터미널이
#      남아 있으면 목록을 보여 주고 거부한다. 같은 워크트리에 이어 띄우면 앞 세션이 닫히지 않고 쌓인다.
#      worker-start 인자에 --terminal 로 준 터미널은 이어 쓰는 것이라 세지 않는다
#   3. `orca worktree list` 에 그 경로가 보일 때까지 기다린다(기본 30초, 2초 간격). Orca 가 새 워크트리를 늦게 알아봐
#      바로 부르면 `selector_not_found` 로 실패한다. 시간을 넘기면 멈춘다. 그래도 worker-start 가 `selector_not_found` 로
#      끝나면 한 번만 다시 부른다. 다른 오류는 그대로 멈춘다
#   4. `worker-start --worktree path:<경로>` 로 띄운 뒤 `worker-show` 의 단계를 --watch 초 동안 본다.
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
# LAUNCH_WT_WAIT 와 LAUNCH_WT_POLL 은 Orca 가 워크트리를 알아볼 때까지 기다리는 초와 간격(기본 30, 2)이다.
#
# --terminal 로 떠 있는 에이전트를 이어 쓸 때(끝난 worker 의 터미널은 대개 이어 쓰지 못한다):
#   - Orca 는 --terminal 과 --agent, --model, --effort 를 함께 받지 않는다(invalid_argument). 주면 부르기 전에 거부한다
#   - 터미널이 에이전트를 인식하지 못하면(agent_unconfigured. 끝난 dispatch 의 터미널은 재부팅 없이도 난다. Orca 가
#     잠깐 응답하지 않았거나 재부팅, 잠자기로 세션이 바뀐 뒤에도 난다) 종료 코드 3 과 다음 단계를 낸다.
#     터미널을 닫는 것은 이 스크립트가 하지 않는다. 그 터미널이 이 세션이 띄운 worker 의 것인지 사람이 보고 닫는다.
#     다른 세션이나 사용자의 터미널은 닫지 않는다
#
# 종료 코드: 0 띄웠다, 1 거부했거나 띄우지 못했다(이유를 낸다), 2 사용법 오류, 3 --terminal 의 터미널이 에이전트를 인식하지 못했다
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ORCA=${ORCA:-orca}
SPEC_LINE=${SPEC_LINE:-$HERE/spec-line.py}
MAKE_WORKTREE=${MAKE_WORKTREE:-$HERE/make-worktree.sh}
POLL=${LAUNCH_POLL:-5}
WT_WAIT=${LAUNCH_WT_WAIT:-30}
WT_POLL=${LAUNCH_WT_POLL:-2}
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
reuse_terminal=0 reuse_opts=""
for arg in "$@"; do
  case "$arg" in
    --terminal) reuse_terminal=1 ;;
    --agent|--model|--effort) reuse_opts="$reuse_opts $arg" ;;
  esac
done
if [ "$reuse_terminal" = 1 ] && [ -n "$reuse_opts" ]; then
  echo "거부: --terminal 은 이미 떠 있는 에이전트를 이어 쓰므로${reuse_opts} 와 함께 쓰지 못한다(Orca 가 invalid_argument 로 거절한다). 모델을 바꾸려면 --terminal 을 빼고 새 worker 로 띄운다" >&2
  exit 1
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

# Orca 가 이 경로를 워크트리로 알고 있으면 0 이다. 경로는 realpath 로 비교한다
orca_knows_worktree() {
  "$ORCA" worktree list --limit 1000 --json 2>/dev/null | python3 -c '
import json, os, sys
try:
    rows = (json.load(sys.stdin).get("result") or {}).get("worktrees") or []
except (ValueError, AttributeError):
    sys.exit(1)
want = os.path.realpath(sys.argv[1])
sys.exit(0 if any(os.path.realpath(r.get("path") or "/nonexistent") == want for r in rows) else 1)
' "$1"
}

wait_for_orca_worktree() {
  local waited=0
  until orca_knows_worktree "$1"; do
    if [ "$waited" -ge "$WT_WAIT" ]; then
      echo "Orca 가 워크트리를 알아보지 못했다. \`orca worktree list\` 로 확인한다: $1 (${waited}초 기다림)" >&2
      return 1
    fi
    sleep "$WT_POLL"; waited=$((waited + WT_POLL))
    [ "$WT_POLL" = 0 ] && waited=$((waited + 1))
  done
  echo "Orca 가 워크트리를 알아보기까지 ${waited}초 기다렸다" >&2
}

# worker-start 를 부른다. selector_not_found 로 끝나면 한 번만 다시 부른다. 출력은 out, 종료 코드는 code 에 둔다
start_worker() {
  out=$("$ORCA" orchestration worker-start "$@" --json 2>&1)
  code=$?
  if [ "$code" != 0 ] && printf '%s' "$out" | grep -q selector_not_found; then
    echo "worker-start 가 selector_not_found 로 끝나 ${WT_POLL}초 뒤 한 번 다시 부른다" >&2
    sleep "$WT_POLL"
    out=$("$ORCA" orchestration worker-start "$@" --json 2>&1)
    code=$?
  fi
}

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

wait_for_orca_worktree "$worktree" || exit 1
start_worker ${run:+--run "$run"} --spec "$line" --worktree "path:$worktree" "$@"
printf '%s\n' "$out"
if [ "$code" != 0 ] && [ "$reuse_terminal" = 1 ] && printf '%s' "$out" | grep -q agent_unconfigured; then
  echo "--terminal 의 터미널이 에이전트를 인식하지 못했다(agent_unconfigured). replying.md 「이어 쓸 수 없는 터미널」 을 따른다: 1) 앞 worker 의 작업이 push 됐는지 보고 2) 그 터미널이 이 세션이 띄운 worker 의 것이면 orca terminal close 로 닫고 3) --terminal 을 빼고 --agent, --model, --effort 를 줘 이 명령을 다시 부른다" >&2
  exit 3
fi
[ "$code" = 0 ] || { echo "worker-start 가 종료 코드 $code 로 끝났다. launch.md 의 「첫 화면에서 멈춤」 과 「시작 직후 실패」 를 본다" >&2; exit 1; }
dispatch=$(printf '%s' "$out" | jget "dispatch.id|dispatchId|worker.dispatchId")
task=$(printf '%s' "$out" | jget "dispatch.taskId|taskId|task.id")
[ -n "$dispatch" ] || { echo "worker-start 출력에서 dispatch id 를 읽지 못했다" >&2; exit 1; }

if [ "$watch" -gt 0 ] && ! watch_stage "$dispatch"; then
  [ -n "$task" ] || { echo "task id 를 몰라 다시 띄우지 못한다: $dispatch" >&2; exit 1; }
  "$ORCA" orchestration worker-abandon --dispatch "$dispatch" --json >/dev/null 2>&1 || { echo "worker-abandon 실패: $dispatch" >&2; exit 1; }
  echo "$dispatch 를 abandon 하고 같은 Task 를 path:$worktree 로 다시 띄운다"
  start_worker ${run:+--run "$run"} --task "$task" --retry-of "$dispatch" --worktree "path:$worktree" "$@"
  printf '%s\n' "$out"
  [ "$code" = 0 ] || { echo "다시 띄우기가 종료 코드 $code 로 끝났다" >&2; exit 1; }
  dispatch=$(printf '%s' "$out" | jget "dispatch.id|dispatchId|worker.dispatchId")
  [ -n "$dispatch" ] || { echo "다시 띄운 출력에서 dispatch id 를 읽지 못했다" >&2; exit 1; }
  watch_stage "$dispatch" || exit 1
fi
echo "LAUNCHED $dispatch $worktree"
