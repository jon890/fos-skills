# Phase 01. board.ts 에 step-mark 동작을 더한다

**Execution profile**: standard

## 목표

`board.ts step-mark <id> <번호> <auto|ask|wait|plain> [<조건>]` 이 그 줄 번호 뒤의 자동 진행 표시만 바꾼다. 번호 풀이, 잠금, 결과 JSON 은 `step-edit` 의 것을 그대로 쓴다.

**범위 외**: `orch board step` 명령(phase 02), 표시 문법(이미 `extensions/work-board/hooks/step-marks.js` 가 소유한다. 새 함수를 더하지 않는다).

## 컨텍스트

**요구사항**: REQ10

**근거 문서**: `docs/features/orch-board-cli/spec.md`(REQ10, DECISION6), `docs/features/orch-board-cli/design.md`(「자동 진행 표시 동작이 기다리는 방법」, DECISION14, DECISION21)

- 표시를 바꾼 글을 만드는 `withStepMark(text, mark, condition)` 이 `hooks/step-marks.js` 에 이미 있다. 모르는 표시, 단계가 아닌 글, `wait` 가 아닌 표시의 조건, 조건의 `]` 와 줄바꿈이면 `null` 이다. 번호 뒤 앞 완료 표시(`✓`)와 줄 끝 사건 꼬리표는 본문으로 보존한다.
- `board.ts` 의 `apply` 안 `step-edit` 분기(`findStep` 으로 줄을 고르고 `lines[index]` 를 새 `{text, done}` 으로 바꾸고 `itemView` 를 돌려준다)가 따를 패턴이다.
- 사건 단계의 두 모양: 줄 글의 줄 앞 꼬리표(`stageTag(text)`), 항목 `stages` 칸(`pr=1,merge=2` 꼴, `STAGES` 정규식)이 가리키는 번호. 둘 다 거절한다. 줄 끝 꼬리표(`(#N 사건)`)만 있는 줄은 받는다.

## 의도 메모

- `[merge]` 줄에 `[auto]` 를 붙이면 `2. [auto] [merge] 머지` 가 되어 줄 앞 사건 꼬리표가 밀려나 사건 단계로 읽히지 않고 그 줄이 사건에 저절로 끝나지 않는다. 그래서 조용히 받지 않고 거절한다.
- 같은 표시로 바꾸는 호출은 거절하지 않고 성공으로 둔다. 표시가 같으면 결과도 같다(번호 뒤 공백만 하나로 정규화된다).
- 번호 형식과 모르는 표시는 `parse` 에서 `Error` 로 던져 종료 코드 2 다. `withStepMark` 가 `null` 을 돌려주는 경우는 `Refused`(종료 코드 1)이고 `wait` 이면 조건을, 아니면 알 수 없는 표시가 겹친 줄임을 이유로 알린다.
- 끝난 줄과 `done` 항목의 줄도 표시는 바꿀 수 있다(스펙이 막지 않는다). 칸 옵션(`--title` 등)은 지금 `step-edit` 처럼 조용히 무시한다.
- 조건은 위치 인자로 받는다(`board.ts step-mark x 4 wait "2026-11-10 19:00"`). 새 옵션을 만들지 않아 지금 옵션의 줄임 꼴이 모호해지지 않는다.

## 작업 항목

### 1. `extensions/work-board/bin/board.ts`

- `COMMANDS` 와 `USAGE`, `HELP` 에 `step-mark` 를 더한다. HELP 에 한 줄 설명(「번호 뒤 표시만 바꾼다. 사건 단계는 거절한다」)과 머리 주석 사용 줄을 더한다.
- `parse`: 위치 인자 한도를 `step-mark` 는 5(`cmd id 번호 표시 조건`)로 둔다. 표시가 `auto|ask|wait|plain` 이 아니거나, 조건을 `wait` 가 아닌 표시에 주면 `Error` 로 던져 종료 코드 2 가 되게 한다. `--exact`, `--if-rev`, `--event` 는 `step-mark` 에 쓰면 지금처럼 사용법 오류다(`--event` 줄은 `['step-edit','step-add']` 만 허용하는 지금 검사 그대로).
- `Args` 에 `condition?: string` 을 더하고 `parse` 가 채운다.
- `apply` 에 `step-mark` 분기: 항목 없음 거절, 번호 형식 검사, `findStep` 으로 줄 선택(없는 번호와 같은 번호 둘은 기존 거절 그대로), 사건 단계 거절(`stageTag(old.text)` 이거나 `item.stages` 의 번호들에 그 번호가 있으면 `Refused("<번호> 번 줄은 사건 단계라 표시를 바꾸지 않는다: <id>")`), `withStepMark(old.text, mark==='plain'?null:mark, 조건)`, 결과가 `null` 이면 이유를 알리는 `Refused`(조건이 비었거나 `]`·줄바꿈 포함, 단계 줄이 아님), 성공이면 `lines[index] = { text, done: old.done }` 와 `itemView(item, was, number)`.
- `stages` 값에서 번호를 읽는 작은 함수를 `board.ts` 안에 둔다(orch 의 `stagesOf` 를 import 하지 않는다. `board.ts` 는 orch 를 import 하지 않는다).
- 머리 주석의 사용 목록에 `step-mark` 줄을 더한다.

### 2. `extensions/work-board/tests/board-step-mark.spec.ts`(신규)

`board-step-edit.spec.ts` 의 실행 방식을 따라 임시 보드로 `board.ts` 를 실행한다.

- 정상: `2. [auto] PR4 API (계획: x)` 에 `ask` → `2. [ask] PR4 API (계획: x)`, 끝냄 상태와 다른 줄과 `stepAt` 외 다른 칸이 그대로, 결과 JSON 의 `number`. `wait` 조건 있음과 없음, `plain` 으로 지움, 표시가 없던 줄에 `auto`, 같은 표시로 바꾸기.
- 보존: 끝난 줄(`done: true`)이 끝난 채 남는다. 줄 끝 `(#665 merge)` 꼬리표 줄에 `ask`, `plain` 을 해도 꼬리표가 남는다. next 에만 단계가 있는 항목.
- 거절(보드 바이트 그대로, 종료 코드 1): 없는 번호(`있는 번호` 안내), 같은 번호 둘, 줄 앞 `[merge]` 줄, `stages` 번호가 가리키는 줄, 항목 없음, 조건이 비었거나 `]` 포함.
- 사용법 오류(종료 코드 2): `Auto` 같은 모르는 표시, `auto` 에 조건, 번호가 숫자가 아님.

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/board-step-mark.spec.ts extensions/work-board/tests/board-step-edit.spec.ts extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/step-marks.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/board.ts` | 수정 (step-mark 동작) |
| `extensions/work-board/tests/board-step-mark.spec.ts` | 신규 |
