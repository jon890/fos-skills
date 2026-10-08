#!/usr/bin/env bash
# macOS 개발 머신의 디스크, 메모리, 스왑, 큰 디렉터리, Docker, 도구 캐시를 조사한다. 읽기 전용이다.
#
# 사용법: survey_system.sh
# 걸리는 시간: du 때문에 1분에서 5분. 홈 디렉터리가 클수록 오래 걸린다.
# 종료 코드: 0 조사 완료. 개별 항목이 없거나 실패해도 건너뛰고 0 으로 끝난다.
#
# BSD 도구 전제다. sed 의 \| 교대는 쓰지 않는다.
set -u

section() { printf '\n## %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "디스크 (APFS 데이터 볼륨)"
df -h /System/Volumes/Data

section "메모리와 스왑"
phys=$(sysctl -n hw.memsize)
echo "실제 메모리: $((phys / 1073741824))GB"
sysctl vm.swapusage
memory_pressure 2>/dev/null | tail -1
page=$(vm_stat | grep -oE 'page size of [0-9]+' | grep -oE '[0-9]+')
comp=$(vm_stat | grep 'occupied by compressor' | grep -oE '[0-9]+')
if [ -n "${page:-}" ] && [ -n "${comp:-}" ]; then
  echo "압축 메모리: $((comp * page / 1048576))MB"
fi
uptime

section "앱별 RSS 합계 상위 15"
ps -axo rss=,command= | python3 -c '
import re, sys
from collections import defaultdict
total = defaultdict(int)
for line in sys.stdin:
    parts = line.strip().split(None, 1)
    if len(parts) < 2 or not parts[0].isdigit():
        continue
    cmd = parts[1]
    m = re.search(r"/([^/]+)\.app(?:/|$)", cmd)
    name = m.group(1) if m else (cmd.split()[0].rsplit("/", 1)[-1] if cmd.split() else "?")
    total[name] += int(parts[0])
for name, kb in sorted(total.items(), key=lambda x: -x[1])[:15]:
    print(f"{kb / 1048576:7.2f}GB  {name}")
'

section "큰 디렉터리"
echo "-- ~ (상위 15)"
du -xhd1 ~ 2>/dev/null | sort -rh | head -15
echo "-- ~/Library/Caches (상위 10)"
du -xhd1 ~/Library/Caches 2>/dev/null | sort -rh | head -10
echo "-- ~/Library/Application Support (상위 10)"
du -xhd1 "$HOME/Library/Application Support" 2>/dev/null | sort -rh | head -10

section "Docker"
if have docker && docker info >/dev/null 2>&1; then
  docker system df
  have colima && colima list
  [ -d "$HOME/.colima/_lima/_disks" ] && du -sh "$HOME/.colima/_lima/_disks"
else
  echo "docker 를 쓸 수 없어 건너뛴다"
fi

section "도구 캐시"
size_of() { [ -e "$1" ] && du -sh "$1" 2>/dev/null; }
size_of "$HOME/.npm"
if have pnpm; then size_of "$(pnpm store path 2>/dev/null)"; fi
size_of "$HOME/.gradle"
size_of "$HOME/.m2"
size_of "$HOME/.cache/uv"
if have pip3; then size_of "$(pip3 cache dir 2>/dev/null)"; fi
if have brew; then size_of "$(brew --cache 2>/dev/null)"; fi
size_of "$HOME/.cache/huggingface"
for d in "$HOME"/Library/Caches/ms-playwright*; do size_of "$d"; done

section "로컬 스냅샷과 휴지통"
tmutil listlocalsnapshots / 2>/dev/null
size_of "$HOME/.Trash"
exit 0
