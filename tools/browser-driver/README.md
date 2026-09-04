# 브라우저 드라이버

스킬 본문이 특정 브라우저 도구에 묶이지 않게 하는 중립 계층이다.
팀원마다 쓰는 도구가 달라도 같은 스킬이 그대로 돈다.

스킬은 `~/.claude/scripts/browser-driver` 만 부른다. 실제 조작은 백엔드가 맡는다.

## 구성

| 파일 | 하는 일 |
| --- | --- |
| `browser_driver.py` | 드라이버 전체. 백엔드 선택, 명령 처리, 도움말, 진단, 설치를 모두 담는다 |
| `browser.config.example.json` | 설정 예시 |

## 설치

```bash
./browser_driver.py install
```

`~/.claude/scripts/browser-driver` 심볼릭 링크를 만든다. `git pull` 만으로 최신이 반영된다.

셸 시절에 쓰던 `orca-browser.sh` 와 `browser-driver.sh` 는 `browser_driver.py` 에 흡수되거나 폐기됐다.
설치를 다시 돌리면 그 심볼릭 링크는 사라지고, 같은 이름의 실제 파일은 `.bak.{pid}` 로 백업된다.

## 명령

```bash
B=~/.claude/scripts/browser-driver
$B help     # 명령 목록. 지금 잡힌 백엔드에서 못 쓰는 명령을 함께 표시한다
$B doctor   # 백엔드 감지 결과와 준비 상태 판정
```

`help` 가 명령 목록과 인자를 소유한다. 이 문서는 목록을 다시 적지 않는다.

기본 흐름은 이렇다.

```bash
PAGE=$($B open "https://example.com")
$B js     "$PAGE" 'document.title'
$B waitjs "$PAGE" 'document.readyState === "complete"' 15000
$B close  "$PAGE"
```

핸들의 의미는 백엔드마다 다르다. `orca` 는 탭의 page id 를, `agent-browser` 는 세션 이름을 돌려준다.
드라이버는 이 값을 그대로 넘기기만 하므로 어느 쪽이든 같이 동작한다.

종료 코드는 `0` 성공, `1` 조작 실패, `2` 잘못된 호출이나 환경 문제다.

`js` 의 반환값은 백엔드와 무관하게 같은 형식으로 나온다.
문자열은 따옴표 없이, 객체와 배열은 여백 없는 JSON 으로 낸다.
`agent-browser` 의 `eval` 은 값을 JSON 으로 인코딩해 내므로 드라이버가 한 겹 벗긴다.
그대로 흘리면 `JSON.stringify` 결과를 파싱하는 소비자가 따옴표에서 깨진다 (실측).
`undefined` 는 예외다. `agent-browser` 는 `null` 을 내고 `orca` 는 값이 없다며 실패한다.

## 백엔드 선택

1. 환경변수 `BROWSER_DRIVER`
2. `~/.claude/browser.config.json` 의 `driver`
3. 자동 감지. `orca`, `agent-browser`, `cmux` 순으로 찾는다.
   `cmux` 가 마지막인 이유는 설치돼 있어도 cmux 밖에서는 쓸 수 없기 때문이다

설정 파일은 `browser.config.example.json` 을 복사해 만든다.
지금 무엇이 잡혔고 왜 잡혔는지는 `doctor` 가 알려준다.

## 백엔드별 상태

| 백엔드 | 실측 상태 | SSO 세션 | 쓰기 전 준비 |
| --- | --- | --- | --- |
| `orca` | APMS 상신과 전체 명령을 검증 | Orca 앱 로그인 세션을 그대로 쓴다 | 없음 |
| `agent-browser` | 11개 명령과 실패 종료 코드를 검증 | 붙은 Chrome 의 세션을 따른다 | 없음. SSO 가 필요하면 아래 함정을 본다 |
| `cmux` | 11개 명령과 실패 종료 코드를 검증 (0.64.22) | cmux 앱의 세션을 따른다 | cmux 안에서 에이전트를 돌린다. 아래 함정을 본다 |

## 함정

**백엔드는 실패해도 종료 코드가 0 이다.** 드라이버가 이것을 1 로 바꾸므로 백엔드를 직접 부르지 않는다.
직접 부르면 오류가 조용히 묻힌다.

- **`orca`**: `orca wait --load` 는 이미 로드된 페이지에서도 항상 시간이 초과되어 드라이버가 쓰지 않는다.
  `click`, `fill`, `select` 는 CSS 선택자가 아니라 화면 요소 참조를 받으므로, 동적 폼은 `js` 로 직접 조작한다.
  **탭은 셸의 작업 디렉토리가 속한 워크트리에 만들어진다.** 아래 「탭이 열리는 워크트리」를 본다.
- **`agent-browser`**: `cdpPort` 가 없으면 스스로 브라우저를 띄운다. 그 브라우저에는 로그인 세션이 없다.
  사내 시스템은 SSO 가 필요하므로 로그인이 살아 있는 Chrome 을 `--remote-debugging-port` 로 띄우고
  `cdpPort` 를 설정에 적어 그쪽에 붙인다. 빈 프로필로 띄운 Chrome 에 붙어도 로그인 화면에서 막힌다.
  조건 대기 명령이 없어서 드라이버가 `eval` 안의 폴링으로 대신한다.
  `worktree` 에 대응하는 개념이 없어 그 명령은 종료 코드 2 로 거절한다.
  `close` 뒤에도 핸들이 죽지 않고 다음 명령이 새 브라우저를 띄운다. `orca` 는 없는 탭이라고 실패한다.
- **`cmux`**: 소켓 접근이 기본으로 cmux 안에서 시작된 프로세스에만 허용된다
  (`automation.socketControlMode` 기본값 `cmuxOnly`). 밖에서 부르면 `Access denied` 로 끝난다.
  cmux 터미널에서 에이전트를 돌리거나, `~/.config/cmux/cmux.json` 에서 그 값을 `password` 로 두고
  `socketPassword` 를 적는다. `doctor` 가 지금 붙는지 판정한다.
  실패를 종료 코드로 정확히 알리는 유일한 백엔드다. 그래서 드라이버가 출력 표식을 보지 않는다.
  `worktree` 에 대응하는 개념이 없어 그 명령은 종료 코드 2 로 거절한다.
  `charset` 을 선언하지 않은 `file://` 문서를 UTF-8 로 추정하지 않는다. `orca` 는 추정한다 (실측).

## 탭이 열리는 워크트리

`orca` 백엔드에서만 해당한다.

`open` 은 셸의 작업 디렉토리가 속한 워크트리에 탭을 만든다.
조사하느라 다른 저장소로 옮긴 뒤 미리보기를 열면, 사용자가 보고 있는 워크트리가 아닌 곳에 탭이 생긴다.
`orca tab list` 도 현재 워크트리의 탭만 보여주므로 그 탭은 목록에서도 사라진다.
사용자에게는 "탭이 안 보인다" 로만 드러난다 (실측).

`--worktree active` 로는 막지 못한다. `active` 역시 작업 디렉토리를 따라간다 (실측).

사람이 볼 화면을 띄울 때는 `ORCA_WORKTREE` 로 워크트리를 고정한다.
값은 orca 의 셀렉터 표기를 그대로 쓴다.

```bash
ORCA_WORKTREE="path:$HOME/projects/MyRepo" $B open "file:///tmp/preview.html"
```

`open` 은 어느 워크트리에 열렸는지 stderr 로 한 줄 알린다.
기존 탭을 다시 쓰기 전에는 `worktree` 로 대조한다.

## 새 백엔드 추가

`browser_driver.py` 의 `Backend` 를 상속해 클래스 하나를 더하고 `BACKENDS` 에 등록한다.

- `supported` 에는 대응 명령을 **확인한 것만** 적는다. 나머지는 드라이버가 종료 코드 2 로 거절한다.
- 실패를 종료 코드로 알리지 않는 CLI 라면 출력에서 실패 표식을 찾아 `DriverError` 를 던진다.
- 조건 대기 명령이 없으면 `wait_expression` 으로 만든 폴링 표현식을 `eval` 에 넘긴다.
