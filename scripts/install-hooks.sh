#!/usr/bin/env bash
# 이 저장소의 훅을 .git/hooks 에 건다.
#
# .git/hooks 는 커밋되지 않는다. 훅을 거기에만 두면 다시 clone 했을 때 조용히 사라진다.
# 실물은 hooks/ 에 두고 이 스크립트로 연결한다.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/hooks"
DST="$REPO_DIR/.git/hooks"

[ -d "$SRC" ] || { echo "hooks/ 가 없다: $SRC" >&2; exit 2; }
mkdir -p "$DST"

for hook in "$SRC"/*; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  ln -sfn "$hook" "$DST/$name"
  echo "  걸었다: $name"
done
