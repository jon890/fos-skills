#!/usr/bin/env bash
# 미리보기 HTML 을 사용자 화면에 띄운다. 같은 파일이 이미 열려 있으면 새 탭을 만들지 않고 갱신한다.
#
# 왜 이렇게 하는가 (실측):
#   1. 에이전트 브라우저에 탭을 만들면 사용자 화면에 드러나지 않는다. 탭은 생기는데 보이지 않아
#      사용자가 미리보기를 찾지 못한다. 미리보기는 사람이 읽어야 하므로 기본 브라우저로 띄운다.
#   2. 본문을 고쳐 같은 경로로 재생성할 때마다 탭이 쌓인다. 사용자는 어느 탭이 새 본문인지
#      알 수 없고, 오래된 탭을 읽고 판단한다.
#
# 사용법:
#   show-preview.sh /path/to/preview.html

set -euo pipefail

FILE="${1:?미리보기 HTML 경로가 필요하다}"
[ -f "$FILE" ] || { echo "파일이 없다: $FILE" >&2; exit 2; }

ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
BASE="$(basename "$ABS")"

# macOS 에서만 기존 탭을 찾아 갱신할 수 있다. 다른 환경은 새로 여는 것으로 내려간다.
if [ "$(uname -s)" = "Darwin" ]; then
  for app in "Google Chrome" "Microsoft Edge" "Brave Browser"; do
    result=$(osascript <<AS 2>/dev/null || true
tell application "System Events"
  if not (exists process "$app") then return "absent"
end tell
tell application "$app"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      if URL of t contains "$BASE" then
        tell t to reload
        set active tab index of w to i
        set index of w to 1
        activate
        return "reloaded"
      end if
    end repeat
  end repeat
end tell
return "notfound"
AS
)
    if [ "$result" = "reloaded" ]; then
      echo "갱신: $app 의 기존 탭"
      exit 0
    fi
  done

  # Safari 는 탭을 앞으로 가져오는 방식이 달라 따로 처리한다.
  result=$(osascript <<AS 2>/dev/null || true
tell application "System Events"
  if not (exists process "Safari") then return "absent"
end tell
tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "$BASE" then
        set URL of t to (URL of t)
        set current tab of w to t
        set index of w to 1
        activate
        return "reloaded"
      end if
    end repeat
  end repeat
end tell
return "notfound"
AS
)
  if [ "$result" = "reloaded" ]; then
    echo "갱신: Safari 의 기존 탭"
    exit 0
  fi

  open "$ABS"
  echo "새로 열었다: $ABS"
  exit 0
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$ABS" >/dev/null 2>&1
  echo "새로 열었다: $ABS"
  echo "이 환경은 기존 탭 갱신을 지원하지 않는다. 재생성하면 탭이 하나 더 열린다."
  exit 0
fi

echo "브라우저를 열 방법을 찾지 못했다. 직접 열어야 한다: $ABS" >&2
exit 2
