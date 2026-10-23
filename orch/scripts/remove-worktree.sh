#!/bin/zsh
# 사용: remove-worktree.sh <worktree 경로> [--delete-branch] [--merged-head <커밋>] [--wait <초>]
# 작업이 끝난 git worktree 를 안전하게 지운다. 아래 중 하나라도 걸리면 지우지 않고 종료 코드 1 을 낸다.
#   1. 그 경로를 작업 디렉터리로 쓰는 프로세스가 있다(살아 있는 worker 나 셸). --wait 초 동안 빠지기를 기다린다
#      OMC session-end hook worker(`--omc-session-end-worker`)와 그 자손 프로세스만 남았으면 ORCH_HOOK_WAIT 초(기본 180)까지 기다린다.
#      자손은 `ps` 의 부모 pid 를 따라 찾는다. hook 이 띄운 자식이 중간에 생겨도 대기가 --wait 로 줄지 않게 하기 위해서다.
#      그 worker 는 세션이 끝난 뒤 워크트리의 `.omc/` 를 1분 넘게 쓰다 스스로 끝난다(실측).
#      빼고 지우면 그 쓰기가 지운 경로에 폴더를 다시 만들므로 빼지 않고 기다린다
#   2. 커밋 안 된 변경이 있다
#   3. 원격 어느 브랜치에도 없는 커밋이 있다(같은 제목의 커밋이 원격에 있으면 rebase 된 것으로 본다)
# --delete-branch 를 주면 지운 뒤 그 worktree 의 로컬 브랜치도 지운다. 원격 브랜치는 건드리지 않는다.
# --merged-head 는 머지된 PR 의 HEAD 다. 그 커밋의 조상은 원격에 있는 것으로 센다.
#   squash 머지는 제목이 달라져 3 의 제목 대조로는 원격에 없는 커밋으로 남기 때문이다.
#   HEAD 가 그 커밋과 같거나 그 조상이 아니면 거부한다. 옛 PR 과 이름만 같은 새 브랜치를 지우지 않기 위해서다.
# bash 나 sh 로 불러도 zsh 로 같은 인자를 넘겨 다시 실행한다. 아래의 ${p:A} 같은 zsh 문법을 bash 가 읽지 못하기 때문이다.
if [ -z "${ZSH_VERSION:-}" ]; then exec zsh "$0" "$@"; fi
set -u
p=${1:?worktree 경로}; p=${p:A}; shift
delete_branch=0 merged_head="" wait_s=0
hook_wait=${ORCH_HOOK_WAIT:-180}
while [ $# -gt 0 ]; do
  case "$1" in
    --delete-branch) delete_branch=1; shift ;;
    --merged-head) merged_head=${2:?--merged-head 에 커밋이 필요하다}; shift 2 ;;
    --wait) wait_s=${2:?--wait 에 초가 필요하다}; shift 2 ;;
    *) echo "모르는 인자: $1"; exit 2 ;;
  esac
done
[ -d "$p" ] || { echo "없음: $p"; exit 1; }
repo=$(git -C "$p" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "git worktree 가 아니다: $p"; exit 1; }
repo=${repo:h}
branch=$(git -C "$p" branch --show-current 2>/dev/null)

[[ $wait_s == <-> && $hook_wait == <-> ]] || { echo "--wait 와 ORCH_HOOK_WAIT 는 0 이상의 정수다"; exit 2; }
python3 "${0:A:h}/terminal_ownership.py" "$p" || exit 1

# 그 경로나 하위를 작업 디렉터리로 쓰는 pid. 거부 줄에 남겨 무엇이 쥐고 있는지 다시 찾지 않게 한다
holder_pids() {
  lsof -d cwd -Fpn 2>/dev/null | awk -v p="$p" '/^p/ { pid = substr($0, 2) } /^n/ { n = substr($0, 2); if (n == p || index(n, p "/") == 1) print pid }' | sort -u
}
# 인자로 준 pid 가운데 OMC session-end hook worker 이거나 그 자손인 것. hook worker 가 띄운 자식도 hook 이 끝나면 함께 끝난다
hook_pids() {
  ps -axo pid=,ppid=,command= 2>/dev/null | awk -v want=" $* " '
    { pid = $1; parent[pid] = $2; $1 = $2 = ""; if ($0 ~ /--omc-session-end-worker|hooks\/session-end\/worker\.js/) isHook[pid] = 1 }
    END {
      n = split(want, w, " ")
      for (i = 1; i <= n; i++) {
        for (q = w[i]; q != "" && q != 0 && depth < 50; q = parent[q]) { depth++; if (isHook[q]) { print w[i]; break } }
        depth = 0
      }
    }'
}
waited=0
while :; do
  holders=(${(f)"$(holder_pids)"})
  [ ${#holders} = 0 ] && break
  hooks=(${(f)"$(hook_pids $holders)"})
  limit=$wait_s
  if [ ${#hooks} = ${#holders} ] && [ "$hook_wait" -gt "$limit" ]; then limit=$hook_wait; fi
  if [ "$waited" -ge "$limit" ]; then
    note=""
    [ ${#hooks} != 0 ] && note=" 그중 OMC session-end hook ${(j:, :)hooks} 는 스스로 끝난다."
    echo "거부: $p 를 쓰는 프로세스 ${#holders} 개 (pid ${(j:, :)holders}), ${waited}초 기다림.$note 끝난 dispatch 의 프로세스면 cleanup-sweep.py --kill-holders 가 끈다"
    exit 1
  fi
  [ "$waited" = 0 ] && [ ${#hooks} = ${#holders} ] && echo "대기: $p 에 OMC session-end hook ${(j:, :)hooks} 만 남았다. 끝날 때까지 최대 ${limit}초 기다린다"
  sleep 1
  waited=$((waited + 1))
done
if [ -n "$(git -C "$p" status --porcelain)" ]; then echo "거부: $p 에 커밋 안 된 변경"; exit 1; fi
if [ -n "$merged_head" ] && ! git -C "$p" merge-base --is-ancestor HEAD "$merged_head" 2>/dev/null; then
  echo "거부: $p 의 HEAD 가 머지된 커밋 $merged_head 와 같지도 그 조상도 아니다"; exit 1
fi
lost=0
for c in $(git -C "$p" rev-list HEAD --not --remotes 2>/dev/null); do
  [ -n "$merged_head" ] && git -C "$p" merge-base --is-ancestor "$c" "$merged_head" 2>/dev/null && continue
  subj=$(git -C "$p" log -1 --format=%s "$c")
  [ -n "$(git -C "$p" log --remotes --format=%H -F --grep="$subj" -1)" ] || lost=$((lost+1))
done
if [ "$lost" != 0 ]; then echo "거부: $p 에 원격에 없는 커밋 $lost 개"; exit 1; fi

python3 "${0:A:h}/terminal_ownership.py" "$p" || exit 1
git -C "$repo" worktree remove "$p" || exit 1
git -C "$repo" worktree prune
echo "removed $p"
if [ "$delete_branch" = 1 ] && [ -n "$branch" ]; then
  git -C "$repo" branch -D "$branch" >/dev/null 2>&1 && echo "deleted branch $branch"
fi
