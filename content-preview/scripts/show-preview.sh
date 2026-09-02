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
#   4. 그 탭은 사용자가 보는 워크트리에 있어야 한다. 다른 워크트리에 열리면 갱신은 성공하는데
#      화면은 바뀌지 않아, 사용자는 미리보기가 열리지 않았다고 판단한다. 그래서 열거나 다시 쓸
#      때마다 워크트리를 대조하고, 어긋나면 그 탭을 닫고 기본 브라우저로 내려간다.
#
# 사용법:
#   show-preview.sh /path/to/preview.html

set -euo pipefail

FILE="${1:?미리보기 HTML 경로가 필요하다}"
[ -f "$FILE" ] || { echo "파일이 없다: $FILE" >&2; exit 2; }

ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
# AppleScript 대조는 전체 주소로 한다. basename 만 보면 다른 디렉터리의 같은 이름
# (preview.html 처럼 흔한 이름) 탭을 잡아 엉뚱한 화면을 갱신하고 앞으로 가져온다.
FILE_URL="file://$ABS"

# 1순위 — browser-driver 가 있으면 그것으로 띄운다.
# 어느 브라우저를 쓰는지는 드라이버가 정하므로 에이전트 IDE 안의 탭도 잡힌다.
# page id 를 HTML 옆에 남겨 다음 실행이 같은 탭을 다시 쓴다.
DRIVER="${BROWSER_DRIVER:-$HOME/.claude/scripts/browser-driver}"

# 사람이 보는 화면은 이 세션이 서 있는 워크트리다. ORCA_WORKTREE 가 없으면 현재 저장소 루트를
# 그 값으로 쓴다. 비워 두면 조사하느라 다른 저장소로 cd 한 채 만든 탭이 그대로 재사용되고,
# 갱신은 성공하는데 사용자 화면은 바뀌지 않는다 (실측: 다른 워크트리의 탭에 계속 갱신됐다).
if [ -n "${ORCA_WORKTREE:-}" ]; then
  WANT="${ORCA_WORKTREE#path:}"
else
  WANT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
if [ -x "$DRIVER" ]; then
  IDFILE="$ABS.tabid"
  if [ -f "$IDFILE" ]; then
    PAGE="$(cat "$IDFILE")"
    # 탭이 닫혔으면 url 조회가 실패한다. 그때는 아래에서 새로 연다.
    if [ -n "$PAGE" ] && "$DRIVER" url "$PAGE" >/dev/null 2>&1; then
      # 살아 있어도 사용자가 보는 곳의 탭이 아닐 수 있다. 조사하느라 다른 저장소로 cd 한 채
      # 만든 탭이 그대로 남으면, 갱신은 성공하는데 사용자 화면은 바뀌지 않는다 (실측).
      # 드라이버가 worktree 명령을 모르면 대조를 건너뛴다.
      if HAVE="$("$DRIVER" worktree "$PAGE" 2>/dev/null)" && [ -n "$HAVE" ] && [ "$HAVE" != "$WANT" ]; then
        echo "기존 탭이 다른 워크트리에 있다: $HAVE. 새로 연다." >&2
        PAGE=""
      fi
      if [ -n "$PAGE" ] && "$DRIVER" nav "$PAGE" "$FILE_URL" >/dev/null 2>&1; then
        echo "갱신: 기존 탭 ($PAGE)"
        exit 0
      fi
      [ -n "$PAGE" ] && echo "기존 탭을 찾았으나 갱신하지 못했다. 새로 연다." >&2
    fi
  fi
  if PAGE="$("$DRIVER" open "$FILE_URL" 2>/dev/null)" && [ -n "$PAGE" ]; then
    # 쓰기에 실패해도 탭은 이미 열렸다. set -e 로 조용히 죽지 않게 알리고 계속한다.
    printf '%s\n' "$PAGE" >| "$IDFILE" 2>/dev/null \
      || echo "탭 id 를 남기지 못했다. 다음 실행은 새 탭을 연다: $IDFILE" >&2
    echo "새로 열었다: $ABS"
    # 어느 워크트리에 열렸는지 함께 알린다. 사용자가 탭을 찾지 못하는 상황을 바로 드러낸다.
    if WT="$("$DRIVER" worktree "$PAGE" 2>/dev/null)" && [ -n "$WT" ]; then
      echo "탭 위치: $WT"
      if [ "$WT" != "$WANT" ]; then
        # 여기서 성공으로 끝내면 사용자는 보이지 않는 탭을 찾다가 미리보기가 열리지 않았다고 판단한다.
        echo "이 탭은 사용자가 보는 워크트리($WANT)가 아니다. 기본 브라우저로 다시 띄운다." >&2
        # 남겨 두면 다음 실행이 다시 집어 갈 수 있고, 사용자가 찾지 못하는 탭만 쌓인다.
        "$DRIVER" close "$PAGE" >/dev/null 2>&1 || true
        rm -f "$IDFILE"
        PAGE=""
      fi
    fi
    if [ -n "$PAGE" ]; then
      exit 0
    fi
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
      if URL of t is equal to "$FILE_URL" then
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
      if URL of t is equal to "$FILE_URL" then
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
  if xdg-open "$ABS" >/dev/null 2>&1; then
    echo "새로 열었다: $ABS"
    echo "이 환경은 기존 탭 갱신을 지원하지 않는다. 재생성하면 탭이 하나 더 열린다."
    exit 0
  fi
  echo "xdg-open 으로 열지 못했다: $ABS" >&2
  exit 2
fi

echo "브라우저를 열 방법을 찾지 못했다. 직접 열어야 한다: $ABS" >&2
exit 2
