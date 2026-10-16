#!/bin/zsh
# 사용: remove-worktree.sh <worktree 경로> [--delete-branch] [--merged-head <커밋>]
# 작업이 끝난 git worktree 를 안전하게 지운다. 아래 중 하나라도 걸리면 지우지 않고 종료 코드 1 을 낸다.
#   1. 그 경로를 작업 디렉터리로 쓰는 프로세스가 있다(살아 있는 worker 나 셸)
#   2. 커밋 안 된 변경이 있다
#   3. 원격 어느 브랜치에도 없는 커밋이 있다(같은 제목의 커밋이 원격에 있으면 rebase 된 것으로 본다)
# --delete-branch 를 주면 지운 뒤 그 worktree 의 로컬 브랜치도 지운다. 원격 브랜치는 건드리지 않는다.
# --merged-head 는 머지된 PR 의 HEAD 다. 그 커밋의 조상은 원격에 있는 것으로 센다.
#   squash 머지는 제목이 달라져 3 의 제목 대조로는 원격에 없는 커밋으로 남기 때문이다.
#   HEAD 가 그 커밋과 같거나 그 조상이 아니면 거부한다. 옛 PR 과 이름만 같은 새 브랜치를 지우지 않기 위해서다.
set -u
p=${1:?worktree 경로}; p=${p:A}; shift
delete_branch=0 merged_head=""
while [ $# -gt 0 ]; do
  case "$1" in
    --delete-branch) delete_branch=1; shift ;;
    --merged-head) merged_head=${2:?--merged-head 에 커밋이 필요하다}; shift 2 ;;
    *) echo "모르는 인자: $1"; exit 2 ;;
  esac
done
[ -d "$p" ] || { echo "없음: $p"; exit 1; }
repo=$(git -C "$p" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "git worktree 가 아니다: $p"; exit 1; }
repo=${repo:h}
branch=$(git -C "$p" branch --show-current 2>/dev/null)

users=$(lsof -d cwd -Fn 2>/dev/null | grep -c "^n${p}\(/\|$\)")
if [ "$users" != 0 ]; then echo "거부: $p 를 쓰는 프로세스 $users 개"; exit 1; fi
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

git -C "$repo" worktree remove "$p" || exit 1
git -C "$repo" worktree prune
echo "removed $p"
if [ "$delete_branch" = 1 ] && [ -n "$branch" ]; then
  git -C "$repo" branch -D "$branch" >/dev/null 2>&1 && echo "deleted branch $branch"
fi
