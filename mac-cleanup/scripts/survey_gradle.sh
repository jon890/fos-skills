#!/usr/bin/env bash
# Gradle wrapper 버전 사용처, 캐시된 배포판, 실행 중 데몬을 비교해 삭제 후보를 보인다. 읽기 전용이다.
#
# 사용법: survey_gradle.sh [루트...]    기본 루트는 ~/projects ~/personal
# 종료 코드: 0 조사 완료.
# 지워도 wrapper 가 필요할 때 다시 받는다.
set -u

roots=("$@")
[ ${#roots[@]} -eq 0 ] && roots=("$HOME/projects" "$HOME/personal")
G="$HOME/.gradle"

echo "## wrapper 버전과 사용처"
used=$(mktemp)
trap 'rm -f "$used"' EXIT
for r in "${roots[@]}"; do
  [ -d "$r" ] || continue
  find "$r" -maxdepth 6 \( -name node_modules -o -name worktrees -o -name .orca-worktree-trash \) -prune -o \
    -path '*/gradle/wrapper/gradle-wrapper.properties' -print 2>/dev/null
done | while IFS= read -r f; do
  v=$(grep -oE 'gradle-[0-9.]+-(bin|all)' "$f" | head -1 | grep -oE '[0-9]+(\.[0-9]+)+')
  [ -n "$v" ] && { echo "$v" >> "$used"; printf '%-8s %s\n' "$v" "${f%/gradle/wrapper/gradle-wrapper.properties}"; }
done | sort

echo
echo "## 캐시된 배포판과 크기"
cached=$(mktemp)
for d in "$G"/wrapper/dists/gradle-*; do
  [ -d "$d" ] || continue
  v=$(basename "$d" | grep -oE '[0-9]+(\.[0-9]+)+' | head -1)
  echo "$v" >> "$cached"
done
for d in "$G"/caches/[0-9]* "$G"/daemon/[0-9]*; do
  [ -d "$d" ] && basename "$d" >> "$cached"
done
sort -u "$cached" -o "$cached"
while IFS= read -r v; do
  printf '%-8s dists %-7s caches %-7s daemon %-7s\n' "$v" \
    "$(du -sh "$G"/wrapper/dists/gradle-"$v"-* 2>/dev/null | awk '{s=$1} END{print s?s:"-"}')" \
    "$(du -sh "$G/caches/$v" 2>/dev/null | awk '{print $1}' | head -1 | grep . || echo -)" \
    "$(du -sh "$G/daemon/$v" 2>/dev/null | awk '{print $1}' | head -1 | grep . || echo -)"
done < "$cached"

echo
echo "## 실행 중 데몬 버전"
running=$(mktemp)
pgrep -fl GradleDaemon 2>/dev/null | grep -oE 'gradle-[0-9.]+' | grep -oE '[0-9]+(\.[0-9]+)+' | sort -u > "$running"
if [ -s "$running" ]; then cat "$running"; else echo "없음"; fi

echo
echo "## 삭제 후보 (사용처도 데몬도 없는 버전)"
n=0
while IFS= read -r v; do
  if ! grep -qx "$v" "$used" && ! grep -qx "$v" "$running"; then
    echo "$v"; n=$((n + 1))
  fi
done < "$cached"
[ "$n" -eq 0 ] && echo "없음"
echo "지워도 wrapper 가 필요할 때 다시 받는다."
rm -f "$cached" "$running"
exit 0
