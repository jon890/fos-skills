# Phase 01. 단계 줄의 자동 진행 표시를 읽고 쓰는 모듈

**Execution profile**: standard

## 목표

보드 단계 줄의 번호 뒤에 붙는 `[auto]`, `[ask]`, `[wait]`, `[wait: <조건>]` 을 읽고 바꾸는 함수를 한 파일에 둔다. 뒤 phase 의 확인 명령과 다음 PR 의 루프, 보드 명령의 표시 전용 동작이 모두 이 파일을 쓴다.

**범위 외**: 이 모듈을 부르는 코드(phase 04 부터). 시각 조건을 읽는 `waitTimeMs` 는 쓰는 곳이 시각 wait 뿐이라 다음 PR 이 더한다. 보드 도구(`extensions/work-board/bin/board.ts`)와 보드 창(`hooks/register.js`)은 고치지 않는다. 창은 표시 글을 그대로 보인다(스펙 「범위 밖」).

## 컨텍스트

- 단계 줄은 번호로 시작하는 줄이다. 판정 정규식 `STEP` 은 `extensions/work-board/hooks/event-tags.js` 가 내보낸다(`/^\s*(?:(✓|\[[xX ]\]|▶|◇)\s*)?(\d+)[.)]?\s/`). 줄 앞에 옛 완료 표시(`✓`, `[x]`, `[X]`, `[ ]`, `▶`, `◇`)가 붙을 수 있다.
- 같은 파일의 `parseEventTag` 는 줄 끝 `(#665 merge)` 꼴 사건 꼬리표를 읽는다. 표시는 번호 뒤 맨 앞, 사건 꼬리표는 줄 끝이라 한 줄에 함께 쓸 수 있다.
- 새 파일은 `event-tags.js` 와 같은 폴더, 같은 꼴(주석 한 줄 머리, `export function`)로 쓴다. 폴더의 다른 파일처럼 JS 로 쓰고 타입 선언 파일은 두지 않는다.
- work-board 테스트는 `extensions/work-board/tests/*.spec.ts` 이고 `node:test` 와 `node:assert/strict` 를 쓴다. 꼴은 `extensions/work-board/tests/event-tags.spec.ts` 를 따른다. 이 폴더는 `tsconfig.json` 의 `exclude` 에 있어 tsc 가 보지 않는다. 테스트가 실행으로 확인한다.

**요구사항**: REQ1, REQ10

**근거 문서**: `docs/features/board-auto-advance/spec.md`, `docs/features/board-auto-advance/design.md` 「표시의 꼴은 한 파일이 소유한다」

## 의도 메모

- 표시 정규식을 orch 의 `core/` 에 두는 안은 기각했다. `core/` 는 폴더 밖 파일을 가져올 수 없어(`skills/orch/tests/core-boundary.spec.ts`) `STEP` 을 한 벌 더 두게 된다.
- 모르는 표시는 오류가 아니라 「표시 없음」 이다. 표시 없는 옛 줄의 동작을 바꾸지 않는 것이 스펙 REQ10 이다.
- `[auto]` 뒤에 공백 없이 글이 붙은 줄(`2. [auto]PR4`)은 표시로 읽지 않는다. 번호 뒤 공백 없는 줄을 단계로 보지 않는 `STEP` 규칙과 같은 엄격함이다.
- `withStepMark` 는 이 PR 에서 부르는 코드가 없다. 보드 명령의 표시 전용 동작(`docs/features/orch-board-cli/spec.md` REQ10)이 부른다. 읽는 규칙과 쓰는 규칙을 한 파일에서 함께 테스트하려고 여기서 만든다.

## 작업 항목

### 1. `extensions/work-board/hooks/step-marks.js` 신규

`STEP` 을 `./event-tags.js` 에서 가져온다. 아래 둘을 내보낸다.

- `parseStepMark(text)`
  - `text` 가 문자열이 아니거나 `STEP` 에 맞지 않으면 `null`.
  - 맞으면 `{ number, mark, condition, body }`. `number` 는 `STEP` 의 둘째 묶음을 수로 바꾼 값이다. `STEP` 이 맞은 부분 뒤의 글에서 앞 공백을 뗀 것이 「나머지」 다.
  - 나머지가 `[auto]`, `[ask]`, `[wait]` 로 시작하고 그 뒤가 공백이거나 줄 끝이면 `mark` 는 `'auto'`, `'ask'`, `'wait'`, `condition` 은 `null` 이다.
  - 나머지가 `[wait: <글>]` 로 시작하고 `<글>` 의 앞뒤 공백을 뗀 것이 비지 않았으며 그 뒤가 공백이거나 줄 끝이면 `mark` 는 `'wait'`, `condition` 은 그 글이다.
  - 그 밖(`[Auto]`, `[maybe]`, `[auto: x]`, `[wait:]`, `[merge]`, 표시 없음)은 `mark` 와 `condition` 이 `null` 이다.
  - `body` 는 표시를 뗀 나머지 글이다(앞 공백을 뗀다). 표시가 없으면 나머지 전체다. 줄 끝 사건 꼬리표는 `body` 에 남긴다.
- `withStepMark(text, mark, condition = null)`
  - 단계 줄이 아니면 `null`.
  - `mark` 가 `'auto'`, `'ask'`, `'wait'`, `null` 이 아니면 `null`. `condition` 은 `mark` 가 `'wait'` 일 때만 받고, `]` 나 줄바꿈이 들었으면 `null`.
  - `STEP` 이 맞은 앞부분(옛 완료 표시와 번호)은 그대로 두고, 그 뒤에 새 표시와 공백 하나, `parseStepMark(text).body` 를 잇는다. `mark` 가 `null` 이면 표시 없이 `body` 를 잇는다.
  - 결과는 `parseStepMark` 로 다시 읽었을 때 `mark`, `condition`, `body` 가 준 값과 같아야 한다.

### 2. 이 phase 를 검증하는 `extensions/work-board/tests/step-marks.spec.ts` 신규

- 표시 넷을 읽는다: `2. [auto] PR4 (계획: a)`, `3) [ask] real 활성화`, `4 [wait] 기획 답`, `5. [wait: 2026-11-10 19:00] 회차`. `number`, `mark`, `condition`, `body` 를 모두 단언한다.
- 줄 끝 사건 꼬리표와 함께 쓴 줄 `5. [wait] 기획 답 (#665 merge)` 은 `mark` 가 `'wait'` 이고 `parseEventTag` 도 `{ pr: '665', event: 'merge' }` 를 낸다.
- 옛 완료 표시가 붙은 줄 `✓ 2. [auto] PR4` 를 읽는다.
- 표시 없음으로 읽는 줄: `2. PR4`, `2. [maybe] PR4`, `2. [Auto] PR4`, `2. [auto: x] PR4`, `2. [wait:] x`, `2. [auto]PR4`, `2. [merge] 머지`. 모두 `mark` 가 `null` 이고 `body` 는 번호 뒤 글 전체다.
- 단계 줄이 아닌 것: `참고: [auto] 글`, `9.머지`, 숫자 `3`. `parseStepMark` 와 `withStepMark` 가 `null` 이다.
- `withStepMark`: `2. [auto] PR4 (계획: a)` 를 `'ask'` 로 바꾸면 `2. [ask] PR4 (계획: a)`, `null` 로 바꾸면 `2. PR4 (계획: a)`, 표시 없는 `2. PR4` 에 `'wait'` 와 `2026-11-10 19:00` 을 주면 `2. [wait: 2026-11-10 19:00] PR4`. `✓ 2. PR4` 는 앞 표시가 남는다. 모르는 표시 `'maybe'` 와 `]` 가 든 조건은 `null`.

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/step-marks.spec.ts extensions/work-board/tests/event-tags.spec.ts
```

종료 코드 0 이어야 한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/hooks/step-marks.js` | 신규 |
| `extensions/work-board/tests/step-marks.spec.ts` | 신규 |
