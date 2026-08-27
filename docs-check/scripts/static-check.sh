#!/usr/bin/env bash
# docs-check 가벼운 정적 검사 — 결정적으로 판정되는 위반만 검출한다.
# 사용법: static-check.sh [ADR_DIR] [DOC_SCOPE]
# cwd 는 검사 대상 <레포 root>. ADR_DIR 생략 시 Index 동기화 검사를 건너뛴다.
# DOC_SCOPE는 검사할 파일 또는 디렉터리이며 기본값은 저장소 전체다.
# 위반 라인을 stdout 으로 출력한다. 출력 0 줄이면 통과.
# 주의: grep 무매치가 exit 1 이므로 set -e 를 쓰지 않는다.
set -u
ADR_DIR="${1:-}"
DOC_SCOPE="${2:-.}"

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "사용법 오류: Git 저장소 루트에서 실행해야 한다." >&2
  exit 2
fi
if [ -n "$ADR_DIR" ] && [ ! -d "$ADR_DIR" ]; then
  echo "사용법 오류: ADR 디렉터리를 찾을 수 없다: $ADR_DIR" >&2
  exit 2
fi
if [ ! -e "$DOC_SCOPE" ]; then
  echo "사용법 오류: 문서 범위를 찾을 수 없다: $DOC_SCOPE" >&2
  exit 2
fi

RESULTS=$(mktemp)
trap 'rm -f "$RESULTS"' EXIT

# 검사 대상 마크다운 — 추적 파일과 미추적 신규 파일을 모두 본다.
#   `git ls-files` 만 쓰면 방금 만든 문서를 통째로 건너뛴 채 0 줄을 내, 거짓 통과가 된다.
#   docs-check 가 부르는 시점이 대개 문서를 새로 쓴 직후라 그 파일이 가장 중요한 검사 대상이다.
#   -c 추적 / -o 미추적 / --exclude-standard 로 gitignore 대상은 뺀다.
md_files() {
  if [ "$DOC_SCOPE" = "." ]; then
    git ls-files -co --exclude-standard '*.md' 2>/dev/null
  else
    git ls-files -co --exclude-standard -- "$DOC_SCOPE" 2>/dev/null | grep -E '\.md$'
  fi
}

{
if [ -n "$ADR_DIR" ] && [ -d "$ADR_DIR" ]; then
  # ADR Index 동기화 — 본문 ADR 번호가 Index 에 모두 있는가
  #   본문 번호는 헤딩(`## ADR-NNN`)만 센다. 아무 곳의 `ADR-NNN` 을 다 세면
  #   "향후 ADR은 ADR-009부터 추가" 같은 안내 문장이 실재하지 않는 ADR 로 잡혀 항상 불일치가 난다.
  BODY=$(grep -rhoE '^#+ ADR-[0-9]+' "$ADR_DIR"/*.md 2>/dev/null | grep -oE 'ADR-[0-9]+' | sort -u)
  #   INDEX.md 가 없는 구조(단일 파일 ADR 등)에서는 이 검사를 건너뛴다.
  #   없는 파일을 빈 Index 로 취급하면 본문 번호 전체가 "누락" 으로 잡혀 항상 불일치가 난다.
  if [ -f "$ADR_DIR/INDEX.md" ]; then
    INDEX=$(awk -F'|' '/^\| ADR-[0-9]+/ { gsub(/[[:space:]]/, "", $2); print $2 }' "$ADR_DIR"/INDEX.md 2>/dev/null | sort -u)
    if [ "$BODY" != "$INDEX" ]; then
      echo "INDEX_DESYNC: $ADR_DIR — 본문과 INDEX.md 의 ADR 번호 집합이 다르다"
      diff <(echo "$BODY") <(echo "$INDEX") | sed 's/^/  /'
    fi
  fi

fi

# 마크다운 문법 깨짐 — 렌더가 어긋나는 결정적 오류만 본다
#   `for f in $(md_files)` 는 공백 있는 파일명을 두 조각으로 쪼갠다.
#   쪼개진 경로는 존재하지 않아 awk·grep 이 stderr 로만 실패하고 stdout 에는 아무것도 안 남는다.
#   이 스크립트의 계약이 "출력 0 줄이면 통과" 라서 그대로 거짓 통과가 된다.
checked=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  checked=$((checked + 1))
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
  #   URL 스킴(`scheme://`)은 로컬 파일이 아니다. `http`·`mailto` 만 예외 처리하면
  #   `dooray://` 같은 앱 스킴을 상대 경로로 취급해 정상 링크를 전부 "깨진 링크" 로 보고한다.
  #   그 노이즈가 매 실행 반복되면 진짜 깨진 링크가 묻힌다.
  #   `/` 로 시작하는 경로는 발행 사이트의 루트 기준 URL 관례라 로컬 파일이 아니다.
  #   문서 사이트를 가리키는 링크(`/nhncloud/ko/...`)를 상대 경로로 붙이면 항상 없는 파일이 된다.
  awk '
    /^```/ { in_code = !in_code; next }
    in_code { next }
    {
      line = $0
      gsub(/`[^`]*`/, "", line)
      while (match(line, /\]\([^)#][^)]*\)/)) {
        target = substr(line, RSTART + 2, RLENGTH - 3)
        print target
        line = substr(line, RSTART + RLENGTH)
      }
    }
  ' "$f" | while read -r target; do
    case "$target" in
      *://*|mailto:*|/*|"") continue ;;
    esac
    [ -e "$(dirname "$f")/${target%%#*}" ] || echo "$f: 깨진 링크 → $target"
  done
done < <(md_files)
} >"$RESULTS"

echo "검사한 Markdown: ${checked}개 (scope: $DOC_SCOPE)" >&2
if [ "$checked" -eq 0 ]; then
  echo "검사 오류: 범위 안에서 Markdown 파일을 찾지 못했다." >&2
  exit 2
fi
cat "$RESULTS"
[ ! -s "$RESULTS" ]
