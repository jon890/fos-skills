#!/usr/bin/env bash
# 한국어 산출물을 두 검사기로 한 번에 검사한다.
#
# 검사기를 따로 부르면 앞의 것이 실패해도 뒤의 것이 그대로 돌아,
# 호출한 쪽이 종료 코드를 하나만 읽고 통과로 판단한다. 여기서 둘을 합쳐 낸다.
#
# 사용법:
#   check.sh <파일.md> [<파일.md>...]
#   check.sh --text "<제목이나 커밋 메시지>"
#   check.sh --where                       이 스킬 디렉터리 경로를 낸다
#
# 종료 코드:
#   0  둘 다 통과
#   1  한쪽 이상에서 위반 발견
#   2  검사기가 돌지 못함. 대상이 없거나 확장자가 .md 가 아니거나,
#      검사기나 매핑 표를 찾지 못한 경우다
#
# 종료 코드는 둘 중 큰 값을 낸다. 뒤에 돈 검사기의 값으로 덮으면
# "검사기가 돌지 못함" 이 "위반 발견" 으로 내려가고, 호출한 쪽은 보고된 위반만 고치고 넘어간다.
set -u

HERE="$(cd "$(dirname "$0")" && pwd -P)"
STYLE="$HERE/korean-style-check.sh"
READABILITY="$HERE/check-readability.py"

if [ "${1:-}" = "--where" ]; then
  dirname "$HERE"
  exit 0
fi

[ $# -gt 0 ] || { echo "검사할 파일이나 --text 가 필요하다" >&2; exit 2; }

for f in "$STYLE" "$READABILITY"; do
  [ -f "$f" ] || { echo "검사기가 없다: $f" >&2; exit 2; }
done

status=0
# 둘 중 큰 값을 남긴다. 2 는 1 을 덮고, 1 은 0 을 덮는다.
worst() {
  [ "$1" -gt "$status" ] && status="$1"
  return 0
}

# --text 는 파일이 아니라 문자열을 검사한다. 제목과 커밋 메시지가 이 경로로 들어온다.
# 금지어 검사기는 파일만 받으므로 문자열을 임시 .md 로 만들어 함께 검사한다.
if [ "${1:-}" = "--text" ]; then
  shift
  [ $# -gt 0 ] || { echo "--text 뒤에 검사할 문자열이 필요하다" >&2; exit 2; }

  # 금지어 검사기는 확장자가 .md 인 파일만 보므로 디렉터리를 만들어 그 안에 둔다.
  # 템플릿의 X 를 명시한다. -t 에 접두사만 주면 GNU coreutils 가 거부하고,
  # 그 실패를 넘기면 빈 경로에 쓰다 실패한 뒤에도 검사기를 불러 통과로 끝난다.
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/korean-check.XXXXXX")" || {
    echo "임시 디렉터리를 만들지 못했다" >&2; exit 2
  }
  trap 'rm -rf "$tmpdir"' EXIT
  tmp="$tmpdir/text.md"
  printf '%s\n' "$*" > "$tmp" || { echo "임시 파일에 쓰지 못했다: $tmp" >&2; exit 2; }

  # 임시 경로를 그대로 보이면 사용자가 열 수 없는 경로가 출력에 남는다.
  # 파이프라인의 종료 코드는 sed 것이 되므로 PIPESTATUS 로 검사기 것을 읽는다.
  "$STYLE" "$tmp" | sed "s|^$tmp|(문자열)|"
  worst "${PIPESTATUS[0]}"
  rc=0
  python3 "$READABILITY" --text "$*" || rc=$?
  worst "$rc"

  [ "$status" -eq 0 ] && echo "통과: 문자열"
  exit "$status"
fi

# 대상이 없거나 확장자가 다르면 검사기 한쪽만 돌아 절반만 검사된다.
# 실측으로, 없는 경로 둘을 주면 "통과: 2개 파일" 을 내며 0 으로 끝났고,
# .txt 를 주면 금지어 검사기가 건너뛰어 같은 내용이 통과로 나왔다.
for f in "$@"; do
  [ -f "$f" ] || { echo "대상이 없다: $f" >&2; exit 2; }
  case "$f" in
    *.md) ;;
    *) echo "확장자가 .md 가 아니라 절반만 검사된다: $f" >&2; exit 2 ;;
  esac
done

rc=0; "$STYLE" "$@" || rc=$?; worst "$rc"
rc=0; python3 "$READABILITY" "$@" || rc=$?; worst "$rc"

[ "$status" -eq 0 ] && echo "통과: $#개 파일"
exit "$status"
