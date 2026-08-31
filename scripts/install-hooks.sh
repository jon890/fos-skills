#!/usr/bin/env bash
# 이 저장소의 훅을 .git/hooks 에 건다.
#
# .git/hooks 는 커밋되지 않는다. 훅을 거기에만 두면 다시 clone 했을 때 조용히 사라진다.
# 실물은 hooks/ 에 두고 이 스크립트로 연결한다.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 워크트리에서 실행해도 맞게 걸리도록 git 에게 경로를 물어 받는다.
# 이 저장소는 worktrees/ 를 실제로 쓴다.
#   - 워크트리의 .git 은 디렉터리가 아니라 파일이라 "$HERE/.git/hooks" 는 만들 수 없다.
#   - .git/hooks 는 워크트리끼리 공유하므로, 링크 대상도 워크트리가 아닌 원본 체크아웃이어야 한다.
#     임시 워크트리를 가리키면 그것을 지우는 순간 훅이 끊긴다.
COMMON="$(cd "$HERE" && git rev-parse --path-format=absolute --git-common-dir)"
REPO_DIR="$(dirname "$COMMON")"
SRC="$REPO_DIR/hooks"
DST="$COMMON/hooks"

[ -d "$SRC" ] || { echo "hooks/ 가 없다: $SRC" >&2; exit 2; }
mkdir -p "$DST"

for hook in "$SRC"/*; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  ln -sfn "$hook" "$DST/$name"
  echo "  걸었다: $name"
done
