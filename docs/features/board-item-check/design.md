# 보드 항목 상태 확인 단축키: 기술 설계

스펙: [spec.md](spec.md). 작은 화면 기능이라 스펙의 「설계」 절을 이 문서가 검사 형식으로 옮겨 적는다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | 모듈 변수 `checkMode` 와 `c` Button 이 켜고 끈다. 켜지면 `checkTargets(items)` 의 앞 9개 항목 머리 표시를 hotkey Button 으로 그린다. Esc 는 `ui.close` 훅이 받아 모드만 끈다 |
| REQ2 | `checkPrompt(item, worker, prs)` 가 항목 id, 제목, 끝나지 않은 단계, worker, PR 번호를 넣은 요청문을 만들고 `fillPrompt` 로 채운다 |
| REQ3 | 요청문의 지시 부분은 상수 `CHECK_PROMPT` 하나가 소유한다 |
| REQ4 | 단축키 상자는 `checkTargets(items)` 가 비지 않았을 때만 `c` Button 을 넣는다 |

## 책임과 경계

- 바뀌는 곳은 `work-board/hooks/register.js` 하나다. 보드 파일 형식과 `board.ts` 는 바꾸지 않는다.
- 요청문은 입력란을 채울 뿐이다. 보내기는 사람이 Enter 로 한다(훅의 텍스트는 모델에 닿지 않는다).

## 인터페이스와 데이터

- `checkTargets(items)`: status 가 doing 인 항목, 다음 wait 인 항목을 파일 순서로 모아 앞 9개를 돌려준다. 창이 그리는 순서와 같다.
- `checkPrompt(item, worker, prs)`: 문자열. 끝나지 않은 단계는 `stepRows` 의 단계 줄 가운데 now, todo 인 것이다. worker 는 `workerLine` 으로 적는다. PR 은 `prNumbers(item.pr)` 다.
- Button key: 단축키 상자의 `item-check`, 항목 머리의 `check-<id>`.

## 실패와 일관성

- 같은 hotkey 의 Button 이 둘이면 뒤에 그린 것이 이긴다(Claude Code 2.1.316 타입 문서). 그래서 확인 모드 동안 알림 Button 은 hotkey 를 떼고 같은 번호 글자를 직접 그린다. 알림 번호는 그대로 보인다.
- `x`(알림 넘기기)와 `c` 는 동시에 켜지지 않는다. 하나를 켜면 다른 하나를 끈다.
- 대상이 없어지면(보드 갱신으로 항목이 끝남) 모드를 끈다. `/board` 를 다시 열 때도 끈다.

## 검증 전략

- `work-board/tests/check.spec.ts`: `checkTargets` 의 순서와 9개 제한, `checkPrompt` 의 내용.
- `work-board/tests/pane.test.ts`: `c` 진입과 해제(다시 `c`, 창 닫기), 번호별 요청문, 대상 없음일 때 `c` 숨김, 확인 모드에서 알림 번호의 글자가 그대로이고 hotkey 가 겹치지 않음.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 확인 모드의 알림 Button | hotkey 를 떼고 번호 글자를 직접 그린다 | 작성자 | 같은 hotkey 가 둘이면 그린 순서에 기대게 된다 |
| DECISION2 | 번호를 누른 뒤 | 모드를 끈다 | 작성자 | 알림 `x` 의 넘기기와 같다 |
| DECISION3 | Esc | 확인 모드면 창을 닫지 않고 모드만 끈다 | 작성자 | 스펙 REQ1 의 인수 조건 |
