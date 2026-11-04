# Phase 02. 대기의 메시지별 분류 줄과 원문 파일

**Execution profile**: deep

## 목표

짧은 출력의 `orch wait` 이 받은 메시지마다 판정 줄 하나를 `triage-messages` 와 같은 차례로 내고, 원문을 파일로 남겨 `RAW <파일>` 과 `LAST_DELIVERY` 로 끝나게 한다. `orch wait triage` 의 짧은 출력이 같은 줄을 낸다.

**범위 외**: 다른 명령의 규칙표(phase 03-05), `references/waiting.md`(phase 06).

## 컨텍스트

**요구사항**: REQ4, REQ11

**근거 문서**: `docs/features/orch-cli/spec.md` 의 REQ11, DECISION21. `docs/features/orch-cli/design.md` 의 「짧은 출력 (PR2)」 표의 `wait`, `wait triage` 행, 「저장 파일」, 「검증 전략」 의 REQ11.

- `skills/orch/scripts/wait-important.ts` 의 `main` 끝 부분이 처리할 묶음을 받으면 `verifyCompletion` 으로 분류한 뒤 `out(pyJson(data))`, 의심 설명 줄, `LAST_DELIVERY` 를 낸다. waiter_exists 는 `out(checked.raw)` 다.
- `skills/orch/scripts/triage-messages.ts` 의 `triage(messages, since, contract, stopReports)` 가 차례(`PRIORITY`)와 묶음을 정한다. 분류 결과가 이미 붙은 메시지는 `lib/completion.ts` 의 `classify` 가 그대로 둔다(그 머리 주석의 `completionVerification`).
- `context(message)` 가 메시지의 `[task, dispatch]` 를 낸다(`lib/completion.ts`).
- 원문 파일 자리는 `pathOf('state', cwd)` 아래 `wait/<delivery>.json` 이다(`cwd` 는 `main` 의 시작 폴더 주 checkout, `--lost-state` 기본값과 같은 기준).

## 의도 메모

- 대기가 분류 함수를 다시 구현하지 않는다. `triage-messages.ts` 가 `triage` 와 줄 만들기(`shortLines`)를 export 하고 대기가 가져다 쓴다. `triage-messages.ts` 는 이미 `import.meta.main` 일 때만 `main` 을 부른다.
- 같은 시점의 분류다(설계 「검증 전략」). 원문 파일에는 완료 판정을 붙인 결과를 쓴다. 나중에 `orch wait triage` 로 읽어도 붙은 판정을 그대로 쓴다.
- `--full` 대기는 지금처럼 stdout 에 원문을 내므로 파일을 쓰지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/triage-messages.ts`

- `triage` 를 export 하고 옵션에 `repo`(리뷰 dispatch 판정 저장소, 기본 작업 폴더의 주 checkout)를 더한다.
- `export function shortLines(deliveries: string[], result: Triage, opts: { last?: boolean } = {}): string[]` — 묶음 차례대로 메시지마다 `<종류> <dispatch 또는 -> <task 또는 -> <본문 앞 120자>`. 종류는 `suspicious_worker_done`→`DONE-SUSPECT`, `worker_done`→`DONE`, `stopped_worker`→`STOPPED`, 그 밖은 type 을 대문자로 하고 `_` 를 `-` 로(`escalation`→`ESCALATION`). 본문은 `body` 가 비면 `subject` 이고 `lib/output.ts` 의 `oneLine(…, 120)`. 이어서 heartbeat 합이 0 보다 크면 `HEARTBEAT <합>`, 턴만 끝낸 멈춤 보고 합이 0 보다 크면 `QUIET-STOP <합>`. `opts.last` 가 거짓이면(파일 분류) delivery 가 있으면 `DELIVERY <id …>`, 메시지·heartbeat·멈춤 보고가 모두 없으면 `NO-MESSAGES`.
- `main` 은 `--json` 이 아니고 `short()` 면 `render` 대신 `shortLines` 를 낸다.

### 2. `skills/orch/scripts/wait-important.ts`

- 처리할 묶음 분기에서 `short()` 면: 원문 줄(`pyJson(data)`)을 `<state>/wait/<delivery>.json` 에 쓰고(폴더를 만든다. 쓰지 못하면 stderr 한 줄과 `RAW -`), `triage(messages, null, contract, stopReports, { repo: loopRepos[0] ?? cwd })` 의 결과로 `shortLines(…, { last: true })` 를 내고 `RAW <파일>`, `LAST_DELIVERY <id>` 를 낸다. 의심 설명 줄은 내지 않는다. 종료 코드는 그대로다(6 포함).
- `--ack <id>` 로 건 check 가 성공하면(`ack = null` 자리) `<state>/wait/<id>.json` 을 지운다. 없으면 넘어간다.
- 시작할 때 `<state>/wait/` 에서 수정 시각이 7일 지난 `.json` 을 지운다. 실패는 무시한다.
- waiter_exists 는 짧은 출력이면 원문 JSON 대신 `WAITER-EXISTS <Run>` 을 낸다. 그 밖의 check 실패는 짧은 출력이면 원문 JSON 을 내지 않는다(`WATCH-ERROR` 가 이유를 낸다).
- `reportLost` 의 `adoptHint` 줄과 `WORKER_LOST`, `ACK_LOST`, `TIMEOUT`, `LOOP-*`, `WATCH-ERROR` 는 그대로다. 위 분기 밖의 `out` 은 바꾸지 않는다.
- 머리 주석 「출력」 에 짧은 출력과 원문 파일을 적는다.

### 3. `skills/orch/scripts/orch-doctor.ts` 의 `WAIT-READER`

`OLD-CALL`, `DIRECT-PATH` 와 같은 저장소 파일 목록(`callFiles`) 가운데 Markdown 과 JSON 이 아닌 파일(저장소 스크립트)에서 `LAST_DELIVERY` 를 읽는 줄(`orch-compat` 표지가 없고 `OLD-CALL`, `DIRECT-PATH` 가 걸리지 않은 줄)마다 `WAIT-READER <파일>:<줄>` 과 고칠 줄 `  고칠 것: orch wait 의 짧은 출력이 메시지마다 판정 줄을 낸다. 원문 JSON 이 필요하면 RAW 파일을 orch wait triage --full 로 읽는다` 를 낸다. 머리 주석 「출력」 과 종료 코드 설명(경고라 바꾸지 않는다)에 더한다.

### 4. `docs/data-schema.md`

「orch 루트에 더하는 파일」 표에 `state/wait/<delivery>.json` 행을 더한다(설계 「저장 파일」 의 내용).

### 5. 테스트

- `skills/orch/tests/triage-messages.spec.ts`: worker_done, 의심 worker_done, escalation, question, heartbeat 가 섞인 파일을 `ORCH_OUTPUT=short` 로 읽으면 `DONE-SUSPECT`, `DONE`, `ESCALATION`, `QUESTION` 차례 줄과 `HEARTBEAT`, `DELIVERY` 를 낸다. 신호가 없으면 지금 출력과 같다. 빈 입력 결과는 `NO-MESSAGES`.
- `skills/orch/tests/wait-important.spec.ts`: 가짜 orca 로 처리할 묶음(완료 근거 있는 worker_done, escalation, question, heartbeat)을 받는 대기를 `ORCH_OUTPUT=short` 로 돌리면 메시지 줄 차례가 같은 묶음의 `triage-messages` 짧은 출력과 같고, `RAW <파일>` 의 파일을 `triage-messages` 로 읽은 짧은 줄이 대기의 메시지 줄과 같으며, 마지막 줄이 `LAST_DELIVERY`. 다음 대기를 `--ack` 로 걸면 그 파일이 지워진다. 신호가 없으면 지금처럼 JSON 한 줄이다. waiter_exists 가 짧은 출력에서 `WAITER-EXISTS` 다.
- `skills/orch/tests/orch-doctor.spec.ts`: 임시 저장소 `.orch/bin/summary.py` 에 `LAST_DELIVERY` 를 읽는 줄이 있으면 `WAIT-READER .orch/bin/summary.py:<줄>` 과 고칠 줄, `orch-compat` 표지가 있으면 없다.

## 검증

```bash
node --test skills/orch/tests/triage-messages.spec.ts skills/orch/tests/wait-important.spec.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/completion.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/triage-messages.ts` | 수정 |
| `skills/orch/scripts/wait-important.ts` | 수정 |
| `skills/orch/scripts/orch-doctor.ts` | 수정 |
| `docs/data-schema.md` | 수정 |
| `skills/orch/tests/triage-messages.spec.ts` | 수정 |
| `skills/orch/tests/wait-important.spec.ts` | 수정 |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 |
