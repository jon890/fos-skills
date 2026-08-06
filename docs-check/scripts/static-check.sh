#!/usr/bin/env bash
# docs-check 가벼운 정적 검사 — 결정적으로 판정되는 위반만 검출한다.
# 사용법: ~/.claude/skills/docs-check/scripts/static-check.sh [ADR_DIR]
# cwd 는 검사 대상 <레포 root>. ADR_DIR 생략 시 ADR 검사는 건너뛴다.
# 위반 라인을 stdout 으로 출력한다. 출력 0 줄이면 통과.
# 주의: grep 무매치가 exit 1 이므로 set -e 를 쓰지 않는다.
set -u
ADR_DIR="${1:-}"

# 검사 대상 마크다운 — 추적 파일과 미추적 신규 파일을 모두 본다.
#   `git ls-files` 만 쓰면 방금 만든 문서를 통째로 건너뛴 채 0 줄을 내, 거짓 통과가 된다.
#   docs-check 가 부르는 시점이 대개 문서를 새로 쓴 직후라 그 파일이 가장 중요한 검사 대상이다.
#   -c 추적 / -o 미추적 / --exclude-standard 로 gitignore 대상은 뺀다.
md_files() { git ls-files -co --exclude-standard '*.md' 2>/dev/null; }

if [ -n "$ADR_DIR" ] && [ -d "$ADR_DIR" ]; then
  # ADR Index 동기화 — 본문 ADR 번호가 Index 에 모두 있는가
  BODY=$(grep -rhoE 'ADR-[0-9]+' "$ADR_DIR"/*.md 2>/dev/null | sort -u)
  INDEX=$(grep -ohE 'ADR-[0-9]+' "$ADR_DIR"/INDEX.md 2>/dev/null | sort -u)
  if [ "$BODY" != "$INDEX" ]; then
    echo "INDEX_DESYNC: $ADR_DIR — 본문과 INDEX.md 의 ADR 번호 집합이 다르다"
    diff <(echo "$BODY") <(echo "$INDEX") | sed 's/^/  /'
  fi

  # ADR 과대화 — 30줄 초과는 기능 명세로 변질됐는지 검토 신호
  for f in "$ADR_DIR"/*.md; do
    [ -f "$f" ] || continue
    size=$(wc -l < "$f" | tr -d ' ')
    [ "$size" -gt 30 ] && echo "과대화: $f ($size 줄 > 30) — 슬림화 검토"
  done
fi

# 마크다운 문법 깨짐 — 렌더가 어긋나는 결정적 오류만 본다
for f in $(md_files); do
  awk -v F="$f" '
    # 코드 블록 안은 렌더 대상이 아니다 — 셸 주석(#)을 헤딩으로 오인하지 않도록 건너뛴다
    /^```/ { fence++; in_code = !in_code; next }
    in_code { next }
    # 구분선은 열 수 비교 대상이 아니지만 표를 끊지도 않는다
    /^[[:space:]]*\|[[:space:]]*:?-/ { next }
    # 표 행의 열 수가 헤더와 다르면 셀이 밀려 렌더된다
    /^[[:space:]]*\|/ {
      n = gsub(/\|/, "|")
      if (tbl == 0) { tbl = 1; cols = n }
      else if (n != cols) print F ":" NR ": 표 열 수 불일치 (헤더 " cols-1 "칸, 이 행 " n-1 "칸)"
      next
    }
    { tbl = 0 }
    # 헤딩 레벨 건너뛰기 (h2 다음 h4 등)
    /^#+ / {
      lvl = index($0, " ") - 1
      if (prev > 0 && lvl > prev + 1) print F ":" NR ": 헤딩 레벨 건너뜀 (h" prev " → h" lvl ")"
      prev = lvl
    }
    END { if (fence % 2 != 0) print F ": 코드 펜스 짝이 안 맞음 (``` " fence "개)" }
  ' "$f"

  # 상대 링크가 실제 파일을 가리키는가
  grep -oE '\]\([^)#][^)]*\)' "$f" 2>/dev/null | tr -d '()]' | while read -r target; do
    case "$target" in
      http*|mailto:*|"") continue ;;
    esac
    [ -e "$(dirname "$f")/${target%%#*}" ] || echo "$f: 깨진 링크 → $target"
  done
done

# 한국어 표기 정책 — 공용 검사기에 위임한다.
#   같은 검사기를 편집 직후 hook 도 호출해, 작성 시점과 감사 시점이 같은 기준을 쓴다.
#   검사기나 규칙 파일이 없는 환경(팀원 등)에서는 이 항목만 건너뛰고 나머지는 계속 검사한다.
STYLE_CHECK="${KOREAN_STYLE_CHECK:-$HOME/.claude/scripts/korean-style-check.sh}"
if [ -x "$STYLE_CHECK" ]; then
  # shellcheck disable=SC2046
  "$STYLE_CHECK" $(md_files)
fi

# 문체 정적 패턴 — 코드 블록과 코드 스팬(`...`)은 렌더 대상이 아니므로 제외한다
for f in $(md_files); do
  awk -v F="$f" '
    /^```/ { in_code = !in_code; next }
    in_code { next }
    {
      line = $0
      gsub(/`[^`]*`/, "", line)          # 코드 스팬 제거 — ~/path 오탐 방지
      n = gsub(/~/, "~", line)
      if (n > 0 && n % 2 == 0) print F ":" NR ": ~ 짝수개(" n ") — 취소선 렌더 위험"
      if (line ~ /§/)          print F ":" NR ": § 섹션 기호 — \"섹션 N\" 으로"
      if (line ~ /\*\*[^*]*\([^)]*\)\*\*/) print F ":" NR ": Bold+괄호 — **텍스트**(부연) 로"
    }
  ' "$f"
done
