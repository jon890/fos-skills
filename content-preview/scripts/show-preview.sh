#!/bin/bash
# 미리보기 HTML 을 사용자 화면에 띄운다. 같은 파일의 탭이 이미 있으면 새로 만들지 않고 갱신한다.
#
# 왜 필요한가 (실측):
#   1. `orca tab create` 는 탭을 만들기만 하고 앞으로 가져오지 않는다. 사용자가 화면을
#      찾지 못한다. `orca tab switch --focus` 가 빠진 단계다.
#   2. 본문을 고쳐 같은 경로로 재생성하면 탭이 또 쌓인다. 사용자는 어느 탭이 새 본문인지
#      알 수 없고, 오래된 탭을 읽고 판단한다.
#
# 사용법:
#   show-preview.sh /path/to/preview.html
set -euo pipefail

FILE="${1:?미리보기 HTML 경로가 필요하다}"
[[ -f "$FILE" ]] || { echo "파일이 없다: $FILE" >&2; exit 2; }

ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
URL="file://$ABS"

if ! command -v orca >/dev/null 2>&1; then
  open "$ABS"
  echo "orca 가 없어 기본 브라우저로 열었다: $ABS"
  exit 0
fi

PAGE=$(orca tab list --json 2>/dev/null | ORCA_URL="$URL" python3 -c '
import json, os, sys
url = os.environ["ORCA_URL"]
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for t in d.get("result", {}).get("tabs", []):
    if t.get("url") == url:
        print(t.get("browserPageId", ""))
        break
')

if [[ -n "$PAGE" ]]; then
  # 같은 URL 로 다시 이동시켜 새 본문을 읽게 한다. reload 보다 확실하다.
  orca goto --url "$URL" --page "$PAGE" >/dev/null 2>&1 || true
  orca tab switch --page "$PAGE" --focus >/dev/null 2>&1 || true
  echo "갱신: 기존 탭 $PAGE"
  exit 0
fi

PAGE=$(orca tab create --url "$URL" --json 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
r = d.get("result", {})
print(r.get("browserPageId") or r.get("pageId") or "")
')

if [[ -n "$PAGE" ]]; then
  orca tab switch --page "$PAGE" --focus >/dev/null 2>&1 || true
  echo "새 탭: $PAGE"
else
  open "$ABS"
  echo "orca 탭 생성에 실패해 기본 브라우저로 열었다: $ABS"
fi
