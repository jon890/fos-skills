#!/usr/bin/env bash
# 스테이징한 수정을 HEAD 가 아닌 앞 커밋에 접어 넣는다. 대화형 rebase 를 쓰지 않는다.
#
# 사용법:
#     fold_fixup.sh <원인커밋>
#
# 전제: 접어 넣을 수정을 `git add` 로 스테이징해 둔다. 스테이징하지 않은 변경은 건드리지 않고 되살린다.
# 원인커밋은 HEAD 의 조상이어야 한다. HEAD 자신이면 `git commit --amend` 와 같으므로 그렇게 처리한다.
#
# 종료 코드:
#     0  성공
#     1  rebase 가 충돌로 멈췄다. 중단했고 fixup 커밋이 HEAD 에 남아 있다
#     2  사용법 오류 (인자, 스테이징 없음, 조상이 아님, 범위에 머지 커밋)
#
# 범위에 머지 커밋이 있으면 rebase 가 그것을 평탄화하므로 시작하기 전에 막는다.
# 해시가 바뀌므로 호출한 쪽은 대응 표의 해시를 다시 읽는다. 이미 push 한 커밋이면 force push 가 필요하다.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  sed -n '2,16p' "$0" >&2
  exit 2
fi

target=$(git rev-parse --verify --quiet "$1^{commit}") || { echo "커밋을 찾을 수 없다: $1" >&2; exit 2; }
head=$(git rev-parse HEAD)

if git diff --cached --quiet; then
  echo "스테이징된 변경이 없다. 접어 넣을 수정을 git add 로 먼저 올린다" >&2
  exit 2
fi

if [ "$target" = "$head" ]; then
  git commit --amend --no-edit
  exit 0
fi

if ! git merge-base --is-ancestor "$target" "$head"; then
  echo "원인 커밋이 HEAD 의 조상이 아니다: $1" >&2
  exit 2
fi

if [ -n "$(git rev-list --merges "$target..HEAD")" ]; then
  echo "$1..HEAD 에 머지 커밋이 있어 접을 수 없다" >&2
  exit 2
fi

git commit --fixup="$target" --quiet

# 접힌 fixup 커밋이 rebase 의 todo 에서 자동으로 대상 밑으로 옮겨진다. 편집기는 열지 않는다.
if git rev-parse --verify --quiet "$target^" >/dev/null; then
  base_args=("$target^")
else
  base_args=(--root)
fi

if ! GIT_SEQUENCE_EDITOR=true GIT_EDITOR=true \
    git rebase -i --autosquash --autostash "${base_args[@]}" >/dev/null; then
  git rebase --abort || true
  echo "rebase 가 충돌해 중단했다. fixup 커밋은 HEAD 에 남아 있다. 수정이 겹치는 커밋을 확인한다" >&2
  exit 1
fi

echo "접었다: $1 의 새 해시는 git log 로 다시 읽는다"
