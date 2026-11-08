---
name: browser
description: |
  CLI 나 공개 API 로 안 되는 웹 작업을 browser-driver 로 브라우저를 직접 조작해 끝낸다.
  "브라우저로 해 줘", "콘솔에서 만들어 줘", "웹 화면에서 확인해 줘", "화면으로 해야 하는 작업", "CLI 나 API 로 안 되는 작업",
  "관리 콘솔", "웹 콘솔 설정", "사이트에서 신청해 줘", "화면 캡처해 줘" 같은 요청이면 이 스킬을 쓴다.
  사용자가 브라우저를 말하지 않아도, 웹 화면에서만 되는 일을 「사람이 할 일」 로 넘기려는 순간 이 스킬로 할 수 있는지 먼저 본다.
  명령 목록과 반환값은 `browser-driver help`, 백엔드 함정은 `browser-driver/README.md` 가 소유한다.
  외부에 게시할 본문을 렌더링해 보이는 일은 `content-preview`, HTML 보고서를 띄우는 일은 `report` 가 맡는다.
  `ego-browser` 스킬이 같이 설치돼 있어도 에이전트의 웹 작업은 이 스킬이 먼저다. ego 는 browser-driver 가 쓰는 백엔드이고, 공간 분리, 로그인, 되돌리기 어려운 버튼의 확인은 이 스킬이 소유한다. ego 의 명령 문법만 필요할 때 `ego-browser` 스킬을 읽는다.
metadata:
  version: "2.0.0"
---

# browser

**목표: CLI 나 API 로 안 되는 웹 작업이 사람에게 넘어가지 않고 브라우저로 끝났고, 작업에 쓴 공간이 닫혔다.**

**이 문서의 `references/` 는 이 스킬 번들 기준 상대경로다.**
하네스가 알려 주는 스킬 base 디렉터리를 `$SKILL_DIR` 로 두고 붙여 쓴다.

- **CLI 와 공개 API 를 먼저 쓴다.** 브라우저 조작은 화면 구성이 바뀌면 깨지고 느리다. 같은 일을 하는 명령이 있으면 그것이 더 오래 맞는다.
- **「사람이 할 일」 로 넘기기 전에 이 스킬로 할 수 있는지 본다.** 로그인과 확인 버튼만 사람이 하고 나머지는 에이전트가 한다.
- **자격 증명을 넣지 않는다.** SSO 나 비밀번호 화면에서 멈추고 사용자가 직접 로그인한다.
- **되돌리기 어려운 버튼은 누르기 전에 확인받는다.** 결제, 삭제, 권한 변경, 결재 상신, 외부로 보내는 등록이 여기 해당한다.

## 워크플로우 개요

| 단계 | 이름 | 통과 조건 | reference |
| --- | --- | --- | --- |
| 1 | 길 고르기 | CLI 나 API 로 안 되는 이유가 한 줄로 있다 | |
| 2 | 준비 | 오버레이를 읽었고(없으면 없음을 확인했고) `doctor` 가 종료 코드 0 이다 | [`overlay.md`](references/overlay.md) |
| 3 | 공간 열기 | `BROWSER_EGO_SPACE` 를 정한 채 `open` 이 핸들을 냈다 | |
| 4 | 조작과 확인 | 작업 결과를 화면의 값이나 `shot` 으로 확인했다 | |
| 5 | 닫기 | 같은 공간 이름으로 `reset` 을 불렀다. 실패로 끝나도 부른다 | |
| 6 | 오버레이에 남기기 | 새로 안 화면 순서와 함정을 오버레이에 더했거나, 더할 것이 없다 | [`overlay.md`](references/overlay.md) |

1단계에서 CLI 나 API 로 되는 일이면 여기서 멈추고 그 길로 간다.
하위 에이전트나 worker 에게 브라우저 작업을 맡길 때는 [`references/delegation.md`](references/delegation.md) 의 지시 문구를 넘긴다.

## 1. 길 고르기

아래 순서로 보고 처음 되는 길을 쓴다.

1. 그 서비스의 CLI(`gh`, `nhncloud`, `dooray` 같은 것)나 이 세션에 있는 전용 스킬
2. 공개 API. 문서가 있고 토큰을 사용자가 이미 설정해 둔 것
3. 이 스킬로 브라우저 조작

브라우저로 가는 이유를 한 줄로 남긴다. 예: 「시나리오 생성 API 가 공개돼 있지 않다」.
이유를 쓸 수 없으면 1, 2번을 다시 찾는다.

## 2. 준비

**저장소 오버레이를 먼저 읽는다.** `<repo-root>/.claude/browser-overlay.md` 가 있으면 사이트 주소, 로그인 시작점, 화면 순서, 실측한 함정을 여기서 얻는다.
겹치는 판단은 오버레이가 코어보다 우선한다. 오버레이가 무엇을 담는지는 [`references/overlay.md`](references/overlay.md) 가 소유한다.

```bash
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) && cat "$ROOT/.claude/browser-overlay.md" 2>/dev/null || echo "오버레이 없음"
```

드라이버를 찾는다. Bash 호출마다 셸이 새로 뜨므로 출력된 절대 경로를 이후 호출에 그대로 쓴다.

```bash
for cand in "${BROWSER_DRIVER_PATH:-}" "$SKILL_DIR/browser-driver/browser_driver.ts" "$HOME/.claude/scripts/browser-driver" "$(command -v browser-driver)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then echo "$cand"; break; fi
done
```

아무것도 나오지 않으면 README 의 「링크로 설치」 대로 `~/.claude/scripts/browser-driver` 링크를 걸어 달라고 사용자에게 알린다.

```bash
B="$HOME/.claude/scripts/browser-driver"
"$B" doctor
"$B" help
```

`B` 는 위에서 찾은 경로로 바꾼다.
`doctor` 가 종료 코드 0 이 아니면 그 출력의 복구 안내를 사용자에게 그대로 알리고 멈춘다.
명령 목록, 반환값, 종료 코드는 `help` 가 소유한다. 이 문서에 다시 적지 않는다.
백엔드마다 갈리는 동작(핸들 형식, `js` 반환값, 프로필과 공간)은 [`browser-driver/README.md`](browser-driver/README.md) 가 소유한다. 이상한 동작을 만나면 그 문서부터 본다.

## 3. 공간 열기

**작업마다 공간 이름을 새로 정한다.** 이름을 주지 않으면 같은 프로필의 다른 에이전트와 기본 공간을 나눠 써 탭이 섞이고, 5단계의 `reset` 도 거절된다.
이름에는 저장소, 브랜치, 용도를 넣어 `spaces` 목록에서 내 것을 알아보게 한다.

```bash
B="$HOME/.claude/scripts/browser-driver"
URL="https://example.com"
export BROWSER_EGO_SPACE="my-repo feat-x 시나리오 생성"
PAGE=$("$B" open "$URL")
echo "$PAGE"
```

- `B`, `URL`, 공간 이름을 작업에 맞게 바꾼다. 다음 호출에서도 같은 `BROWSER_EGO_SPACE` 를 앞에 붙인다.
- **개인 계정 서비스는 `BROWSER_EGO_PURPOSE=personal` 로 연다.** 프로필을 정하지 않으면 설정의 기본 프로필(보통 회사 계정)로 열린다. 오버레이가 용도를 적어 두었으면 그 값을 쓴다.
- `open` 은 프로필과 공간을 stderr 에 한 줄 알린다. 핸들을 받을 때 `2>&1` 을 붙이지 않는다.

## 4. 조작과 확인

먼저 `url` 로 로그인 화면으로 튕겼는지 본다. 그다음 `snap` 이나 `shot` 으로 화면을 읽고 조작한다.

**로그인 화면이면 멈춘다.** 아이디, 비밀번호, OTP 를 입력하지 않고, 저장된 자격 증명을 찾아 넣지도 않는다.
사용자에게 「ego 브라우저의 `$BROWSER_EGO_SPACE` 공간에서 로그인해 주세요」 라고 알리고 답을 기다린다.
답을 받으면 `url` 로 로그인 화면을 벗어났는지 확인하고 이어 간다. 같은 프로필의 로그인 세션은 다음 작업에서도 쓰인다.

**되돌리기 어려운 버튼은 누르기 전에 확인받는다.**
누를 버튼, 그 버튼이 바꾸는 것, 지금 화면에 채운 값을 적어 묻는다. 확인을 받기 전에는 누르지 않는다.
판정이 애매하면 되돌리기 어려운 쪽으로 본다. 만들기만 하고 바로 지울 수 있는 것(초안 저장, 새 리소스 생성)은 묻지 않아도 된다.

조작의 기준은 아래와 같다.

- 고정 대기 대신 `waitjs` 로 조건을 기다린다.
- 동적 폼과 가려진 요소는 `js` 로, 합성 이벤트가 막히는 곳은 `shot` 으로 좌표를 보고 `click` 으로 누른다.
- 끝나면 결과를 화면에서 다시 읽는다. 「눌렀다」 가 아니라 목록에 새 항목이 보이는지, 상태 값이 바뀌었는지를 근거로 삼는다.
- 화면 순서가 오버레이와 다르면 실제 화면을 따르고, 다른 점을 6단계에서 오버레이에 고친다.

## 5. 닫기

**작업이 실패해도 같은 공간 이름으로 `reset` 을 부른다.** 부르지 않으면 공간이 ego 에 남아 쌓인다.

```bash
B="$HOME/.claude/scripts/browser-driver"
BROWSER_EGO_SPACE="my-repo feat-x 시나리오 생성" "$B" reset
```

`reset` 은 에이전트가 연 탭만 닫는다. 사용자가 로그인하려고 직접 연 탭이 남으면 공간도 남는다. 남았는지는 stderr 의 마지막 줄로 본다.
이전 작업이 남긴 공간은 `spaces` 로 찾아 `reset --space-id` 로 닫는다. 이름을 보고 내 것만 닫는다.

## 6. 오버레이에 남기기

이번 작업에서 새로 안 것이 있으면 그 자리에서 `<repo-root>/.claude/browser-overlay.md` 에 더한다.
다음 작업이 같은 화면을 다시 더듬지 않게 하려는 것이다.
무엇을 어떤 형식으로 더하는지, 공개 저장소에서는 어떻게 하는지는 [`references/overlay.md`](references/overlay.md) 의 「쓰는 법」 이 소유한다.
