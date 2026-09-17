# 브라우저 드라이버

스킬 본문이 특정 브라우저 도구에 묶이지 않게 하는 중립 계층이다.
팀원마다 쓰는 도구가 달라도 같은 스킬이 그대로 돈다.

**명령 목록, 반환값 규약, 종료 코드는 `help` 가 소유한다.**
**지금 무엇이 잡혔고 왜 잡혔는지는 `doctor` 가 낸다.** 이 문서는 둘 다 다시 적지 않는다.

```bash
B=~/.claude/scripts/browser-driver
$B help
$B doctor
```

이 문서는 그 둘이 내지 않는 것을 담는다. 백엔드 선택 규칙, 백엔드마다 갈리는 동작, 함정, 새 백엔드 추가다.

## 구성

| 파일 | 담는 것 |
| --- | --- |
| `browser_driver.py` | 진입점. 명령을 나눠 보내고 예외를 종료 코드로 바꾼다 |
| `driver/commands.py` | 명령 스펙과 `help` 렌더 |
| `driver/config.py` | 설정 파일과 기본 제한 시간 |
| `driver/errors.py` | 예외와 종료 코드 |
| `driver/shell.py` | 백엔드 프로세스 호출과 반환값 정규화 |
| `driver/admin.py` | `doctor` 와 `install` |
| `driver/backends/__init__.py` | 백엔드 목록과 선택 규칙 |
| `driver/backends/base.py` | 백엔드 공통 계약 |
| `driver/backends/ego.py`, `orca.py`, `agent_browser.py`, `cmux.py` | 백엔드 하나씩 |
| `browser.config.example.json` | 설정 예시 |

진입점만 실행 파일이다. 심링크로 불려도 실체 경로를 잡아 옆의 `driver` 패키지를 찾는다.

## 부르는 쪽

스킬은 이 드라이버를 세 자리에서 찾는다. 환경변수 `BROWSER_DRIVER`, 스킬과 함께 받은 저장소 안,
개인이 걸어 둔 `~/.claude/scripts/browser-driver` 순이다.

전역에서 부르려면 심볼릭 링크를 만든다. `git pull` 만으로 최신이 반영된다.

```bash
./browser_driver.py install
```

같은 이름의 실제 파일이 있으면 `.bak.{pid}` 로 옮긴 뒤 링크를 건다.

## 백엔드 선택

1. 환경변수 `BROWSER_DRIVER`
2. `~/.claude/browser.config.json` 의 `driver`
3. 자동 감지. 순서와 그 이유는 `driver/backends/__init__.py` 의 `DETECT_ORDER` 가 소유한다

**용도가 갈리면 부르는 쪽이 백엔드를 고정한다.** 자동 감지는 쓸 수 있는 것을 고르는 규칙이고
그 호출에 알맞은 것을 고르는 규칙이 아니다.
사람이 읽을 화면을 띄우는 쪽은 `orca` 를, 사람이 보지 않는 자동화는 `ego` 를 고정하는 편이 맞다.
`content-preview` 의 `show-preview.sh` 가 그렇게 `orca` 를 고정한다.

## 백엔드마다 갈리는 것

**핸들의 의미가 다르다.** `orca` 는 탭의 page id 를, `agent-browser` 는 세션 이름을,
`ego` 는 `<spaceId>:<pageLabel>` 을 돌려준다.
드라이버는 이 값을 그대로 넘기기만 하므로 어느 쪽이든 같이 동작한다.

**`js` 의 반환값은 드라이버가 같은 형식으로 맞춘다.**
문자열은 따옴표 없이, 객체와 배열은 여백 없는 JSON 으로 낸다.
`agent-browser` 의 `eval` 은 값을 JSON 으로 인코딩해 내므로 드라이버가 한 겹 벗긴다.
그대로 흘리면 `JSON.stringify` 결과를 파싱하는 소비자가 따옴표에서 깨진다 (실측).
`ego` 의 `evaluate` 는 `undefined` 를 `null` 로 바꿔 내보내 그 둘을 구분할 수 없으므로,
드라이버가 표현식을 페이지 안에서 한 겹 감싸 어느 쪽인지를 따로 받는다 (실측).
`agent-browser` 는 `undefined` 에 `null` 을 낸다.

**`close` 뒤의 동작이 다르다.** `agent-browser` 는 핸들이 죽지 않아 다음 명령이 새 브라우저를 띄우고,
`orca` 와 `ego` 는 없는 탭이라고 실패한다 (실측).

**`charset` 을 선언하지 않은 `file://` 문서를 `cmux` 는 UTF-8 로 추정하지 않는다.** `orca` 는 추정한다 (실측).

## 함정

**`orca` 와 `agent-browser` 는 실패해도 종료 코드가 0 이다.** 드라이버가 이것을 1 로 바꾸므로
백엔드를 직접 부르지 않는다. 직접 부르면 오류가 드러나지 않는다.
`ego` 와 `cmux` 는 종료 코드로 알린다.

`orca`

- `orca wait --load` 는 이미 로드된 페이지에서도 항상 시간이 초과되어 드라이버가 쓰지 않는다.
- `click`, `fill`, `select` 는 CSS 선택자가 아니라 화면 요소 참조를 받는다. 동적 폼과 화면에 나타나지 않는 요소, 다른 요소에 가려진 화면은 `js` 로 직접 조작한다.
- 탭은 셸의 작업 디렉토리가 속한 워크트리에 만들어진다. 아래 「탭이 열리는 워크트리」 를 본다.

`ego`

- 탭은 `browser-driver/<프로필 id>` 라는 TaskSpace 에 모인다. `open` 을 여러 번 불러도 같은
  프로필의 호출은 같은 공간에 page 만 늘어난다. 새 공간의 `p1` 은 빈 페이지라 첫 `open` 이
  그것을 쓰고, 그 뒤의 `open` 이 `p2`, `p3` 을 만든다.
- 사용자가 브라우저에서 그 공간의 제어권을 가져가면 그 공간의 모든 호출이 거절된다 (실측).
  이름만으로 공간을 잡으면 그 뒤로 계속 거절되므로, `open` 은 에이전트가 가진 공간만 골라
  다시 쓰고 없으면 `browser-driver/Profile 2 #2` 처럼 번호를 붙여 새로 만든다.
  이미 받은 핸들로는 되살릴 수 없다. `open` 을 다시 부른다.
- `console` 과 `errors` 는 대응 API 가 없어 종료 코드 2 로 거절한다.
  `page.events()` 는 버퍼를 비우는 프로토콜 이벤트 배열이라 콘솔 로그 버퍼가 아니다.
- 조건 대기는 폴링이 아니라 ego 의 `waitForFunction` 과 `waitForLoadState` 를 그대로 쓴다.
- 실패를 종료 코드 1 로 알린다. 그래서 드라이버가 출력 표식을 보지 않는다.

`agent-browser`

- SSO 가 필요한 사내 시스템은 설정에 `cdpPort` 를 적어야 한다. 상세는 `doctor` 가 낸다.
- 조건 대기 명령이 없어서 드라이버가 `eval` 안의 폴링으로 대신한다.

`cmux`

- 소켓 접근이 기본으로 cmux 안에서 시작된 프로세스에만 허용된다
  (`automation.socketControlMode` 기본값 `cmuxOnly`). 밖에서 부르면 `Access denied` 로 끝난다.
  cmux 터미널에서 에이전트를 돌리거나, `~/.config/cmux/cmux.json` 에서 그 값을 `password` 로 두고
  `socketPassword` 를 적는다. `doctor` 가 지금 붙는지 판정한다.
- 실패를 종료 코드로 정확히 알리는 유일한 백엔드다. 그래서 드라이버가 출력 표식을 보지 않는다.

`worktree` 명령은 `orca` 에만 있다. 나머지는 종료 코드 2 로 거절한다.

## 로그인 세션과 프로필

`ego` 백엔드에서만 해당한다.

**로그인 세션의 경계는 TaskSpace 가 아니라 브라우저 프로필이다.**
`example.com` 에 쿠키와 `localStorage` 를 심고 다른 곳에서 읽어 확인했다 (실측).

| 읽는 곳 | 쿠키 | localStorage |
| --- | --- | --- |
| 같은 프로필의 다른 TaskSpace | 보인다 | 보인다 |
| 다른 프로필의 TaskSpace | 빈 문자열 | `null` |

사용자가 손으로 열어 둔 탭도 같은 프로필의 쿠키 저장소를 함께 쓴다.
그래서 공간을 여러 개로 나눠도 세션은 나뉘지 않는다.
개인 작업과 회사 자동화를 나누는 수단은 프로필이다.

```bash
BROWSER_EGO_PROFILE="Profile 2" $B open "https://example.com"
BROWSER_EGO_PROFILE="BiFOS"     $B open "https://example.com"
```

- 프로필 id 와 이름을 모두 받는다. `profiles()` 의 `id` 와 `name` 을 그 순서로 대조한다.
- 값이 없으면 ego 의 기본 프로필을 쓴다. 그래서 `open` 은 어느 프로필에서 열렸는지
  표준 오류로 한 줄 알린다. 지정을 빠뜨려 개인 세션에서 도는 것을 여기서 드러낸다.
- 없는 프로필을 주면 쓸 수 있는 목록을 붙여 종료 코드 1 로 끝난다.
- 프로필은 공간을 만들 때 정해지고 나중에 바꿀 수 없다. 이미 받은 핸들의 프로필을
  바꾸려면 `open` 을 다시 부른다.

**id 가 이름과 엇갈려 있을 수 있다.** 이 머신에서는 ego 의 `Default` 가 개인 계정이고
`Profile 2` 가 회사 계정이다 (실측). id 만 보고 `Default` 를 기본으로 읽으면 반대를 고른다.
어느 쪽이 무엇인지는 `ego-browser import list` 의 메일 주소와 `profiles()` 의 이름을 대조해 정한다.

프로필 전체를 지우는 CDP 명령은 프로필 단위로 미친다.
그 상세는 `ego-browser` 스킬의 `references/clearing-state.md` 가 소유한다.

## 탭이 열리는 워크트리

`orca` 백엔드에서만 해당한다.

`open` 은 셸의 작업 디렉토리가 속한 워크트리에 탭을 만든다.
조사하느라 다른 저장소로 옮긴 뒤 미리보기를 열면, 사용자가 보고 있는 워크트리가 아닌 곳에 탭이 생긴다.
`orca tab list` 도 현재 워크트리의 탭만 보여주므로 그 탭은 목록에서도 사라진다.
사용자에게는 탭이 보이지 않는 것으로만 드러난다 (실측).

`--worktree active` 로는 막지 못한다. `active` 역시 작업 디렉토리를 따라간다 (실측).

사람이 볼 화면을 띄울 때는 `ORCA_WORKTREE` 로 워크트리를 고정한다.
값은 orca 의 셀렉터 표기를 그대로 쓴다.

```bash
ORCA_WORKTREE="path:$HOME/projects/MyRepo" $B open "file:///tmp/preview.html"
```

`open` 은 어느 워크트리에 열렸는지 표준 오류로 한 줄 알린다.
기존 탭을 다시 쓰기 전에는 `worktree` 로 대조한다.

## 새 백엔드 추가

`driver/backends/` 에 파일 하나를 더한다.
`base.py` 의 `Backend` 를 상속하고 `__init__.py` 의 `BACKENDS` 에 등록한다.

- 실패를 종료 코드로 알리지 않는 CLI 라면 출력에서 실패 표식을 찾아 `DriverError` 를 던진다.
  종료 코드로 알리는 CLI 라면 `run` 에 `check_exit=True` 를 준다.
- 조건 대기 명령이 없으면 `wait_expression` 으로 만든 폴링 표현식을 `eval` 에 넘긴다.
  그 백엔드에 대기 API 가 있으면 폴링으로 대신하지 말고 그것을 쓴다.
- `js` 의 반환값은 `shell.py` 의 `js_value` 를 거쳐 낸다. 백엔드마다 형식이 갈리면
  같은 표현식이 다른 바이트로 나온다.
