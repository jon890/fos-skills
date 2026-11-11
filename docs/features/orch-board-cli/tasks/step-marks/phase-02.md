# Phase 02. orch board step 에 auto|ask|wait|plain 을 더하고 안내를 바꾼다

**Execution profile**: standard

## 목표

`orch board step <항목> <번호> auto|ask|wait ["<조건>"]|plain` 이 `board.ts step-mark` 를 불러 한 줄 `BOARD-STEP <항목> <번호> <동작>` 을 낸다. 임시 길(`step … text`)로 표시를 바꾸라던 문서를 새 동작으로 바꾸고, 설계의 PR5 절을 구현에 맞춘다.

**범위 외**: `board.ts` 의 동작(phase 01), 표시 문법, 자동 진행 확인 명령(`auto-check`).

## 컨텍스트

**요구사항**: REQ10

**근거 문서**: `docs/features/orch-board-cli/spec.md`, `docs/features/orch-board-cli/design.md`, `docs/features/board-auto-advance/design.md`(「보드 명령 설계와 맞출 것」 표의 1번과 4번 행)

- `skills/orch/scripts/board/board-edit.ts` 의 `main` 이 동작 이름을 `board.ts` 명령으로 바꾼다. 지금 `step` 은 `text`, `done`, `undo` 만 알고 나머지는 `usage()`(종료 코드 2)다. 사용법 오류의 꼴과 출력 규칙은 그대로 지킨다.
- `skills/orch/tests/board-edit.spec.ts` 의 「도움말과 명령 표가 새 명령을 보이고 사용법 오류는 2 다」 테스트가 `['step','x','9','auto'|'ask'|'wait'|'plain']` 을 사용법 오류로 단언한다. 이 동작이 바뀌므로 그 네 호출을 목록에서 빼고 새 테스트로 옮긴다.
- 한 줄 출력과 `text` 가 사건 꼬리표 제거를 거절하는 규칙은 바꾸지 않는다.

## 의도 메모

- `wait` 의 조건은 `step <항목> <번호> wait "<조건>"` 의 다섯째 위치 인자다. 조건을 `auto`, `ask`, `plain` 에 주거나 `--on` 과 함께 쓰면 사용법 오류다(종료 코드 2).
- `BOARD-STEP` 출력의 동작 자리에는 조건 없이 `wait` 만 쓴다. 조건 글을 한 줄 출력에 싣지 않는다(토큰 절약과 한 줄 꼴 유지). `--full` 이 바뀐 줄을 보인다.
- 설계 문서의 「PR5 는 그 모듈에 함수 하나를 더한다」 는 틀렸다. `withStepMark` 가 #446 에서 이미 들어왔다. 설계를 같은 커밋에서 고친다.

## 작업 항목

### 1. `skills/orch/scripts/board/board-edit.ts`

- `USAGE` 와 머리 주석에 `orch board step <항목> <번호> auto|ask|plain` 과 `... wait ["<조건>"]` 를 더한다.
- `main`: `verb === 'step'` 이고 번호가 숫자일 때 `action` 이 `auto|ask|plain` 이면 인자 수 4 이고 `--on` 없음, `wait` 이면 인자 수 4 또는 5 이고 `--on` 없음일 때 `['step-mark', id, third, action, ...(조건 있으면 [조건])]` 를 만든다. 그 밖은 지금처럼 `usage()`.
- 출력 줄 만들기(`heading`)는 지금 `BOARD-STEP ${id} ${number} ${action}` 꼴을 그대로 쓴다. `was`/`status` 비교는 그대로 둔다.

### 2. `skills/orch/scripts/lib/commands.ts`

- board 묶음 `step` 행의 인자 설명을 `<항목> <번호> done|undo|text [글] [--on 사건]` 에서 `done|undo|text [글] [--on 사건]|auto|ask|plain|wait [조건]` 로 넓힌다. `lib-commands.spec.ts` 와 docs 계약 테스트가 이 문자열을 대조하면 같이 맞춘다.

### 3. `skills/orch/tests/board-edit.spec.ts`

- 사용법 오류 목록에서 `auto`, `ask`, `wait`, `plain` 네 호출을 뺀다. 대신 사용법 오류 사례를 더한다: `step x 2 auto "조건"`, `step x 2 ask --on "1 merge"`, `step x 2 Auto`, `step x 2 wait a b`.
- 새 테스트(번호 뒤 표시 바꾸기는 성공, 거절은 따로 적는다): 스펙 인수 조건의 `2. [auto] PR4 API (계획: x)` 에 `ask` 를 부르면 `BOARD-STEP x 2 ask` 한 줄이고 보드의 그 줄이 `2. [ask] PR4 API (계획: x)` 다. `wait "2026-11-10 19:00"` 와 `plain` 도 성공이다. 끝난 줄(`done: true`)과 줄 끝 `(#665 merge)` 꼬리표 줄을 준비해 끝냄 상태와 꼬리표가 남는지 본다. `[merge]` 줄에 `auto`, 빈 조건, `]` 가 든 조건은 종료 코드 1 이고 보드 바이트가 그대로다. 워크트리에서 부르면 주 checkout 의 보드가 바뀐다(`board-edit.spec.ts` 의 기존 워크트리 사례를 따른다).

### 4. 문서

- `skills/orch/references/board.md`: 「상태와 단계 고치기」 의 명령 목록에 두 줄을 더하고 설명 한 문단(번호 뒤 표시만 바꾼다, 사건 단계는 거절한다, 줄 끝 꼬리표는 남는다)을 더한다. `--on` 설명 끝의 「자동 진행 표시만 바꾸려면 `text` 로 줄 전체를 바꾼다」 는 새 동작 안내로 바꾼다. 「자동 진행 표시」 절 끝의 「표시를 바꾸는 명령과 …」 문장은 그대로 둔다.
- `skills/orch/references/replying.md`: 「표시를 바꾸려면 …text …」 문장을 `orch board step <항목> <번호> ask` 같은 전용 동작으로 바꾸고, 꼬리표를 새 글에 넣으라는 말은 뺀다(꼬리표는 그대로 남는다). `[ask]` 를 허락받아 띄운 뒤 표시를 지우는 일은 `plain` 이다.
- `docs/features/orch-board-cli/design.md`: 「자동 진행 표시 동작이 기다리는 방법 (PR5)」 절을 구현이 정한 대로 고친다(표시를 읽는 코드는 #446 의 `step-marks.js` 에 있다, 함수를 더하지 않는다, 조건은 위치 인자, 거절 규칙). 요구사항 연결의 REQ10 행, 「뒤 기능이 기대는 자리」 의 「표시 바꾸기」 행, 「PR 나누기와 순서」 PR5 행, DECISION14 를 맞춘다. 「board.ts 에 더하는 것」 표에 `step-mark` 행을 더한다.
- `docs/features/board-auto-advance/design.md`: 「보드 명령 설계와 맞출 것」 표 4번 행의 「PR5 가 그 문장을 전용 동작으로 바꾼다」 를 바뀐 사실로 고친다.
- `extensions/work-board/references/behavior.md`: 결과 JSON 을 내는 명령 목록에 `step-mark` 를 더하고 「단계 표시 바꾸기」 항목을 더한다.
- `docs/features/orch-board-cli/design.md` 의 「새 명령 (PR3)」 절도 명령 블록, 대응 표, 사용법 오류 목록에 새 동작을 더한다. `board-auto-advance/design.md` 표의 1번 행도 PR5 가 끝났음에 맞춘다.
- `extensions/work-board/README.md` 의 보드 명령 예시 근처에 표시 바꾸기 한 줄을 더한다.
- 변경 이력 조각: `skills/orch/changes/board-step-marks.minor.md`, `extensions/work-board/changes/board-step-marks.minor.md`.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-edit.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/docs-contract.spec.ts extensions/work-board/tests/board-step-mark.spec.ts
node scripts/check-skill-docs.ts
node export-only-skills/korean-check/scripts/check.ts docs/features/orch-board-cli/design.md docs/features/board-auto-advance/design.md skills/orch/references/board.md skills/orch/references/replying.md extensions/work-board/README.md extensions/work-board/references/behavior.md skills/orch/changes/board-step-marks.minor.md extensions/work-board/changes/board-step-marks.minor.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/board/board-edit.ts` | 수정 (표시 동작) |
| `skills/orch/scripts/lib/commands.ts` | 수정 (step 행 설명) |
| `skills/orch/tests/board-edit.spec.ts` | 수정 (사용법 오류 목록과 새 테스트) |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
| `docs/features/orch-board-cli/design.md` | 수정 |
| `docs/features/board-auto-advance/design.md` | 수정 |
| `extensions/work-board/references/behavior.md` | 수정 |
| `extensions/work-board/README.md` | 수정 |
| `skills/orch/changes/board-step-marks.minor.md` | 신규 |
| `extensions/work-board/changes/board-step-marks.minor.md` | 신규 |
