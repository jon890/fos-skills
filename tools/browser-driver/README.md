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

## 부르는 쪽

`browser_driver.py` 하나가 백엔드 선택, 명령 처리, 도움말, 진단, 설치를 모두 담는다.
설정 예시는 `browser.config.example.json` 이다.

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
3. 자동 감지. 순서와 그 이유는 `browser_driver.py` 의 `DETECT_ORDER` 가 소유한다

## 백엔드마다 갈리는 것

**핸들의 의미가 다르다.** `orca` 는 탭의 page id 를, `agent-browser` 는 세션 이름을 돌려준다.
드라이버는 이 값을 그대로 넘기기만 하므로 어느 쪽이든 같이 동작한다.

**`js` 의 반환값은 드라이버가 같은 형식으로 맞춘다.**
문자열은 따옴표 없이, 객체와 배열은 여백 없는 JSON 으로 낸다.
`agent-browser` 의 `eval` 은 값을 JSON 으로 인코딩해 내므로 드라이버가 한 겹 벗긴다.
그대로 흘리면 `JSON.stringify` 결과를 파싱하는 소비자가 따옴표에서 깨진다 (실측).
`undefined` 는 예외다. `agent-browser` 는 `null` 을 내고 `orca` 는 값이 없다며 실패한다.

**`close` 뒤의 동작이 다르다.** `agent-browser` 는 핸들이 죽지 않아 다음 명령이 새 브라우저를 띄우고,
`orca` 는 없는 탭이라고 실패한다.

**`charset` 을 선언하지 않은 `file://` 문서를 `cmux` 는 UTF-8 로 추정하지 않는다.** `orca` 는 추정한다 (실측).

## 함정

**백엔드는 실패해도 종료 코드가 0 이다.** 드라이버가 이것을 1 로 바꾸므로 백엔드를 직접 부르지 않는다.
직접 부르면 오류가 드러나지 않는다.

`orca`

- `orca wait --load` 는 이미 로드된 페이지에서도 항상 시간이 초과되어 드라이버가 쓰지 않는다.
- `click`, `fill`, `select` 는 CSS 선택자가 아니라 화면 요소 참조를 받는다. 동적 폼은 `js` 로 직접 조작한다.
- 탭은 셸의 작업 디렉토리가 속한 워크트리에 만들어진다. 아래 「탭이 열리는 워크트리」 를 본다.

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

`browser_driver.py` 의 `Backend` 를 상속해 클래스 하나를 더하고 `BACKENDS` 에 등록한다.

- 실패를 종료 코드로 알리지 않는 CLI 라면 출력에서 실패 표식을 찾아 `DriverError` 를 던진다.
- 조건 대기 명령이 없으면 `wait_expression` 으로 만든 폴링 표현식을 `eval` 에 넘긴다.
