#!/usr/bin/env bash
# 미리보기 HTML 을 사용자 화면에 띄운다. 같은 파일이 이미 열려 있으면 새 탭을 만들지 않고 갱신한다.
#
# 왜 이렇게 하는가 (실측):
#   1. 에이전트 브라우저에 탭을 만들면 사용자 화면에 드러나지 않는다. 탭은 생기는데 보이지 않아
#      사용자가 미리보기를 찾지 못한다. 미리보기는 사람이 읽어야 하므로 기본 브라우저로 띄운다.
#   2. 본문을 고쳐 같은 경로로 재생성할 때마다 탭이 쌓인다. 사용자는 어느 탭이 새 본문인지
#      알 수 없고, 오래된 탭을 읽고 판단한다.
#   3. 에이전트 IDE 안의 브라우저(orca 등)로 보는 사람은 위 두 경로로 찾을 수 없다.
#      AppleScript 는 Chrome 계열과 Safari 만 훑기 때문이다. browser-driver 가 있으면
#      백엔드 판단을 그쪽에 맡기고, 돌려받은 page id 로 같은 탭을 다시 쓴다.
#
# 사용법:
#   show-preview.sh /path/to/preview.html

set -euo pipefail

FILE="${1:?미리보기 HTML 경로가 필요하다}"
[ -f "$FILE" ] || { echo "파일이 없다: $FILE" >&2; exit 2; }

ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
BASE="$(basename "$ABS")"

# 1순위 — browser-driver 가 있으면 그것으로 띄운다.
# 어느 브라우저를 쓰는지는 드라이버가 정하므로 에이전트 IDE 안의 탭도 잡힌다.
# page id 를 HTML 옆에 남겨 다음 실행이 같은 탭을 다시 쓴다.
DRIVER="${BROWSER_DRIVER:-$HOME/.claude/scripts/browser-driver}"
if [ -x "$DRIVER" ]; then
  IDFILE="$ABS.tabid"
  if [ -f "$IDFILE" ]; then
    PAGE="$(cat "$IDFILE")"
    # 탭이 닫혔으면 url 조회가 실패한다. 그때는 아래에서 새로 연다.
    if [ -n "$PAGE" ] && "$DRIVER" url "$PAGE" >/dev/null 2>&1; then
      if "$DRIVER" nav "$PAGE" "file://$ABS" >/dev/null 2>&1; then
        echo "갱신: 기존 탭 ($PAGE)"
        exit 0
      fi
      echo "기존 탭을 찾았으나 갱신하지 못했다. 새로 연다." >&2
    fi
  fi
  if PAGE="$("$DRIVER" open "file://$ABS" 2>/dev/null)" && [ -n "$PAGE" ]; then
    printf '%s\n' "$PAGE" >| "$IDFILE"
    echo "새로 열었다: $ABS"
    exit 0
  fi
  # 여기까지 왔으면 드라이버가 실패한 것이다. 조용히 넘어가지 않고 알린 뒤 기본 브라우저로 간다.
  echo "browser-driver 로 열지 못했다. 기본 브라우저로 내려간다." >&2
fi

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

  if open "$ABS"; then
    echo "새로 열었다: $ABS"
    exit 0
  fi
  echo "기본 브라우저로 열지 못했다: $ABS" >&2
  exit 2
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$ABS" >/dev/null 2>&1
  echo "새로 열었다: $ABS"
  echo "이 환경은 기존 탭 갱신을 지원하지 않는다. 재생성하면 탭이 하나 더 열린다."
  exit 0
fi

echo "브라우저를 열 방법을 찾지 못했다. 직접 열어야 한다: $ABS" >&2
exit 2
