# Phase 01. c 번호 모드와 항목 확인 요청문

**Execution profile**: standard

## 목표

`/board` 창에서 `c` 를 누르면 진행 중·대기 항목 앞에 `1`~`9` 번호가 뜨고, 번호를 누르면 그 항목의 상태 확인 요청문이 입력란에 채워진다.

**범위 외**: 클릭으로 고르기, 완료 항목, 요청문 자동 전송. 알림 `x` 넘기기의 동작은 바꾸지 않는다.

## 컨텍스트

- 요구사항은 `docs/features/board-item-check/spec.md` 의 REQ1~REQ4 다.
- 번호 모드는 `work-board/hooks/register.js` 의 `dismissMode`(알림 `x`) 와 같은 방식이다. 모듈 변수 하나, 단축키 상자의 토글 Button, 숫자 Button 의 `onPress` 분기로 되어 있다.
- 요청문은 `replyPrompt(item)` 처럼 export 한 순수 함수로 두어 `work-board/tests/*.spec.ts` 가 직접 부른다.
- Claude Code 2.1.316 의 Button 은 같은 hotkey 가 둘이면 뒤에 그린 것이 이긴다. 그래서 확인 모드 동안 알림 Button 은 hotkey 를 떼고 같은 번호 글자(`1: `)를 직접 그린다.
- 창은 `closeOnEscape: true` 로 열린다. Esc 는 `ui.close`(origin `person`) 로 온다. 확인 모드면 훅이 `next` 없이 답해 창을 닫지 않고 모드만 끈다.

**근거 문서**: `docs/features/board-item-check/design.md`, `work-board/README.md` 의 「단축키 상자」, 「업무 알림」 의 넘기기 항목

## 의도 메모

- 숫자 단축키를 알림과 항목이 함께 쓰므로 두 모드(`x`, `c`)는 동시에 켜지지 않는다. 하나를 켜면 다른 하나를 끈다.
- 번호를 눌러 요청문을 채우면 `x` 처럼 모드를 끈다.
- 항목 제목에는 Link 가 있어 Button 의 자식으로 넣을 수 없다. 번호 Button 은 제목 앞의 표시(▶, ◇) 자리에 둔다.

## 작업 항목

### 1. `work-board/hooks/register.js`

- `CHECK_PROMPT` 상수: REQ3 문장과 보드 반영·보고 지시.
- `checkTargets(items)`: doing 다음 wait, 파일 순서, 앞 9개.
- `checkPrompt(item, worker, prs)`: 항목 id, 제목, 끝나지 않은 단계, worker, PR 번호와 `CHECK_PROMPT`.
- 모듈 변수 `checkMode`. `c` Button(`item-check`)은 대상이 있을 때만 보인다. 대상이 없어지면 모드를 끈다.
- 확인 모드면 대상 항목의 머리 표시를 hotkey Button(`check-<id>`)으로 그리고, 단축키 상자에 안내 줄을 붙인다.
- `ui.close` 훅: 확인 모드에서 사람이 닫으면 모드만 끈다. `/board` 를 다시 열면 모드를 끈다.

### 2. 테스트

- `work-board/tests/check.spec.ts`: `checkTargets`, `checkPrompt` 의 내용(REQ2, REQ3).
- `work-board/tests/pane.test.ts`: `c` 진입과 해제(다시 `c`, Esc), 번호별 요청문, 대상 없음일 때 `c` 숨김, 알림 번호가 바뀌지 않고 겹치지 않음.

## 검증

```bash
node --test --test-concurrency=4 "work-board/tests/*.spec.ts"
test -f work-board/tests/pane.test.ts && claude plugin test .
python3 korean-check/scripts/korean-style-check.py work-board/README.md work-board/CHANGELOG.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `work-board/hooks/register.js` | 수정 |
| `work-board/tests/check.spec.ts` | 신규 |
| `work-board/tests/pane.test.ts` | 수정 |
| `work-board/README.md` | 수정 |
| `work-board/CHANGELOG.md` | 수정 |
