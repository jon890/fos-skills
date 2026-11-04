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
# 경로는 한 줄에 하나씩, 실제로 있는 것만 낸다. 지우는 명령은 glob 반복문이 아니라 이 경로를 그대로 적은 한 줄이다.
# bash 버전마다 치환 문자열의 ~ 처리가 달라 case 로 자른다.
tilde() { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }
paths=()
while IFS= read -r v; do
  if ! grep -qx "$v" "$used" && ! grep -qx "$v" "$running"; then
    for d in "$G"/wrapper/dists/gradle-"$v"-* "$G/caches/$v" "$G/daemon/$v"; do
      [ -d "$d" ] || continue
      printf '%-8s %-7s %s\n' "$v" "$(du -sh "$d" 2>/dev/null | awk '{print $1}')" "$(tilde "$d")"
      paths+=("$(tilde "$d")")
    done
  fi
done < "$cached"
if [ ${#paths[@]} -eq 0 ]; then
  echo "없음"
else
  echo
  echo "## 승인 뒤 돌릴 명령 (출력만 하고 돌리지 않는다)"
  echo "rm -rf ${paths[*]}"
fi
echo "지워도 wrapper 가 필요할 때 다시 받는다."
rm -f "$cached" "$running"
exit 0
