# 보드 항목 상태 확인 단축키: 기술 설계

스펙: [spec.md](spec.md). 작은 화면 기능이라 스펙의 「설계」 절을 이 문서가 검사 형식으로 옮겨 적는다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | 모듈 변수 `checkMode` 와 `c` Button 이 켜고 끈다. 켜지면 `checkTargets(items)` 의 앞 9개 항목 머리 표시를 hotkey Button 으로 그린다. Esc 는 `ui.close` 훅이 받아 모드만 끈다 |
| REQ2 | `itemPrompt(item, worker, prs)` 가 상태별 요청문을 골라 `fillPrompt` 로 채운다. 진행 중 항목은 `checkPrompt` 가 항목 id, 제목, 끝나지 않은 단계, worker, PR 번호를 넣고, 대기 항목은 `resumePrompt` 가 대기 사유와 업무 주소를 더해 재개를 시킨다(work-board 1.14.0) |
| REQ3 | 요청문의 지시 부분은 상수 `CHECK_PROMPT` 하나가 소유한다 |
| REQ4 | 단축키 상자는 `checkTargets(items)` 가 비지 않았을 때만 `c` Button 을 넣는다 |
| REQ5 | `checkable(item)` 이 참인 항목(진행 중, 대기)은 머리 줄의 표시와 제목을 `check-<id>` Button 하나로 그린다. hotkey 는 확인 모드에서 앞 9개에만 준다 |

## 책임과 경계

- 바뀌는 곳은 `extensions/work-board/hooks/register.js` 하나다. 보드 파일 형식과 `board.ts` 는 바꾸지 않는다.
- 요청문은 입력란을 채울 뿐이다. 보내기는 사람이 Enter 로 한다(훅의 텍스트는 모델에 닿지 않는다).

## 인터페이스와 데이터

- `checkTargets(items)`: status 가 doing 인 항목, 다음 wait 인 항목을 파일 순서로 모아 앞 9개를 돌려준다. 창이 그리는 순서와 같다.
- `checkPrompt(item, worker, prs)`: 문자열. 끝나지 않은 단계는 `stepRows` 의 단계 줄 가운데 now, todo 인 것이다. worker 는 `workerLine` 으로 적는다. PR 은 `prNumbers(item.pr)` 다.
- `resumePrompt(item, worker, prs)`: 대기 항목의 재개 요청문. 대기 사유는 `waitReasons(item)` 로, `stepRows` 의 now, todo 줄과 「대기」, 「기다」, 「회신」 이 든 note 줄이다. 지시 부분은 상수 `RESUME_PROMPT` 가 소유한다.
- `checkable(item)`: status 가 doing 이나 wait 이면 참이다. 9개 제한이 없어 10번째 항목도 클릭할 수 있다.
- Button key: 단축키 상자의 `item-check`, 항목 머리의 `check-<id>`. `check-<id>` 는 모드와 무관하게 늘 그리고, hotkey 만 확인 모드에서 붙는다.
- Button 의 자식은 문자열과 Text 만 받는다(2.1.316 타입 문서). 제목에 업무 링크가 있으면 링크 앞 글까지를 Button 에 넣고, 링크와 그 뒤 글은 Button 밖에 이어 그린다. 이때 머리 줄은 columnGap 을 0 으로 두고 표시 뒤 칸과 제목의 띄어쓰기를 그대로 쓴다.

## 실패와 일관성

- 같은 hotkey 의 Button 이 둘이면 뒤에 그린 것이 이긴다(Claude Code 2.1.316 타입 문서). 그래서 확인 모드 동안 알림 Button 은 hotkey 를 떼고 같은 번호 글자를 직접 그린다. 알림 번호는 그대로 보인다.
- `x`(알림 넘기기)와 `c` 는 동시에 켜지지 않는다. 하나를 켜면 다른 하나를 끈다.
- 항목 클릭의 모드별 동작: 평소에는 요청문을 채운다. 확인 모드에서는 요청문을 채우고 모드를 끈다(번호를 누른 것과 같다). 넘기기 모드에서는 아무것도 하지 않는다. 그 모드의 누르기는 알림을 넘기는 뜻이라 다른 요청문이 채워지면 헷갈린다.
- 숫자 단축키를 평소에 붙이지 않는다. 알림 Button 이 같은 숫자를 쓰고, 같은 hotkey 가 둘이면 뒤에 그린 것이 이긴다.
- 대상이 없어지면(보드 갱신으로 항목이 끝남) 모드를 끈다. `/board` 를 다시 열 때도 끈다.

## 검증 전략

- `extensions/work-board/tests/check.spec.ts`: `checkTargets` 의 순서와 9개 제한, `checkPrompt` 의 내용.
- `extensions/work-board/tests/pane.test.ts`: `c` 진입과 해제(다시 `c`, 창 닫기), 번호별 요청문, 대상 없음일 때 `c` 숨김, 확인 모드에서 알림 번호의 글자가 그대로이고 hotkey 가 겹치지 않음. 클릭 경로(REQ5)는 `c` 없이 누르기, 완료·결정 항목과 펼친 보기의 상세 줄이 Button 이 아님, 넘기기 모드에서 누르기, 업무 링크가 있는 제목의 머리 줄 구성을 본다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 확인 모드의 알림 Button | hotkey 를 떼고 번호 글자를 직접 그린다 | 작성자 | 같은 hotkey 가 둘이면 그린 순서에 기대게 된다 |
| DECISION2 | 번호를 누른 뒤 | 모드를 끈다 | 작성자 | 알림 `x` 의 넘기기와 같다 |
| DECISION3 | Esc | 확인 모드면 창을 닫지 않고 모드만 끈다 | 작성자 | 스펙 REQ1 의 인수 조건 |
| DECISION4 | 넘기기 모드의 항목 클릭 | 아무것도 하지 않는다 | 작성자 | 넘기기 모드의 누르기는 알림을 넘기는 뜻이다 |
| DECISION5 | 업무 링크가 있는 제목 | 링크 앞 글까지만 Button 에 넣는다 | 작성자 | Button 은 Link 자식을 받지 않고, 링크는 따로 눌려야 한다 |
