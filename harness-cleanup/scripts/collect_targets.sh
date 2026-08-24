#!/usr/bin/env bash
#
# 하네스 지침 파일의 줄수를 모아 규모를 보여준다.
# Usage: bash collect_targets.sh [repo-root]
#
set -u
cd "${1:-.}" || exit 1

total=0
found=0
linked=0
HERE=$(pwd -P)

# 경로를 실제 위치로 바꾼다. 상위 디렉터리 symlink 와 파일 자체 symlink 를 모두 따라간다.
resolve() {
  d=$(dirname "$1")
  b=$(basename "$1")
  d=$(cd "$d" 2>/dev/null && pwd -P) || return 1
  if [ -L "$d/$b" ]; then
    t=$(readlink "$d/$b")
    case "$t" in
      /*) printf '%s\n' "$t" ;;
      *)  (cd "$d" && cd "$(dirname "$t")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "$t")") ;;
    esac
  else
    printf '%s/%s\n' "$d" "$b"
  fi
}

show() {
  [ -f "$1" ] || return 0
  n=$(wc -l < "$1" | tr -d ' ')
  real=$(resolve "$1")
  case "$real" in
    "$HERE"/*)
      printf "  %-52s %5s\n" "$1" "$n"
      total=$((total + n))
      found=$((found + 1))
      ;;
    *)
      # 저장소 밖을 가리키는 symlink — 공용 자산이므로 정리 대상이 아니다
      printf "  %-52s %5s  (symlink → %s, 대상 아님)\n" "$1" "$n" "$real"
      linked=$((linked + 1))
      ;;
  esac
}

echo "프로젝트 지침"
show CLAUDE.md
for f in .claude/rules/*.md; do show "$f"; done

echo "하네스별 역할 정의"
for f in .claude/agents/*.md .codex/agents/*.toml; do show "$f"; done

echo "공유 역할 계약"
for f in .agents/roles/*.md; do show "$f"; done

echo "내부 스킬"
for f in .claude/skills/*/SKILL.md .claude/skills/*/references/*.md; do show "$f"; done

echo "오버레이"
for f in .claude/*-overlay.md; do show "$f"; done

echo "공개 스킬"
for f in skills/*/SKILL.md skills/*/references/*.md; do show "$f"; done

# 공용 스킬 원본 저장소 — 스킬이 저장소 루트에 바로 놓인다
echo "공용 스킬 원본"
for f in */SKILL.md */references/*.md; do show "$f"; done

echo
printf "  %-52s %5s (%s개 파일)\n" "합계" "$total" "$found"
[ "$linked" -gt 0 ] && printf "  %-52s        (%s개 — 합계에서 제외)\n" "저장소 밖 symlink" "$linked"

[ "$found" -eq 0 ] && { echo "대상 파일을 찾지 못했다 — repo root 에서 실행하는지 확인하라" >&2; exit 2; }
exit 0
