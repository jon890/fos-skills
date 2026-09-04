#!/usr/bin/env bash
# 작업 트리를 대상 PR 의 head 브랜치로 맞춘다.
#
# 사용법:
#   checkout-pr.sh <PR번호>
#
# 종료 코드:
#   0  현재 브랜치가 PR 의 head 브랜치다
#   1  작업 트리가 dirty 하다. 다른 작업 중일 수 있으므로 체크아웃하지 않는다
#   2  사용법이 틀렸다
#   3  PR 의 head 브랜치를 읽지 못했다
#
# 정렬하지 않으면 뒤 단계가 다른 브랜치의 파일을 고친다.
# conflict 여부와 무관하게 항상 수행한다.
#
# 진입 시점의 현재 브랜치가 base 브랜치인 경우가 정상이다.
# 구현 스킬이 워크트리를 정리하면 거기로 돌아오기 때문이다 (실측).
set -eu

[ $# -eq 1 ] || { sed -n '2,5p' "$0" >&2; exit 2; }
num=$1

if [ -n "$(git status --porcelain)" ]; then
  echo "작업 트리가 dirty 하다. 사용자에게 확인받는다 (stash·커밋·중단)." >&2
  git status --short >&2
  exit 1
fi

head_ref=$(gh pr view "$num" --json headRefName --jq '.headRefName') || exit 3
[ -n "$head_ref" ] || { echo "PR #$num 의 head 브랜치를 읽지 못했다" >&2; exit 3; }

current=$(git branch --show-current)
if [ "$current" != "$head_ref" ]; then
  gh pr checkout "$num"
  current=$(git branch --show-current)
fi

printf '%s\n' "$current"
